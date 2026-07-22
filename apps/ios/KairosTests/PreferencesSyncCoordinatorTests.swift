import XCTest
@testable import Kairos

/// Issue #225: server-authoritative user state on iOS.
///
/// Per #193's standard of proof, these assert on *observable state after the
/// fact* — what the local stores hold once a refresh has run — rather than
/// on "the coordinator called pull()". A coordinator that pulled faithfully
/// and applied nothing would pass a call-count test and fail every test
/// here.
///
/// Two of these are the load-bearing ones and are worth naming up front:
///
///  - `test_refresh_appliesServerPreferencesOverTheLocalCache` is the
///    round trip the whole issue exists for — a value set on the server is
///    visible on this device afterwards.
///  - `test_refresh_failedPull_doesNotResetOnboardingState` is the failure
///    mode that must never regress: a user opening the app offline must not
///    be shown onboarding again.
final class PreferencesSyncCoordinatorTests: XCTestCase {

    // MARK: - Helpers

    private func makeSUT(
        localPreferences: OnboardingPreferences = .defaults,
        locallyOnboarded: Bool = false,
        serverOnboardedAt: Date? = nil,
        consent: [ConsentCategory: Bool] = [:],
        pullResult: RemoteUserState? = nil,
        pullError: PreferencesSyncError? = nil
    ) -> (
        sut: PreferencesSyncCoordinator,
        preferences: InMemoryPreferencesStore,
        consentStore: InMemoryConsentStore,
        onboarding: InMemoryOnboardingCompletionStore,
        client: FakePreferencesSyncClient
    ) {
        let preferences = InMemoryPreferencesStore(initial: localPreferences)
        let consentStore = InMemoryConsentStore(initial: consent)
        let onboarding = InMemoryOnboardingCompletionStore(
            initial: locallyOnboarded,
            serverOnboardedAt: serverOnboardedAt
        )
        let client = FakePreferencesSyncClient(pullResult: pullResult, nextPullError: pullError)
        let sut = PreferencesSyncCoordinator(
            remoteSync: client,
            preferencesStore: preferences,
            consentStore: consentStore,
            onboardingCompletionStore: onboarding
        )
        return (sut, preferences, consentStore, onboarding, client)
    }

    private func remoteState(
        preferences: OnboardingPreferences = .defaults,
        onboardedAt: Date? = nil,
        calendarEnabled: Bool = true,
        healthEnabled: Bool = true,
        communicationEnabled: Bool = true
    ) -> RemoteUserState {
        RemoteUserState(
            preferences: preferences,
            onboardedAt: onboardedAt,
            consent: RemoteConsentFlags(
                calendarEnabled: calendarEnabled,
                healthEnabled: healthEnabled,
                communicationEnabled: communicationEnabled
            )
        )
    }

    // MARK: - Conflict rule: server wins on pull

    func test_refresh_appliesServerPreferencesOverTheLocalCache() async {
        // The acceptance criterion of #225, in one direction: a value set
        // through the API (here, by "web") is what this device holds after a
        // pull. Before this change `pull()` was called by nothing, so a
        // web-side edit could reach iOS by no path at all.
        var serverPreferences = OnboardingPreferences.defaults
        serverPreferences.workdayStartHour = 5
        serverPreferences.voice = .bright

        var localPreferences = OnboardingPreferences.defaults
        localPreferences.workdayStartHour = 9
        localPreferences.voice = .calm

        let env = makeSUT(
            localPreferences: localPreferences,
            pullResult: remoteState(preferences: serverPreferences)
        )

        let outcome = await env.sut.refresh()

        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(env.preferences.load().workdayStartHour, 5)
        XCTAssertEqual(env.preferences.load().voice, .bright)
    }

    func test_refresh_doesNotResetTraditionAndTranslation() async {
        // `GET /v1/preferences` carries neither field — they are
        // `users.tradition` / `users.translation_id` — so
        // `onboardingPreferences(from:)` fills both with defaults. Harmless
        // while `pull()` was dead code; the moment #225 started applying
        // pulled state, a plain save would silently switch every user's
        // Bible translation back to BSB on every foreground.
        //
        // "Server wins" cannot apply to a field the server did not send.
        var local = OnboardingPreferences.defaults
        local.tradition = .anglican
        local.translation = .asv
        local.voice = .calm

        var server = OnboardingPreferences.defaults
        server.voice = .bright

        let env = makeSUT(localPreferences: local, pullResult: remoteState(preferences: server))

        await env.sut.refresh()

        XCTAssertEqual(env.preferences.load().voice, .bright, "Fields the server does send still apply")
        XCTAssertEqual(env.preferences.load().tradition, .anglican)
        XCTAssertEqual(env.preferences.load().translation, .asv)
        XCTAssertEqual(
            OnboardingPreferences.defaults.translation,
            .bsb,
            "Guards the premise: .asv above must differ from the default the client would otherwise substitute"
        )
    }

