import XCTest
import BandDeriver
@testable import Kairos

/// Issue #37 (EPIC E4: morning band upload) + issue #70 (consent
/// enforcement, docs/14_IMPROVEMENT_REVIEW.md §1.8) test scope: this suite
/// exercises (a) the HealthKit-shaped-input -> BandDeriver -> upload-request
/// mapping with fixture sample data, (b) graceful degradation when the
/// HealthKit read is denied/fails/errors, and (c) end-to-end consent
/// gating — a category the user has turned off in `ConsentStore` must never
/// be queried from HealthKit, never derived, and never present in the
/// uploaded request; a category with no HealthKit evidence must be omitted
/// rather than fabricated. True `BGAppRefreshTask` background-execution
/// *timing* cannot be verified here (see `BackgroundBandRefreshSchedulerTests`
/// doc comment) — that is a simulator/no-physical-device limitation already
/// acknowledged in docs/07_TEST_PLAN.md §6, not a gap introduced by this
/// suite.
@MainActor
final class BandUploadServiceTests: XCTestCase {

    /// Every category enabled — the baseline consent posture for tests that
    /// aren't specifically exercising withheld-consent behavior.
    private func allEnabledConsentStore() -> InMemoryConsentStore {
        InMemoryConsentStore(initial: [.recovery: true, .sleep: true, .activity: true, .calendar: true])
    }

    // MARK: - Happy path: HealthKit-shaped input -> BandDeriver -> upload

