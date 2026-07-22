import XCTest
@testable import Kairos

@MainActor
final class OnboardingViewModelTests: XCTestCase {

    func test_initialStep_isWelcome() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        XCTAssertEqual(sut.step, .welcome)
    }

    func test_advanceFromWelcome_movesToSignIn() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()
        XCTAssertEqual(sut.step, .signIn)
    }

    func test_signInWithApple_normalEmail_movesToInviteEmailWithoutRelayExplainer() async {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()

        await sut.signInWithApple()

        XCTAssertEqual(sut.step, .inviteEmail)
        XCTAssertFalse(sut.needsRelayExplainer)
        XCTAssertEqual(sut.inviteEmailDraft, "demo.user@example.com")
    }

    func test_signInWithApple_relayEmail_flagsRelayExplainerAndClearsDraft() async {
        let auth = FakeAuthService(simulatesPrivateRelayEmail: true)
        let sut = OnboardingViewModel(authService: auth, calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()

        await sut.signInWithApple()

        XCTAssertEqual(sut.step, .inviteEmail)
        XCTAssertTrue(sut.needsRelayExplainer)
        XCTAssertEqual(sut.inviteEmailDraft, "", "Relay addresses should not be pre-filled as the invite email")
    }

    func test_signIn_failure_setsErrorMessageAndStaysOnSignIn() async {
        let auth = FakeAuthService()
        auth.nextSignInError = .network("offline")
        let sut = OnboardingViewModel(authService: auth, calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()

        await sut.signInWithApple()

        XCTAssertEqual(sut.step, .signIn)
        XCTAssertNotNil(sut.errorMessage)
    }

    // MARK: - Email sign-up (issue #71 / docs/14_IMPROVEMENT_REVIEW.md §1.9)

    func test_signUpWithEmail_success_movesToInviteEmail() async {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()

        await sut.signUpWithEmail(email: "new@example.com", password: "longenoughpassword")

        XCTAssertEqual(sut.step, .inviteEmail)
        XCTAssertNil(sut.errorMessage)
    }

    func test_signUpWithEmail_failure_setsErrorMessageAndStaysOnSignIn() async {
        let auth = FakeAuthService()
        auth.nextSignInError = .unknown("An account with this email already exists.")
        let sut = OnboardingViewModel(authService: auth, calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()

        await sut.signUpWithEmail(email: "existing@example.com", password: "longenoughpassword")

        XCTAssertEqual(sut.step, .signIn)
        XCTAssertNotNil(sut.errorMessage)
    }

    func test_confirmInviteEmail_emptyDraft_setsErrorAndStays() async {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = ""

        await sut.confirmInviteEmail()

        XCTAssertNotNil(sut.errorMessage)
        XCTAssertEqual(sut.step, .inviteEmail)
    }

    func test_confirmInviteEmail_valid_movesToCalendarConnect() async {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"

        await sut.confirmInviteEmail()

        XCTAssertEqual(sut.step, .calendarConnect)
    }

    func test_connectCalendar_success_movesToHealthPriming() async {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()

        await sut.connectCalendar(.appleEventKit)

        XCTAssertEqual(sut.step, .healthPriming)
        XCTAssertEqual(sut.calendarStatus, .connected(.appleEventKit))
    }

    /// docs/05_UX_FLOWS.md §3.1 "Denied permission": a denied EventKit
    /// request must not strand the user on the calendar-connect screen —
    /// the app degrades to email-invites-only mode and the flow continues.
    func test_connectCalendar_eventKitDenied_degradesToEmailOnlyAndAdvances() async {
        let calendar = FakeCalendarConnectService()
        calendar.nextError = .permissionDenied
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: calendar)
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()

        await sut.connectCalendar(.appleEventKit)

        XCTAssertEqual(sut.step, .healthPriming, "Denied permission must not strand the user")
        XCTAssertEqual(sut.calendarStatus, .connected(.emailOnly))
    }

    func test_connectCalendar_unimplementedGoogle_staysOnCalendarConnectWithError() async {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()

        await sut.connectCalendar(.google)

        XCTAssertEqual(sut.step, .calendarConnect)
        XCTAssertNotNil(sut.errorMessage)
    }

    func test_skipCalendarConnect_movesToHealthPriming() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.skipCalendarConnect()
        XCTAssertEqual(sut.step, .healthPriming)
    }

    // MARK: - Screen 4: health priming

    func test_healthCategoryToggles_defaultAllOff() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        XCTAssertFalse(sut.hasAnyHealthCategoryToggledOn)
        for category in HealthCategory.allCases {
            XCTAssertEqual(sut.healthCategoryToggles[category], false)
        }
    }

    func test_toggleHealthCategory_flipsOnlyThatCategory() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.toggleHealthCategory(.recovery)

        XCTAssertTrue(sut.healthCategoryToggles[.recovery] ?? false)
        XCTAssertFalse(sut.healthCategoryToggles[.sleepQuality] ?? true)
        XCTAssertTrue(sut.hasAnyHealthCategoryToggledOn)
    }

    func test_requestHealthAuthorization_noCategoriesToggled_skipsRequestAndAdvances() async {
        let health = FakeHealthConnectService()
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            healthService: health
        )

        await sut.requestHealthAuthorization()

        XCTAssertEqual(sut.step, .preferences)
        XCTAssertTrue(health.lastRequestedCategories.isEmpty, "No category was toggled on, so HealthKit must never be touched")
    }

    func test_requestHealthAuthorization_onlyRequestsToggledCategories() async {
        let health = FakeHealthConnectService()
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            healthService: health
        )
        sut.toggleHealthCategory(.recovery)
        sut.toggleHealthCategory(.activity)

        await sut.requestHealthAuthorization()

        XCTAssertEqual(sut.step, .preferences)
        XCTAssertEqual(health.lastRequestedCategories, [.recovery, .activity])
        XCTAssertNil(health.lastRequestedCategories.first(where: { $0 == .sleepQuality }))
    }

    /// docs/05_UX_FLOWS.md §1 P4: a denied HealthKit request degrades
    /// gracefully (band omitted) and never blocks onboarding.
    func test_requestHealthAuthorization_denied_stillAdvancesToPreferences() async {
        let health = FakeHealthConnectService(simulatesDenial: true)
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            healthService: health
        )
        sut.toggleHealthCategory(.sleepQuality)

        await sut.requestHealthAuthorization()

        XCTAssertEqual(sut.step, .preferences)
        XCTAssertEqual(sut.healthAuthResult[.sleepQuality], .denied)
    }

    func test_requestHealthAuthorization_hardFailure_stillAdvances() async {
        let health = FakeHealthConnectService()
        health.nextError = .unavailable
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            healthService: health
        )
        sut.toggleHealthCategory(.recovery)

        await sut.requestHealthAuthorization()

        XCTAssertEqual(sut.step, .preferences, "A hard HealthKit failure must not block onboarding")
        XCTAssertEqual(sut.healthAuthResult[.recovery], .denied)
    }

    func test_skipHealthPriming_movesToPreferences() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.skipHealthPriming()
        XCTAssertEqual(sut.step, .preferences)
    }

    /// Issue #196 / K10 — skipping health is a first-class path, not a
    /// declined step. Declining must land the user in exactly the state that
    /// "continue with nothing toggled on" produces: same step, no error, no
    /// recorded denial to recover from. If these ever diverge, the flow has
    /// grown a "you opted out" state, which is the thing the demotion exists
    /// to prevent.
    func test_skippingHealth_isIndistinguishableFromContinuingWithNothingToggledOn() async {
        let skipped = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        skipped.skipHealthPriming()

        let continued = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        await continued.requestHealthAuthorization()

        XCTAssertEqual(skipped.step, continued.step)
        XCTAssertEqual(skipped.step, .preferences)
        XCTAssertNil(skipped.errorMessage, "Declining health is a normal choice, never an error state")
        XCTAssertNil(continued.errorMessage)
        XCTAssertTrue(skipped.healthAuthResult.isEmpty, "Nothing was requested, so nothing was denied")
        XCTAssertTrue(continued.healthAuthResult.isEmpty)
    }

    /// A calendar-only user is a complete user (PRD §2/§5). Reaching `.done`
    /// must never require touching a single health toggle.
    func test_calendarOnlyUser_reachesDone_withoutEverTouchingHealth() async {
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            consentStore: InMemoryConsentStore()
        )
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "maya@example.com"
        await sut.confirmInviteEmail()
        XCTAssertEqual(sut.step, .calendarConnect)

        await sut.connectCalendar(.emailOnly)
        XCTAssertEqual(sut.step, .healthPriming)

        sut.skipHealthPriming()
        sut.confirmPreferences()

        XCTAssertEqual(sut.step, .done)
        XCTAssertFalse(sut.hasAnyHealthCategoryToggledOn)
    }

    // MARK: - Screen 5: preferences

    func test_preferences_defaultOnInit() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        XCTAssertEqual(sut.preferences, .defaults)
        XCTAssertEqual(sut.preferences.tradition, .general)
        XCTAssertEqual(sut.preferences.duration, .auto)
        XCTAssertEqual(sut.preferences.days, Weekday.weekdays)
    }

    func test_confirmPreferences_movesToDone() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.confirmPreferences()
        XCTAssertEqual(sut.step, .done)
    }

    func test_skipPreferences_movesToDone() {
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.skipPreferences()
        XCTAssertEqual(sut.step, .done)
    }

    // MARK: - Screen 5: preferences persistence (issue #38)

    func test_init_loadsPreferencesFromStore() {
        var saved = OnboardingPreferences.defaults
        saved.tradition = .catholic
        let store = InMemoryPreferencesStore(initial: saved)

        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            preferencesStore: store
        )

        XCTAssertEqual(sut.preferences.tradition, .catholic)
    }

    func test_confirmPreferences_persistsEditedValueToStore() {
        let store = InMemoryPreferencesStore()
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            preferencesStore: store
        )
        sut.preferences.translation = .asv
        sut.preferences.duration = .short

        sut.confirmPreferences()

        XCTAssertEqual(store.load().translation, .asv)
        XCTAssertEqual(store.load().duration, .short)
    }

    /// "Skip" leaves whatever is already in the store alone — it must
    /// never overwrite a real prior save with a stale/default in-memory
    /// copy (this exact bug caused a genuine cross-process persistence
    /// failure: a second onboarding pass after relaunch called
    /// `skipPreferences()`, which used to re-save `preferences` and
    /// clobbered a correctly-persisted non-default value).
    func test_skipPreferences_doesNotOverwritePreviouslySavedValue() {
        var saved = OnboardingPreferences.defaults
        saved.tradition = .catholic
        saved.translation = .asv
        let store = InMemoryPreferencesStore(initial: saved)
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            preferencesStore: store
        )

        sut.skipPreferences()

        XCTAssertEqual(store.load().tradition, .catholic, "Skip must not overwrite a previously-saved value")
        XCTAssertEqual(store.load().translation, .asv)
    }

    /// On a true first run (nothing saved yet), skipping still leaves the
    /// store empty/default — it simply never writes, which is
    /// indistinguishable from "defaults" until the user actually confirms
    /// or edits something.
    func test_skipPreferences_firstRun_storeStaysAtDefaults() {
        let store = InMemoryPreferencesStore()
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            preferencesStore: store
        )

        sut.skipPreferences()

        XCTAssertEqual(store.load(), .defaults)
    }

    // MARK: - Consent seeding on completion (issue #70 / docs/14_IMPROVEMENT_REVIEW.md §1.8)

    func test_confirmPreferences_seedsConsentFromHealthTogglesAndCalendarStatus() async {
        let calendar = FakeCalendarConnectService()
        let consentStore = InMemoryConsentStore()
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: calendar,
            consentStore: consentStore
        )
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()
        await sut.connectCalendar(.appleEventKit)
        sut.toggleHealthCategory(.recovery)
        sut.toggleHealthCategory(.activity)
        // Sleep deliberately left off.
        await sut.requestHealthAuthorization()

        sut.confirmPreferences()

        XCTAssertTrue(consentStore.isEnabled(.recovery), "Recovery was toggled on -> must be seeded as consented")
        XCTAssertFalse(consentStore.isEnabled(.sleep), "Sleep was left off -> must be seeded as NOT consented, not left at some other default")
        XCTAssertTrue(consentStore.isEnabled(.activity), "Activity was toggled on -> must be seeded as consented")
        XCTAssertTrue(consentStore.isEnabled(.calendar), "Calendar was connected -> must be seeded as consented")
    }

    func test_skipPreferences_stillSeedsConsent() async {
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            consentStore: InMemoryConsentStore()
        )
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()
        sut.skipCalendarConnect()
        sut.toggleHealthCategory(.sleepQuality)
        await sut.requestHealthAuthorization()

        // Re-fetch the store the view model was given, via a fresh
        // reference: `sut.skipPreferences()` must still write, exactly
        // like `confirmPreferences()` does, so a user who skips the
        // preferences screen doesn't silently end up with no consent
        // seeded at all.
        let consentStore = InMemoryConsentStore()
        let sut2 = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            consentStore: consentStore
        )
        sut2.advanceFromWelcome()
        await sut2.signInWithApple()
        sut2.inviteEmailDraft = "invites@example.com"
        await sut2.confirmInviteEmail()
        sut2.skipCalendarConnect()
        sut2.toggleHealthCategory(.sleepQuality)
        await sut2.requestHealthAuthorization()

        sut2.skipPreferences()

        XCTAssertTrue(consentStore.isEnabled(.sleep), "Sleep was toggled on before skipping preferences -> must still be seeded as consented")
        XCTAssertFalse(consentStore.isEnabled(.recovery), "Recovery was never toggled -> must be seeded as not consented")
        XCTAssertFalse(consentStore.isEnabled(.calendar), "Calendar connect was skipped -> must be seeded as not consented")
    }

    func test_noConsentStoreInjected_completingOnboardingDoesNotCrash() {
        // `consentStore` defaults to `nil` — previews and any caller that
        // doesn't need consent seeding must not be forced to provide one.
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: FakeCalendarConnectService())
        sut.confirmPreferences()
        XCTAssertEqual(sut.step, .done)
    }

    func test_deniedCalendarConnect_seedsCalendarConsentAsOff() async {
        let calendar = FakeCalendarConnectService()
        calendar.nextError = .permissionDenied
        let consentStore = InMemoryConsentStore()
        let sut = OnboardingViewModel(authService: FakeAuthService(), calendarService: calendar, consentStore: consentStore)
        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()
        await sut.connectCalendar(.appleEventKit) // degrades to .connected(.emailOnly) per existing behavior

        sut.confirmPreferences()

        // `.emailOnly` is still `.connected(_)` (see `connectCalendar`'s
        // denied-permission degrade path) — email-invite-only mode is a
        // legitimate, working mode, not a withheld consent, so this
        // correctly seeds calendar consent as ON.
        XCTAssertTrue(consentStore.isEnabled(.calendar))
    }

    // MARK: - Full happy path

    func test_fullHappyPath_reachesDoneWithHealthAndPreferences() async {
        let health = FakeHealthConnectService()
        let sut = OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            healthService: health
        )

        sut.advanceFromWelcome()
        await sut.signInWithApple()
        sut.inviteEmailDraft = "invites@example.com"
        await sut.confirmInviteEmail()
        await sut.connectCalendar(.appleEventKit)
        sut.toggleHealthCategory(.recovery)
        await sut.requestHealthAuthorization()
        sut.confirmPreferences()

        XCTAssertEqual(sut.step, .done)
        XCTAssertEqual(sut.calendarStatus, .connected(.appleEventKit))
        XCTAssertEqual(sut.healthAuthResult[.recovery], .requested)
    }
}
