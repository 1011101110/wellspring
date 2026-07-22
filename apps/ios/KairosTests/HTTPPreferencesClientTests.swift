import XCTest
@testable import Kairos

/// Tests for `HTTPPreferencesClient` (issue #85's iOS half of wiring
/// `RemotePreferencesSyncing`) — the HTTP mechanics (method/URL/headers/404
/// handling), mirroring `AccountDeletionClientTests`'/`BandUploadClientTests`'
/// `URLProtocol`-stub pattern, plus direct tests of the field-mapping
/// helpers (`updateBody(for:)`/`onboardingPreferences(from:)`) since the
/// lossy two-way mapping between `OnboardingPreferences` and the backend's
/// `preferences` row is the part most likely to silently drift.
@MainActor
final class HTTPPreferencesClientTests: XCTestCase {

    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(StubbedURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(StubbedURLProtocol.self)
        StubbedURLProtocol.stubbedResponse = nil
        StubbedURLProtocol.capturedRequest = nil
        StubbedURLProtocol.capturedBody = nil
        super.tearDown()
    }

    // MARK: - push(): HTTP method, URL, headers

    func test_push_putsToV1PreferencesEndpoint() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "tok")
        try await sut.push(.defaults)

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "PUT")
        XCTAssertTrue(
            captured.url?.path.hasSuffix("/v1/preferences") == true,
            "URL must end with /v1/preferences, got \(captured.url?.absoluteString ?? "<nil>")"
        )
    }

    func test_push_sendsAuthorizationBearerHeader() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "my-firebase-id-token")
        try await sut.push(.defaults)

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(
            captured.value(forHTTPHeaderField: "Authorization"),
            "Bearer my-firebase-id-token"
        )
    }

    func test_push_tokenProviderThrows_throwsNotAuthenticated() async {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeFailingTokenSUT()

        do {
            try await sut.push(.defaults)
            XCTFail("Expected PreferencesSyncError.notAuthenticated to be thrown")
        } catch let error as PreferencesSyncError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_push_serverReturns500_throwsServerError() async {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 500)
        let sut = makeSUT(idToken: "tok")

        do {
            try await sut.push(.defaults)
            XCTFail("Expected PreferencesSyncError.server to be thrown")
        } catch let error as PreferencesSyncError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - pull(): HTTP method, URL, 404-as-nil

    func test_pull_getsFromV1PreferencesEndpoint() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.samplePreferencesResponseJSON
        )
        let sut = makeSUT(idToken: "tok")
        _ = try await sut.pull()

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "GET")
        XCTAssertTrue(captured.url?.path.hasSuffix("/v1/preferences") == true)
    }

    /// A brand-new user has no `preferences` row until the first `PUT`
    /// (`PreferencesRepository.ensureExists` is only invoked from that
    /// route on the backend) — `pull()`'s doc comment promises `nil` for
    /// "the server has no stored value yet," which is exactly this case.
    func test_pull_404_returnsNilRatherThanThrowing() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 404)
        let sut = makeSUT(idToken: "tok")

        let result = try await sut.pull()
        XCTAssertNil(result)
    }

    func test_pull_serverReturns500_throwsServerError() async {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 500)
        let sut = makeSUT(idToken: "tok")

        do {
            _ = try await sut.pull()
            XCTFail("Expected PreferencesSyncError.server to be thrown")
        } catch let error as PreferencesSyncError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_pull_decodesFixtureShapedResponse_intoOnboardingPreferences() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.samplePreferencesResponseJSON
        )
        let sut = makeSUT(idToken: "tok")

        let pulled = try await sut.pull()
        // `pull()` returns the full `RemoteUserState` since #225, of which
        // preferences are one part; the rest of the snapshot is covered by
        // `PreferencesSyncCoordinatorTests`.
        let result = try XCTUnwrap(pulled).preferences
        XCTAssertEqual(result.workdayStartHour, 6)
        XCTAssertEqual(result.workdayEndHour, 8)
        XCTAssertEqual(result.days, [.sunday, .wednesday, .saturday])
        // Derived from those three days, not read from the payload's
        // `cadence` string (K2, #188).
        XCTAssertEqual(result.cadence, .custom)
        XCTAssertEqual(result.duration, .extended)
        XCTAssertEqual(result.voice, .warm)
        XCTAssertEqual(result.stillness, .brief)
        XCTAssertEqual(result.examenEnabled, true)
    }

    // MARK: - Field mapping: push direction (OnboardingPreferences -> wire)

    func test_updateBody_formatsWorkdayHoursAsHHColon00() {
        let prefs = OnboardingPreferences(workdayStartHour: 6, workdayEndHour: 17)
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.windowStartLocal, "06:00")
        XCTAssertEqual(body.windowEndLocal, "17:00")
    }

    /// Issue #187: without this the server has no zone signal until (and
    /// unless) the user connects a calendar, so every gap is computed
    /// against the `UTC` column default.
    func test_updateBody_sendsTheDeviceTimeZoneIdentifier() {
        let body = HTTPPreferencesClient.updateBody(
            for: .defaults,
            timeZoneIdentifier: "America/New_York"
        )
        XCTAssertEqual(body.timezone, "America/New_York")
    }

    /// Defaulted rather than optional, so no call site can forget it.
    func test_updateBody_defaultsToTheCurrentDeviceTimeZone() {
        let body = HTTPPreferencesClient.updateBody(for: .defaults)
        XCTAssertEqual(body.timezone, TimeZone.current.identifier)
    }

    func test_updateBody_mapsWeekdayRawValuesToZeroIndexedSundayFirst() {
        let prefs = OnboardingPreferences(days: [.sunday, .monday, .saturday])
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.activeDays, [0, 1, 6])
    }

    func test_updateBody_allSevenDays_mapsToCadenceDaily() {
        let prefs = OnboardingPreferences(days: Set(Weekday.allCases))
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.cadence, "daily")
    }

    func test_updateBody_mondayToFriday_mapsToCadenceWeekdays() {
        let prefs = OnboardingPreferences(days: Weekday.weekdays)
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.cadence, "weekdays")
    }

    func test_updateBody_arbitrarySubset_mapsToCadenceCustom() {
        let prefs = OnboardingPreferences(days: [.tuesday, .thursday])
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.cadence, "custom")
    }

    /// The backend has no "auto-pick a length" concept
    /// (`DevotionalFormatSchema` has no `.auto` case) — sending a
    /// fabricated value would be worse than omitting the field.
    func test_updateBody_autoDuration_omitsDurationPreferenceField() {
        let prefs = OnboardingPreferences(duration: .auto)
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertNil(body.durationPreference)
    }

    func test_updateBody_nonAutoDuration_sendsRawValue() {
        let prefs = OnboardingPreferences(duration: .short)
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.durationPreference, "short")
    }

    func test_updateBody_sendsVoiceRawValue() {
        let prefs = OnboardingPreferences(voice: .bright)
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.voice, "bright")
    }

    func test_updateBody_sendsStillnessRawValue() {
        let prefs = OnboardingPreferences(stillness: .full)
        let body = HTTPPreferencesClient.updateBody(for: prefs)
        XCTAssertEqual(body.stillness, "full")
    }

    func test_updateBody_sendsExamenEnabled() {
        let enabled = OnboardingPreferences(examenEnabled: true)
        XCTAssertEqual(HTTPPreferencesClient.updateBody(for: enabled).examenEnabled, true)

        let disabled = OnboardingPreferences(examenEnabled: false)
        XCTAssertEqual(HTTPPreferencesClient.updateBody(for: disabled).examenEnabled, false)
    }

    // MARK: - Field mapping: pull direction (wire -> OnboardingPreferences)

    func test_onboardingPreferences_parsesHourFromHHColonMMWindow() {
        let data = Self.sampleResponseData(windowStartLocal: "06:30", windowEndLocal: "20:00")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.workdayStartHour, 6)
        XCTAssertEqual(prefs.workdayEndHour, 20)
    }

    func test_onboardingPreferences_mapsZeroIndexedSundayFirstActiveDaysBackToWeekday() {
        let data = Self.sampleResponseData(activeDays: [0, 2, 5])
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.days, [.sunday, .tuesday, .friday])
    }

    /// K2 (#188): the wire `cadence` is a label over `activeDays`, so it is
    /// ignored on the way in and the label is re-derived from the days.
    /// This is not pedantry — `cadence: "daily"` beside `activeDays:
    /// [1,2,3,4,5]` was the *column default* of every row written before
    /// #188, so a client that trusted the string would show "Daily" to a
    /// user whose devotionals correctly arrive Mon–Fri.
    func test_onboardingPreferences_derivesCadenceFromActiveDays_notFromTheCadenceString() {
        let contradictory = Self.sampleResponseData(activeDays: [1, 2, 3, 4, 5], cadence: "daily")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: contradictory)
        XCTAssertEqual(prefs.days, Weekday.weekdays)
        XCTAssertEqual(prefs.cadence, .weekdays)
    }

    func test_onboardingPreferences_allSevenActiveDays_readBackAsDailyCadence() {
        let data = Self.sampleResponseData(activeDays: [0, 1, 2, 3, 4, 5, 6], cadence: "custom")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.cadence, .daily)
    }

    func test_onboardingPreferences_arbitraryActiveDays_readBackAsCustomCadence() {
        let data = Self.sampleResponseData(activeDays: [0, 6], cadence: "daily")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.cadence, .custom)
    }

    func test_onboardingPreferences_unrecognizedDurationPreference_fallsBackToAuto() {
        let data = Self.sampleResponseData(durationPreference: "not-a-real-format")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.duration, .auto)
    }

    /// The server's `voice` column is a real TTS voice id (e.g.
    /// `"en-US-Chirp3-HD-Kore"`), never one of `VoiceChoice`'s three raw
    /// values — this is a known, pre-existing, out-of-scope mismatch
    /// (documented on `HTTPPreferencesClient`), so an unrecognized value
    /// must fall back rather than throw or crash.
    func test_onboardingPreferences_unrecognizedVoice_fallsBackToWarm() {
        let data = Self.sampleResponseData(voice: "en-US-Chirp3-HD-Kore")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.voice, .warm)
    }

    func test_onboardingPreferences_parsesStillnessRawValue() {
        let data = Self.sampleResponseData(stillness: "full")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.stillness, .full)
    }

    /// `stillness` is a plain `text` column server-side (see
    /// `PreferencesResponseDataSchema`'s doc comment) — an out-of-band value
    /// must fall back rather than throw or crash, same as `voice` above.
    func test_onboardingPreferences_unrecognizedStillness_fallsBackToOff() {
        let data = Self.sampleResponseData(stillness: "not-a-real-stillness")
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.stillness, .off)
    }

    func test_onboardingPreferences_parsesExamenEnabled() {
        let enabled = Self.sampleResponseData(examenEnabled: true)
        XCTAssertEqual(HTTPPreferencesClient.onboardingPreferences(from: enabled).examenEnabled, true)

        let disabled = Self.sampleResponseData(examenEnabled: false)
        XCTAssertEqual(HTTPPreferencesClient.onboardingPreferences(from: disabled).examenEnabled, false)
    }

    /// `tradition`/`translation` live on `users`, not `preferences`
    /// (`packages/shared-contracts/src/api/preferences.ts`'s own doc
    /// comment) — there is no server value to pull, so this locks the
    /// documented fallback to `OnboardingPreferences`'s own defaults.
    func test_onboardingPreferences_hasNoServerSource_fillsTraditionAndTranslationWithDefaults() {
        let data = Self.sampleResponseData()
        let prefs = HTTPPreferencesClient.onboardingPreferences(from: data)
        XCTAssertEqual(prefs.tradition, OnboardingPreferences.defaults.tradition)
        XCTAssertEqual(prefs.translation, OnboardingPreferences.defaults.translation)
    }

    // MARK: - Helpers

    private func makeSUT(idToken: String) -> HTTPPreferencesClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPPreferencesClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { idToken }
        )
    }

    private func makeFailingTokenSUT() -> HTTPPreferencesClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPPreferencesClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { throw URLError(.userAuthenticationRequired) }
        )
    }

    // MARK: - Server-authoritative side-car fields (issue #225)

    func test_updateBody_omitsConsentAndOnboardingByDefault() {
        // An ordinary preferences sync makes no statement about consent or
        // onboarding. If it did, a stale device echo would overwrite a
        // decision the user made on web — the server COALESCEs absent
        // fields, so omission is how "no opinion" is expressed.
        let body = HTTPPreferencesClient.updateBody(for: .defaults)

        XCTAssertNil(body.calendarEnabled)
        XCTAssertNil(body.healthEnabled)
        XCTAssertNil(body.onboardingCompleted)
    }

    func test_updateBody_sendsConsentFlagsWhenSupplied() {
        let body = HTTPPreferencesClient.updateBody(
            for: .defaults,
            consent: RemoteConsentWrite(calendarEnabled: false, healthEnabled: true)
        )

        XCTAssertEqual(body.calendarEnabled, false)
        XCTAssertEqual(body.healthEnabled, true)
    }

    func test_updateBody_sendsOnboardingCompletedOnlyAsTrue() {
        // The server's schema is `z.literal(true).optional()`: a literal
        // `false` on the wire is a 400 by design, because there is no
        // "un-onboard me". So `false` must become an omitted key, never a
        // sent `false`.
        let asserting = HTTPPreferencesClient.updateBody(for: .defaults, onboardingCompleted: true)
        XCTAssertEqual(asserting.onboardingCompleted, true)

        let silent = HTTPPreferencesClient.updateBody(for: .defaults, onboardingCompleted: false)
        XCTAssertNil(silent.onboardingCompleted)
    }

    func test_remoteUserState_parsesOnboardedAtWithFractionalSeconds() {
        // The server emits `Date.toISOString()`, which always carries
        // milliseconds. `ISO8601DateFormatter`'s default options reject
        // them and would silently yield `nil` — indistinguishable
        // downstream from "never onboarded", i.e. presenting exactly as the
        // re-onboarding bug this issue exists to fix.
        let data = Self.sampleResponseData(onboardedAt: "2026-07-04T12:30:00.000Z")

        let state = HTTPPreferencesClient.remoteUserState(from: data)

        XCTAssertNotNil(state.onboardedAt)
    }

    func test_remoteUserState_parsesOnboardedAtWithoutFractionalSeconds() {
        let data = Self.sampleResponseData(onboardedAt: "2026-07-04T12:30:00Z")
        XCTAssertNotNil(HTTPPreferencesClient.remoteUserState(from: data).onboardedAt)
    }

    func test_remoteUserState_nullOnboardedAtIsNil() {
        XCTAssertNil(HTTPPreferencesClient.remoteUserState(from: Self.sampleResponseData()).onboardedAt)
    }

    func test_remoteUserState_carriesTheConsentTrio() {
        let data = Self.sampleResponseData(
            calendarEnabled: false,
            healthEnabled: true,
            communicationEnabled: false
        )

        let consent = HTTPPreferencesClient.remoteUserState(from: data).consent

        XCTAssertFalse(consent.calendarEnabled)
        XCTAssertTrue(consent.healthEnabled)
        XCTAssertFalse(consent.communicationEnabled)
    }

    func test_pull_decodesAResponseWithNoOnboardedAtKeyAtAll() async throws {
        // A server predating #225 omits the key entirely. `onboardedAt` is
        // *optional* rather than merely nullable on the Swift side for
        // exactly this: a decode failure would surface as
        // `.network("Malformed response body.")` and take down the whole
        // pull, including the preferences that decoded perfectly well.
        // `samplePreferencesResponseJSON` deliberately has no such key.
        StubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.samplePreferencesResponseJSON
        )
        let sut = makeSUT(idToken: "tok")

        let state = try XCTUnwrap(try await sut.pull())

        XCTAssertNil(state.onboardedAt)
        XCTAssertEqual(state.preferences.workdayStartHour, 6)
    }

    private static func sampleResponseData(
        windowStartLocal: String = "06:00",
        windowEndLocal: String = "08:00",
        activeDays: [Int] = [0, 3, 6],
        cadence: String = "custom",
        durationPreference: String = "extended",
        voice: String = "warm",
        stillness: String = "off",
        examenEnabled: Bool = false,
        calendarEnabled: Bool = true,
        healthEnabled: Bool = true,
        communicationEnabled: Bool = false,
        onboardedAt: String? = nil
    ) -> PreferencesResponseDataBody {
        PreferencesResponseDataBody(
            userId: "user-1",
            windowStartLocal: windowStartLocal,
            windowEndLocal: windowEndLocal,
            activeDays: activeDays,
            cadence: cadence,
            durationPreference: durationPreference,
            voice: voice,
            stillness: stillness,
            examenEnabled: examenEnabled,
            calendarEnabled: calendarEnabled,
            healthEnabled: healthEnabled,
            communicationEnabled: communicationEnabled,
            notifyOnSkip: false,
            onboardedAt: onboardedAt,
            updatedAt: "2026-07-04T00:00:00.000Z"
        )
    }

    /// Byte-shaped like `PreferencesResponseSchema`
    /// (`packages/shared-contracts/src/api/preferences.ts`) with
    /// `activeDays: [0, 3, 6]` (Sun/Wed/Sat), `cadence: "custom"`,
    /// `durationPreference: "extended"`, `voice: "warm"`, `stillness: "brief"`.
    private static let samplePreferencesResponseJSON = Data(
        """
        {
          "ok": true,
          "data": {
            "userId": "user-1",
            "windowStartLocal": "06:00",
            "windowEndLocal": "08:00",
            "activeDays": [0, 3, 6],
            "cadence": "custom",
            "durationPreference": "extended",
            "voice": "warm",
            "stillness": "brief",
            "examenEnabled": true,
            "calendarEnabled": true,
            "healthEnabled": true,
            "communicationEnabled": false,
            "notifyOnSkip": false,
            "updatedAt": "2026-07-04T00:00:00.000Z"
          }
        }
        """.utf8
    )
}

// MARK: - URLProtocol stub

private final class StubbedURLProtocol: URLProtocol {
    enum StubbedResponseType {
        case success(statusCode: Int)
        case successWithBody(statusCode: Int, body: Data)
    }

    static var stubbedResponse: StubbedResponseType?
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        StubbedURLProtocol.capturedRequest = request
        if let body = request.httpBody {
            StubbedURLProtocol.capturedBody = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(buffer, maxLength: 4096)
                if n > 0 { data.append(buffer, count: n) }
            }
            buffer.deallocate()
            stream.close()
            StubbedURLProtocol.capturedBody = data
        }

        guard let responseType = StubbedURLProtocol.stubbedResponse else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        switch responseType {
        case .success(let statusCode):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            let body = Data(#"{"ok":true}"#.utf8)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .successWithBody(let statusCode, let body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