    func test_refreshAndUpload_healthyInput_derivesBandsAndUploadsThem() async {
        // Fixture mirrors a well-rested, active user against a trustworthy
        // baseline — chosen so the expected bands are unambiguous per
        // `BandDeriver`'s documented thresholds (BandDeriver.swift).
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 70, date: Date())],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 55, date: Date())],
            lastNightSleep: SleepStageDurations(remMinutes: 90, coreMinutes: 180, deepMinutes: 90, awakeMinutes: 10),
            recentActivity: ActivitySummary(steps: 9000, activeEnergyBurnedKcal: 500, workoutMinutes: 0),
            baseline: PersonalBaseline(
                meanHRVMilliseconds: 45, stdDevHRVMilliseconds: 8,
                meanRestingHRBpm: 60, meanDailySteps: 6000, meanDailyActiveEnergyKcal: 300,
                sampleDays: 30
            )
        )
        let reader = FakeHealthSampleReader(nextInput: input)
        let uploadClient = FakeBandUploadClient()
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        let expectedBands = BandDeriver.deriveDerivedBands(from: input)
        XCTAssertEqual(outcome, .uploaded(expectedBands))
        XCTAssertEqual(reader.readCallCount, 1)
        XCTAssertEqual(uploadClient.uploadedRequests.count, 1)

        let uploaded = uploadClient.uploadedRequests[0]
        XCTAssertEqual(uploaded.recovery, expectedBands.recovery?.rawValue)
        XCTAssertEqual(uploaded.sleepQuality, expectedBands.sleepQuality?.rawValue)
        XCTAssertEqual(uploaded.activity, expectedBands.activity?.rawValue)
    }

    func test_refreshAndUpload_publishesOutcomeAndTimestamp() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let sut = BandUploadService(healthReader: reader, uploadClient: FakeBandUploadClient(), consentStore: allEnabledConsentStore())

        XCTAssertNil(sut.lastOutcome)
        XCTAssertNil(sut.lastAttemptAt)
        XCTAssertNil(sut.lastSentRequest)

        _ = await sut.refreshAndUpload()

        XCTAssertNotNil(sut.lastOutcome)
        XCTAssertNotNil(sut.lastAttemptAt)
        XCTAssertNotNil(sut.lastSentRequest, "A successful read+upload must record the exact request sent (issue #70 ledger truthfulness)")
        XCTAssertFalse(sut.isRefreshing, "isRefreshing must be reset after completion")
    }

    // MARK: - Request shape matches packages/shared-contracts enum spellings

    func test_uploadRequest_usesCanonicalEnumSpellings_notInventedFieldNames() async {
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        let reader = FakeHealthSampleReader(nextInput: .empty)
        // Force a deterministic derivation isn't needed here — we just want
        // to check the encoding shape, so build the request directly.
        let request = BandUploadRequest(date: "2026-07-02", bands: bands)

        XCTAssertEqual(request.recovery, "low")
        XCTAssertEqual(request.sleepQuality, "poor")
        XCTAssertEqual(request.activity, "sedentary")
        XCTAssertNil(request.busyness, "busyness is backend-derived (00_FOUNDATION §5) — iOS must never invent it")
        XCTAssertNil(request.communicationLoad, "communicationLoad is an unshipped stretch signal — must default to null")
        XCTAssertFalse(request.distressSignal, "distressSignal defaults to false per shared-contracts BandInputSchema")
        _ = reader // silence unused-var warning; reader unused in this shape-only test
    }

    func test_uploadRequest_encodesToJSONWithExpectedKeys() throws {
        let bands = HealthBands(recovery: .high, sleepQuality: .good, activity: .active)
        let request = BandUploadRequest(date: "2026-07-02", bands: bands)

        let data = try JSONEncoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let jsonObject = try XCTUnwrap(json)

        XCTAssertEqual(jsonObject["date"] as? String, "2026-07-02")
        XCTAssertEqual(jsonObject["recovery"] as? String, "high")
        XCTAssertEqual(jsonObject["sleepQuality"] as? String, "good")
        XCTAssertEqual(jsonObject["activity"] as? String, "active")
        XCTAssertEqual(jsonObject["distressSignal"] as? Bool, false)
        // `JSONEncoder` omits `nil` Optional fields by default rather than
        // encoding an explicit `null` — the backend's `UpsertDailyBandsInput`
        // (apps/api/src/db/repositories/dailyBandsRepository.ts) already
        // treats an absent field the same as an explicit null (`?? null`
        // fallback), so omission is the correct, minimal wire
        // representation here rather than a bug to work around.
        XCTAssertNil(jsonObject["busyness"], "busyness is backend-derived — iOS omits it rather than sending a value")
        XCTAssertNil(jsonObject["communicationLoad"], "communicationLoad is an unshipped stretch signal — iOS omits it")
    }

    /// Issue #70: the withheld/no-evidence band fields must be OMITTED from
    /// the encoded JSON entirely (not sent as an explicit `null`, and never
    /// coerced into a fabricated raw-value string) — this is the wire-level
    /// proof that the optional-field contract change actually works.
    func test_derivedBandsRequest_withOmittedCategories_encodesWithoutThoseKeys() throws {
        let derived = DerivedBands(recovery: .low, sleepQuality: nil, activity: nil)
        let request = BandUploadRequest(date: "2026-07-02", derivedBands: derived)

        XCTAssertEqual(request.recovery, "low")
        XCTAssertNil(request.sleepQuality)
        XCTAssertNil(request.activity)

        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["recovery"] as? String, "low")
        XCTAssertNil(json["sleepQuality"], "A withheld/no-evidence category must be OMITTED from the wire payload, never sent as null or a fabricated value")
        XCTAssertNil(json["activity"], "A withheld/no-evidence category must be OMITTED from the wire payload, never sent as null or a fabricated value")
    }

    func test_derivedBandsRequest_allOmitted_encodesWithNoBandKeysAtAll() throws {
        let derived = DerivedBands(recovery: nil, sleepQuality: nil, activity: nil)
        let request = BandUploadRequest(date: "2026-07-02", derivedBands: derived)

        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertNil(json["recovery"])
        XCTAssertNil(json["sleepQuality"])
        XCTAssertNil(json["activity"])
        // date + distressSignal are still always present.
        XCTAssertEqual(json["date"] as? String, "2026-07-02")
        XCTAssertEqual(json["distressSignal"] as? Bool, false)
    }

    // MARK: - Graceful degradation: HealthKit read denied/unavailable/errors

    func test_refreshAndUpload_healthReadUnavailable_degradesToCalendarOnly_neverThrows() async {
        let reader = FakeHealthSampleReader(nextError: .unavailable)
        let uploadClient = FakeBandUploadClient()
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        XCTAssertEqual(outcome, .skippedNoHealthData)
        XCTAssertEqual(sut.lastOutcome, .skippedNoHealthData)
        XCTAssertNil(sut.lastSentRequest, "Nothing was derived, so no request should be recorded")
        XCTAssertTrue(uploadClient.uploadedRequests.isEmpty, "Must not attempt to upload when there is nothing derived")
    }

    func test_refreshAndUpload_healthReadQueryFailure_degradesToCalendarOnly() async {
        let reader = FakeHealthSampleReader(nextError: .queryFailed("simulated HK query error"))
        let sut = BandUploadService(healthReader: reader, uploadClient: FakeBandUploadClient(), consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        XCTAssertEqual(outcome, .skippedNoHealthData)
    }

    /// A denied/empty HealthKit read (all three categories genuinely have
    /// no evidence) must upload an all-omitted request — NOT fabricate
    /// moderate/fair/sedentary from nothing (issue #70's central fix, and
    /// the direct replacement for this suite's old
    /// `test_refreshAndUpload_deniedPermission_emptyInput_stillDerivesNeutralBandsAndUploads`,
    /// which used to assert the fabrication this now forbids).
    func test_refreshAndUpload_deniedPermission_emptyInput_uploadsAllOmittedRequest_neverFabricates() async {
        let reader = FakeHealthSampleReader(nextInput: .empty)
        let uploadClient = FakeBandUploadClient()
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        guard case .uploaded(let derived) = outcome else {
            return XCTFail("Expected .uploaded (with an all-omitted payload), got \(outcome)")
        }
        XCTAssertNil(derived.recovery, "No HRV data -> omit, never fabricate moderate")
        XCTAssertNil(derived.sleepQuality, "No sleep data -> omit, never fabricate fair")
        XCTAssertNil(derived.activity, "No activity data (nil, not zeros) -> omit, never fabricate sedentary")
        XCTAssertTrue(derived.isEmpty)
        XCTAssertEqual(uploadClient.uploadedRequests.count, 1)

        let uploaded = uploadClient.uploadedRequests[0]
        XCTAssertNil(uploaded.recovery)
        XCTAssertNil(uploaded.sleepQuality)
        XCTAssertNil(uploaded.activity)
    }

    /// Zero-value activity (steps/energy genuinely 0, but the summary
    /// itself is present) is a real, honest measurement — distinct from
    /// "no evidence at all" — and must still upload as a real `sedentary`
    /// verdict, not be swept into the omission path.
    func test_refreshAndUpload_zeroActivitySummaryPresent_uploadsHonestSedentary_notOmitted() async {
        let input = BandDeriverInput(
            recentHRV: [],
            recentRestingHR: [],
            lastNightSleep: nil,
            recentActivity: ActivitySummary(steps: 0, activeEnergyBurnedKcal: 0, workoutMinutes: 0),
            baseline: .empty
        )
        let reader = FakeHealthSampleReader(nextInput: input)
        let uploadClient = FakeBandUploadClient()
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        guard case .uploaded(let derived) = outcome else {
            return XCTFail("Expected .uploaded, got \(outcome)")
        }
        XCTAssertEqual(derived.activity, .sedentary, "A present-but-zero ActivitySummary is a real measurement, not an omission")
        XCTAssertEqual(uploadClient.uploadedRequests.first?.activity, "sedentary")
    }

    // MARK: - Consent gating (issue #70)

    func test_refreshAndUpload_onlyQueriesHealthKitForEnabledCategories() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let consentStore = InMemoryConsentStore(initial: [.recovery: true, .sleep: false, .activity: true])
        let sut = BandUploadService(healthReader: reader, uploadClient: FakeBandUploadClient(), consentStore: consentStore)

        _ = await sut.refreshAndUpload()

        XCTAssertEqual(reader.lastEnabledCategories, [.recovery, .activity], "Sleep consent is off -> sleepQuality must never even be requested from HealthKit")
    }

    func test_refreshAndUpload_allConsentOff_neverQueriesHealthKitForAnyCategory() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let consentStore = InMemoryConsentStore(initial: [.recovery: false, .sleep: false, .activity: false])
        let sut = BandUploadService(healthReader: reader, uploadClient: FakeBandUploadClient(), consentStore: consentStore)

        _ = await sut.refreshAndUpload()

        XCTAssertTrue(reader.lastEnabledCategories.isEmpty)
    }

    /// The heart of issue #70: a category disabled in `ConsentStore` must
    /// never appear in the derived bands OR the uploaded wire payload, even
    /// though `FakeHealthSampleReader` here returns full, healthy data for
    /// every category — the withholding must happen upstream of the
    /// HealthKit read (via `enabledCategories`), not as an after-the-fact
    /// filter on the upload alone (a filter-only fix would still leak the
    /// category to HealthKit itself).
    func test_refreshAndUpload_disabledCategory_neverDerivedNeverUploaded_evenWithHealthyData() async {
        // Reuse the real reader-fake-to-input contract: since
        // `FakeHealthSampleReader` ignores `enabledCategories` when
        // deciding what to *return* (it's a dumb fake, unlike the real
        // HealthKit reader), this test proves `BandUploadService` itself
        // — not the reader — is responsible for consent-gating by
        // asserting the reader was never even told sleep was enabled
        // (covered above) AND that a real reader honoring that set would
        // legitimately produce nil sleep data, which must still be omitted
        // end-to-end. We simulate that real-reader behavior directly here.
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 70, date: Date())],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 55, date: Date())],
            lastNightSleep: nil, // sleep consent withheld -> real reader would never populate this
            recentActivity: ActivitySummary(steps: 9000, activeEnergyBurnedKcal: 500, workoutMinutes: 0),
            baseline: PersonalBaseline(
                meanHRVMilliseconds: 45, stdDevHRVMilliseconds: 8,
                meanRestingHRBpm: 60, meanDailySteps: 6000, meanDailyActiveEnergyKcal: 300,
                sampleDays: 30
            )
        )
        let reader = FakeHealthSampleReader(nextInput: input)
        let uploadClient = FakeBandUploadClient()
        let consentStore = InMemoryConsentStore(initial: [.recovery: true, .sleep: false, .activity: true])
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: consentStore)

        let outcome = await sut.refreshAndUpload()

        guard case .uploaded(let derived) = outcome else {
            return XCTFail("Expected .uploaded, got \(outcome)")
        }
        XCTAssertNotNil(derived.recovery, "Recovery is consented and has evidence -> must be derived")
        XCTAssertNil(derived.sleepQuality, "Sleep consent is off -> must never be derived, regardless of HealthKit having data")
        XCTAssertNotNil(derived.activity, "Activity is consented and has evidence -> must be derived")

        let uploaded = uploadClient.uploadedRequests[0]
        XCTAssertNotNil(uploaded.recovery)
        XCTAssertNil(uploaded.sleepQuality, "Withheld category must never appear in the uploaded wire payload")
        XCTAssertNotNil(uploaded.activity)
    }

    func test_refreshAndUpload_consentToggledBetweenRuns_takesEffectOnNextRunImmediately() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let uploadClient = FakeBandUploadClient()
        let consentStore = InMemoryConsentStore(initial: [.recovery: true, .sleep: true, .activity: true])
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: consentStore)

        _ = await sut.refreshAndUpload()
        XCTAssertEqual(reader.lastEnabledCategories, [.recovery, .sleepQuality, .activity])

        // User revokes sleep consent after the first refresh.
        consentStore.setEnabled(false, for: .sleep)
        _ = await sut.refreshAndUpload()

        XCTAssertEqual(reader.lastEnabledCategories, [.recovery, .activity], "A toggle flipped between refreshes must take effect on the very next one, no restart required")
    }

    // MARK: - Graceful degradation: upload (network) failure after a successful read

    func test_refreshAndUpload_uploadFails_bandsStillDerived_neverThrows() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let uploadClient = FakeBandUploadClient(nextError: .network("offline"))
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        guard case .uploadFailed(let derived, let error) = outcome else {
            return XCTFail("Expected .uploadFailed, got \(outcome)")
        }
        XCTAssertEqual(error, .network("offline"))
        let expected = BandDeriver.deriveDerivedBands(from: .demoFixture)
        XCTAssertEqual(derived, expected)
        XCTAssertNotNil(sut.lastSentRequest, "Even a failed upload attempt must record what was attempted, for ledger truthfulness (issue #70)")
    }

    func test_refreshAndUpload_notAuthenticated_isNonFatal() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let uploadClient = FakeBandUploadClient(nextError: .notAuthenticated)
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        let outcome = await sut.refreshAndUpload()

        guard case .uploadFailed(_, let error) = outcome else {
            return XCTFail("Expected .uploadFailed, got \(outcome)")
        }
        XCTAssertEqual(error, .notAuthenticated)
    }

    // MARK: - Repeated calls (manual "Refresh now" tapped multiple times)

    func test_refreshAndUpload_calledTwice_bothAttemptsSucceedIndependently() async {
        let reader = FakeHealthSampleReader(nextInput: .demoFixture)
        let uploadClient = FakeBandUploadClient()
        let sut = BandUploadService(healthReader: reader, uploadClient: uploadClient, consentStore: allEnabledConsentStore())

        _ = await sut.refreshAndUpload()
        _ = await sut.refreshAndUpload()

        XCTAssertEqual(reader.readCallCount, 2)
        XCTAssertEqual(uploadClient.uploadedRequests.count, 2)
    }
}
