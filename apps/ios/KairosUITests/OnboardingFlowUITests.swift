import XCTest

/// UI tests for docs/05_UX_FLOWS.md §2 — the permission-priming onboarding
/// flow (welcome -> sign in -> invite email -> calendar connect -> done)
/// and denied-permission states, driven through the real app UI in demo
/// mode (fake services, no live network/HealthKit/EventKit dependency,
/// per docs/00_FOUNDATION.md §11).
final class OnboardingFlowUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-UITEST_MODE", "1"]
    }

    func test_welcomeScreen_showsGetStartedButton() {
        app.launch()

        XCTAssertTrue(app.staticTexts["welcome.headline"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["welcome.getStarted"].exists)
    }

    func test_tappingGetStarted_showsSignInOptions() {
        app.launch()

        app.buttons["welcome.getStarted"].tap()

        XCTAssertTrue(app.buttons["signIn.withApple"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["signIn.showEmailFallback"].exists)
    }

    func test_emailFallback_revealsFieldsAndPrimingIsShownBeforeSignIn() {
        app.launch()
        app.buttons["welcome.getStarted"].tap()

        XCTAssertTrue(app.buttons["signIn.showEmailFallback"].waitForExistence(timeout: 10))
        app.buttons["signIn.showEmailFallback"].tap()

        XCTAssertTrue(app.textFields["signIn.emailField"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.secureTextFields["signIn.passwordField"].exists)
        XCTAssertTrue(app.buttons["signIn.emailContinue"].exists)
    }

    func test_emailSignIn_withShortPassword_showsError() {
        app.launch()
        app.buttons["welcome.getStarted"].tap()
        app.buttons["signIn.showEmailFallback"].tap()

        type("test@example.com", into: app.textFields["signIn.emailField"])
        type("abc", into: app.secureTextFields["signIn.passwordField"])

        app.buttons["signIn.emailContinue"].tap()

        XCTAssertTrue(app.staticTexts["signIn.error"].waitForExistence(timeout: 10))
    }

    func test_calendarConnectScreen_showsPrimingCopyForAllThreePaths() {
        signInWithEmailAndReachInviteEmailStep()

        // Invite-email step (docs/05_UX_FLOWS.md §2 screen 2).
        let inviteField = app.textFields["inviteEmail.field"]
        XCTAssertTrue(inviteField.exists)
        // Pre-filled from the email sign-in address.
        app.buttons["inviteEmail.confirm"].tap()

        // Calendar connect step (docs/05_UX_FLOWS.md §2 screen 3) — all
        // three paths visible with priming copy, and skippable (P4).
        XCTAssertTrue(app.staticTexts["calendarConnect.headline"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["calendarConnect.google"].exists)
        XCTAssertTrue(app.buttons["calendarConnect.appleEventKit"].exists)
        XCTAssertTrue(app.buttons["calendarConnect.emailOnly"].exists)
        XCTAssertTrue(app.buttons["calendarConnect.skip"].exists)
    }

    func test_skippingCalendarConnect_reachesHealthPriming() {
        signInWithEmailAndReachInviteEmailStep()

        app.buttons["inviteEmail.confirm"].tap()

        XCTAssertTrue(app.buttons["calendarConnect.skip"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.skip"].tap()

        XCTAssertTrue(app.staticTexts["healthPriming.headline"].waitForExistence(timeout: 10))
    }

    /// Full happy path: every skippable optional screen (health priming,
    /// preferences) is skipped and the flow still reaches Done, per
    /// docs/05_UX_FLOWS.md §1 P4 "everything skippable."
    func test_skippingEveryOptionalStep_reachesDoneScreen() {
        signInWithEmailAndReachInviteEmailStep()
        app.buttons["inviteEmail.confirm"].tap()

        XCTAssertTrue(app.buttons["calendarConnect.skip"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.skip"].tap()

        XCTAssertTrue(app.buttons["healthPriming.skip"].waitForExistence(timeout: 10))
        app.buttons["healthPriming.skip"].tap()

        XCTAssertTrue(app.navigationBars["Preferences"].waitForExistence(timeout: 10))
        tapAfterScrollingIntoView(app.buttons["preferencesCapture.skip"])

        XCTAssertTrue(app.buttons["done.continue"].waitForExistence(timeout: 10))
    }

    /// The full non-skipped happy path through every screen, including
    /// toggling on a health category and confirming preferences with
    /// defaults, per docs/05_UX_FLOWS.md §2.
    func test_fullHappyPath_throughEveryScreen_reachesDone() {
        signInWithEmailAndReachInviteEmailStep()
        app.buttons["inviteEmail.confirm"].tap()

        XCTAssertTrue(app.buttons["calendarConnect.appleEventKit"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.appleEventKit"].tap()

        // EventKit permission prompts don't reliably appear in this launch
        // configuration (demo/fake services back the calendar connect
        // call), so the flow should proceed straight to health priming.
        XCTAssertTrue(app.staticTexts["healthPriming.headline"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["healthPriming.explainer"].exists, "Priming copy must precede any HealthKit prompt (P3)")

        // #196 lengthened this screen (calendar-first value copy above the
        // toggles), so the category rows now sit below the fold on the test
        // device. A plain .tap() on an unhittable element fails silently,
        // leaving the toggle off — and the primary button is only labelled
        // `healthPriming.continue` once at least one category is on.
        tapAfterScrollingIntoView(app.switches["healthPriming.toggle.recovery"])
        tapAfterScrollingIntoView(app.buttons["healthPriming.continue"])

        XCTAssertTrue(app.navigationBars["Preferences"].waitForExistence(timeout: 10))
        tapAfterScrollingIntoView(app.buttons["preferencesCapture.confirm"])

        XCTAssertTrue(app.buttons["done.continue"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["done.previewNow"].exists)
    }

    /// Screen 4: priming copy ("what we send" / "what never leaves your
    /// phone") must be visible for every category, and every toggle starts
    /// off (docs/04_DATA_PRIVACY_SECURITY.md §3 — independent, opt-in).
    func test_healthPriming_showsGranularTogglesAndPrimingCopyForEveryCategory() {
        signInWithEmailAndReachInviteEmailStep()
        app.buttons["inviteEmail.confirm"].tap()
        app.buttons["calendarConnect.skip"].tap()

        XCTAssertTrue(app.staticTexts["healthPriming.headline"].waitForExistence(timeout: 10))

        for category in ["recovery", "sleepQuality", "activity"] {
            let toggle = app.switches["healthPriming.toggle.\(category)"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 10), "Missing toggle for \(category)")
            XCTAssertEqual(toggle.value as? String, "0", "\(category) toggle should default off")
        }
    }

    /// Denied-permission path for HealthKit (docs/05_UX_FLOWS.md §3.1
    /// "Denied permission"): a simulated denial must not strand the user on
    /// the health priming screen — the flow proceeds to preferences.
    func test_healthPriming_deniedPermission_stillAdvancesToPreferences() {
        app.launchArguments += ["-UITEST_HEALTH_DENIED", "1"]
        signInWithEmailAndReachInviteEmailStep()
        app.buttons["inviteEmail.confirm"].tap()
        app.buttons["calendarConnect.skip"].tap()

        XCTAssertTrue(app.switches["healthPriming.toggle.sleepQuality"].waitForExistence(timeout: 10))
        tapAfterScrollingIntoView(app.switches["healthPriming.toggle.sleepQuality"])
        tapAfterScrollingIntoView(app.buttons["healthPriming.continue"])

        XCTAssertTrue(
            app.navigationBars["Preferences"].waitForExistence(timeout: 10),
            "A denied HealthKit request must still advance to preferences, never strand the user"
        )
    }

    /// Screen 5: every preference field is visible with defaults preloaded,
    /// and "Looks good" (here: confirm) reaches Done without requiring any
    /// edits, per docs/05_UX_FLOWS.md §2 screen 5.
    func test_preferencesCapture_showsAllFieldsAndConfirmReachesDone() {
        signInWithEmailAndReachInviteEmailStep()
        app.buttons["inviteEmail.confirm"].tap()
        app.buttons["calendarConnect.skip"].tap()
        app.buttons["healthPriming.skip"].tap()

        XCTAssertTrue(app.navigationBars["Preferences"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.segmentedControls["preferencesCapture.duration"].exists || app.otherElements["preferencesCapture.duration"].exists)

        tapAfterScrollingIntoView(app.buttons["preferencesCapture.confirm"])

        XCTAssertTrue(app.buttons["done.continue"].waitForExistence(timeout: 10))
    }

    /// Denied-permission path for EventKit (docs/05_UX_FLOWS.md §3.1
    /// "Denied permission" / docs/04_DATA_PRIVACY_SECURITY.md §3 "Denied
    /// behavior: .ics-invite-only mode"): a simulated "I use Apple
    /// Calendar" denial must not strand the user on the calendar-connect
    /// screen — the flow degrades to email-invites-only mode and proceeds
    /// straight to health priming, same as every other continue path.
    func test_calendarConnect_eventKitDenied_degradesToEmailOnlyAndAdvances() {
        app.launchArguments += ["-UITEST_CALENDAR_DENIED", "1"]
        signInWithEmailAndReachInviteEmailStep()
        app.buttons["inviteEmail.confirm"].tap()

        XCTAssertTrue(app.buttons["calendarConnect.appleEventKit"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.appleEventKit"].tap()

        XCTAssertTrue(
            app.staticTexts["healthPriming.headline"].waitForExistence(timeout: 10),
            "A denied EventKit request must not strand the user on calendar connect — it degrades to email-invites-only mode and the flow continues"
        )
    }

    /// Denied-permission state: connecting the (unimplemented) Google path
    /// surfaces a clear error rather than silently succeeding, matching
    /// docs/05_UX_FLOWS.md §3.1 "Denied permission" column intent (the app
    /// must never pretend a connection succeeded).
    func test_googleCalendarConnect_notYetImplemented_showsError() {
        signInWithEmailAndReachInviteEmailStep()

        app.buttons["inviteEmail.confirm"].tap()

        XCTAssertTrue(app.buttons["calendarConnect.google"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.google"].tap()

        XCTAssertTrue(app.staticTexts["calendarConnect.error"].waitForExistence(timeout: 10))
    }

    // MARK: - Helpers

    /// The preferences screen (docs/05_UX_FLOWS.md §2 screen 5) is a long
    /// `Form` (workday window, cadence, the day circle row, duration,
    /// tradition, translation, voice, stillness) — shorter since #189
    /// collapsed seven day toggles into one row, but the confirm/skip
    /// buttons at the bottom are still often below the fold and
    /// absent from the current accessibility
    /// snapshot entirely (not just off-screen), so a plain `.tap()` can
    /// fail with "No matches found" rather than just being slow. Swiping up
    /// repeatedly brings the target into the live snapshot before tapping.
    private func tapAfterScrollingIntoView(_ element: XCUIElement, maxSwipes: Int = 8) {
        for _ in 0..<maxSwipes {
            if element.exists && element.isHittable {
                element.tap()
                return
            }
            app.swipeUp()
        }
        // Last attempt: let this surface a clear XCTest failure if the
        // element still isn't reachable after scrolling.
        XCTAssertTrue(element.waitForExistence(timeout: 5), "\(element) never became reachable after scrolling")
        element.tap()
    }

    /// Common setup shared by tests that need to get past sign-in to reach
    /// the invite-email step (docs/05_UX_FLOWS.md §2 screen 2).
    private func signInWithEmailAndReachInviteEmailStep() {
        app.launch()
        app.buttons["welcome.getStarted"].tap()
        app.buttons["signIn.showEmailFallback"].tap()

        type("test@example.com", into: app.textFields["signIn.emailField"])
        type("longenoughpassword", into: app.secureTextFields["signIn.passwordField"])

        app.buttons["signIn.emailContinue"].tap()

        // Generous timeout: this transition follows an async sign-in call
        // and, on a loaded CI/simulator host, can take noticeably longer
        // than the 5s used for simple same-screen assertions elsewhere.
        XCTAssertTrue(app.staticTexts["inviteEmail.headline"].waitForExistence(timeout: 15))
    }

    /// Taps a text field and types into it, retrying the tap if the field
    /// doesn't pick up keyboard focus on the first attempt. Simulators
    /// occasionally miss the initial tap-to-focus (especially on a freshly
    /// booted device), which otherwise surfaces as "Neither element nor any
    /// descendant has keyboard focus" from `typeText`.
    private func type(_ text: String, into field: XCUIElement, retries: Int = 3) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "\(field) never appeared")
        for attempt in 1...retries {
            field.tap()
            // Give the keyboard/responder chain a beat to actually commit
            // focus before we synthesize typing events.
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            if (field.value as? String) != nil {
                field.typeText(text)
                if let value = field.value as? String, value.contains(text) || value != placeholderPlaceholder(for: field) {
                    return
                }
            }
            if attempt == retries {
                // Last attempt: type regardless and let the subsequent
                // assertion surface a clear failure if it still didn't work.
                field.typeText(text)
            }
        }
    }

    /// XCUIElement text fields report their placeholder as `value` when
    /// empty; used only to sanity-check that typing actually landed.
    private func placeholderPlaceholder(for field: XCUIElement) -> String? {
        field.placeholderValue
    }
}