    func test_refresh_discardsAResponseThatRacedALocalEdit() async {
        // The carve-out on "server wins". The pull left before the user
        // touched anything; by the time it lands, the user has picked a new
        // voice and watched it take effect. Applying the older snapshot now
        // would revert a deliberate action in front of them.
        var serverPreferences = OnboardingPreferences.defaults
        serverPreferences.voice = .calm

        let env = makeSUT(pullResult: remoteState(preferences: serverPreferences))

        var localEdit = OnboardingPreferences.defaults
        localEdit.voice = .bright
        // Simulates the user saving mid-flight: `FakePreferencesSyncClient`
        // invokes this from inside `pull()`, i.e. after the coordinator has
        // already sampled the write generation.
        env.client.onPull = { [preferences = env.preferences] in
            preferences.save(localEdit)
        }

        let outcome = await env.sut.refresh()

        XCTAssertEqual(outcome, .discardedStaleResponse)
        XCTAssertEqual(
            env.preferences.load().voice,
            .bright,
            "A pull that raced a local edit must not overwrite the edit the user just made"
        )
    }

    func test_refresh_failedPull_leavesLocalPreferencesIntact() async {
        // Stale-cache-with-refresh: offline is a no-op, not a reset.
        var localPreferences = OnboardingPreferences.defaults
        localPreferences.workdayStartHour = 9

        let env = makeSUT(
            localPreferences: localPreferences,
            pullError: .network("The Internet connection appears to be offline.")
        )

        let outcome = await env.sut.refresh()

        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(env.preferences.load().workdayStartHour, 9)
    }

    // MARK: - Onboarding: the latch

    func test_refresh_appliesServerOnboardingToADeviceThatNeverOnboarded() async {
        // "A user who onboards on web is not shown onboarding on iOS" —
        // acceptance criterion #2 of #225, from the device's point of view.
        let env = makeSUT(
            locallyOnboarded: false,
            pullResult: remoteState(onboardedAt: Date(timeIntervalSince1970: 1_770_000_000))
        )

        XCTAssertFalse(env.onboarding.hasCompletedOnboarding())

        await env.sut.refresh()

        XCTAssertTrue(env.onboarding.hasCompletedOnboarding())
    }

    func test_refresh_failedPull_doesNotResetOnboardingState() async {
        // THE test. A user on a plane opens the app; the pull fails. If a
        // failure could clear this flag they would be marched back through
        // onboarding, having done nothing wrong and lost nothing — which is
        // the single worst outcome available in this change.
        let env = makeSUT(
            locallyOnboarded: true,
            serverOnboardedAt: Date(timeIntervalSince1970: 1_770_000_000),
            pullError: .network("The Internet connection appears to be offline.")
        )

        let outcome = await env.sut.refresh()

        XCTAssertEqual(outcome, .failed)
        XCTAssertTrue(
            env.onboarding.hasCompletedOnboarding(),
            "A failed pull is not evidence about the user's history and must never clear completion"
        )
    }

    func test_refresh_serverWithNoOnboardingRecord_doesNotResetOnboardingState() async {
        // The second, subtler half of the same guarantee: a *successful*
        // pull returning `onboardedAt: nil` is also not evidence. That is
        // what every pre-#225 user looks like, since migration
        // 1721800000000 deliberately backfilled nothing.
        let env = makeSUT(
            locallyOnboarded: true,
            pullResult: remoteState(onboardedAt: nil)
        )

        let outcome = await env.sut.refresh()

        XCTAssertEqual(outcome, .applied)
        XCTAssertTrue(env.onboarding.hasCompletedOnboarding())
    }

    func test_refresh_backfillsCompletionWhenTheServerHasNoRecord() async {
        // The reverse direction of the latch — how a pre-#225 user's
        // completion gets recorded server-side, so the *web* app can see it.
        let env = makeSUT(
            locallyOnboarded: true,
            pullResult: remoteState(onboardedAt: nil)
        )

        await env.sut.refresh()

        XCTAssertEqual(env.client.pushes.count, 1)
        XCTAssertEqual(env.client.pushes.first?.onboardingCompleted, true)
    }

    func test_refresh_doesNotAssertCompletionForADeviceThatNeverOnboarded() async {
        // `needsServerBackfill` is not `!hasCompletedOnboarding()`. A fresh
        // install has nothing to backfill and must not claim completion just
        // because the server agrees it hasn't happened — that would skip
        // onboarding for a brand-new user on their second launch.
        let env = makeSUT(
            locallyOnboarded: false,
            pullResult: remoteState(onboardedAt: nil)
        )

        await env.sut.refresh()

        XCTAssertTrue(env.client.pushes.isEmpty)
        XCTAssertFalse(env.onboarding.hasCompletedOnboarding())
    }

    func test_refresh_noServerRow_stillBackfillsCompletion() async {
        // A `nil` snapshot (no `preferences` row yet) is a different case
        // from `onboardedAt: nil`, but the backfill has to run in both —
        // onboarding offline, before any row existed, lands here.
        let env = makeSUT(locallyOnboarded: true, pullResult: nil)

        let outcome = await env.sut.refresh()

        XCTAssertEqual(outcome, .noServerState)
        XCTAssertEqual(env.client.pushes.first?.onboardingCompleted, true)
    }

    func test_markOnboardingCompleted_marksLocallyEvenWhenThePushFails() async {
        // A user who finishes onboarding in a tunnel is finished. The local
        // latch is written before the push is awaited, so a network failure
        // cannot strand them on the Done screen.
        let env = makeSUT(locallyOnboarded: false)
        env.client.nextPushError = .network("offline")

        await env.sut.markOnboardingCompleted()

        XCTAssertTrue(env.onboarding.hasCompletedOnboarding())
        XCTAssertTrue(env.client.pushes.isEmpty, "The push genuinely failed")
        XCTAssertTrue(
            env.onboarding.needsServerBackfill(),
            "…and the next successful refresh must therefore retry it"
        )
    }

    // MARK: - Consent

    func test_refresh_appliesAServerSideRevocationToTheDeviceStore() async {
        // #201 made the server columns real gates; #225 makes a revocation
        // performed on web also stop this device collecting in the first
        // place. Without this, the phone would keep reading HealthKit for a
        // category the user had revoked elsewhere.
        let env = makeSUT(
            consent: [.calendar: true, .recovery: true, .sleep: true, .activity: true],
            pullResult: remoteState(calendarEnabled: false, healthEnabled: false)
        )

        await env.sut.refresh()

        XCTAssertFalse(env.consentStore.isEnabled(.calendar))
        XCTAssertFalse(env.consentStore.isEnabled(.recovery))
        XCTAssertFalse(env.consentStore.isEnabled(.sleep))
        XCTAssertFalse(env.consentStore.isEnabled(.activity))
    }

    func test_refresh_serverGrantDoesNotEnableCategoriesTheUserTurnedOff() async {
        // The asymmetry in `ConsentSyncMapping`: `healthEnabled: true` means
        // "not revoked at the coarse level", which says nothing about the
        // finer per-category split. Inferring three grants from it would
        // manufacture consent and silently resume HealthKit reads on a
        // device where they were deliberately stopped.
        let env = makeSUT(
            consent: [.calendar: false, .recovery: false, .sleep: true, .activity: false],
            pullResult: remoteState(calendarEnabled: true, healthEnabled: true)
        )

        await env.sut.refresh()

        XCTAssertFalse(env.consentStore.isEnabled(.calendar))
        XCTAssertFalse(env.consentStore.isEnabled(.recovery))
        XCTAssertTrue(env.consentStore.isEnabled(.sleep))
        XCTAssertFalse(env.consentStore.isEnabled(.activity))
    }

    func test_pushConsent_writesTheDeviceTogglesToTheServerColumns() async {
        // "iOS must start writing these" (#225 work item 3). Before this,
        // `PreferencesResponseDataBody` was `Decodable`-only and the consent
        // columns could hold nothing but what the migration backfilled.
        let env = makeSUT(consent: [.calendar: true, .recovery: false, .sleep: true, .activity: false])

        await env.sut.pushConsent()

        XCTAssertEqual(env.client.pushes.count, 1)
        XCTAssertEqual(
            env.client.pushes.first?.consent,
            RemoteConsentWrite(calendarEnabled: true, healthEnabled: true),
            "healthEnabled is the OR of the three health categories — one enabled means this device may send health signal"
        )
    }

    func test_pushConsent_sendsHealthDisabledOnlyWhenEveryHealthCategoryIsOff() async {
        let env = makeSUT(consent: [.calendar: false, .recovery: false, .sleep: false, .activity: false])

        await env.sut.pushConsent()

        XCTAssertEqual(
            env.client.pushes.first?.consent,
            RemoteConsentWrite(calendarEnabled: false, healthEnabled: false)
        )
    }

    func test_ordinaryPreferencesPush_makesNoConsentStatement() async {
        // A routine sync must not restate consent, or a stale device echo
        // would resurrect a decision the user revoked on the other surface.
        // `nil` omits the keys entirely and the server COALESCEs them.
        let env = makeSUT(locallyOnboarded: true, serverOnboardedAt: Date())

        try? await env.client.push(.defaults)

        XCTAssertNil(env.client.pushes.first?.consent)
        XCTAssertEqual(env.client.pushes.first?.onboardingCompleted, false)
    }
}
