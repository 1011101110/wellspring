import XCTest

/// UI coverage for the day-of-week circle selector (K3, issue #189) on both
/// screens that render it: the onboarding capture screen and the F7
/// Preferences screen.
///
/// These tests lean on the accessibility layer on purpose. `isSelected` here
/// is XCUITest reading the `.isSelected` accessibility trait — the very same
/// signal VoiceOver speaks as "Monday, selected". A circle drawn with the
/// right tint but without the trait would look correct in a screenshot, be
/// unreadable to VoiceOver, and fail these assertions. That is the intended
/// coupling: the tests cannot pass unless the control is genuinely
/// accessible, which is the part of #189 that carries the risk.
///
/// What these tests deliberately do NOT cover, because XCUITest cannot
/// observe it: contrast ratios, whether selection remains legible in
/// grayscale, and whether the row wraps rather than clips at accessibility
/// text sizes. Those are manual checks (docs/07 §6's physical-device pass) —
/// iOS has no `session-a11y` equivalent, so the automated gate stops at
/// structure and state.
final class PreferencesDaysUITests: XCTestCase {
    private var app: XCUIApplication!

    /// `Weekday`'s raw values follow `Calendar.weekday` (Sunday = 1), which
    /// is what the accessibility identifiers are namespaced by.
    private enum DayID {
        static let sunday = "1"
        static let monday = "2"
        static let tuesday = "3"
        static let wednesday = "4"
        static let thursday = "5"
        static let friday = "6"
        static let saturday = "7"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-UITEST_MODE", "1"]
    }

    // MARK: - Onboarding capture screen

    /// Acceptance: "Circle row replaces toggle rows, defaults Mon–Fri."
    ///
    /// Asserting the buttons are `buttons` (not `switches`) is the load-bearing
    /// half — it is what proves the seven `Toggle` rows are actually gone
    /// rather than merely restyled.
    func test_captureScreen_showsSevenDayCircles_defaultingToMondayThroughFriday() {
        reachPreferencesCaptureScreen()

        for day in [DayID.monday, DayID.tuesday, DayID.wednesday, DayID.thursday, DayID.friday] {
            let circle = app.buttons["preferencesCapture.day.\(day)"]
            XCTAssertTrue(circle.exists, "Day \(day) should render as a circle button")
            XCTAssertTrue(circle.isSelected, "Mon–Fri is the schema default and must be preselected")
        }

        for day in [DayID.saturday, DayID.sunday] {
            let circle = app.buttons["preferencesCapture.day.\(day)"]
            XCTAssertTrue(circle.exists, "Day \(day) should render as a circle button")
            XCTAssertFalse(circle.isSelected, "Weekend days are off by default")
        }

        XCTAssertEqual(
            app.switches.matching(identifier: "preferencesCapture.day.\(DayID.monday)").count, 0,
            "The day rows must no longer be Toggles — #189 replaces them outright"
        )
    }

    /// Acceptance: "VoiceOver announces day + selected state."
    ///
    /// The label must be the whole word: the drawn row reads M T W T F S S,
    /// where the two Ts and two Ss are distinguishable only by position — a
    /// cue that does not survive being spoken.
    func test_captureScreen_dayCircles_announceFullDayNamesNotInitials() {
        reachPreferencesCaptureScreen()

        XCTAssertEqual(app.buttons["preferencesCapture.day.\(DayID.tuesday)"].label, "Tuesday")
        XCTAssertEqual(app.buttons["preferencesCapture.day.\(DayID.thursday)"].label, "Thursday")
        XCTAssertEqual(app.buttons["preferencesCapture.day.\(DayID.saturday)"].label, "Saturday")
        XCTAssertEqual(app.buttons["preferencesCapture.day.\(DayID.sunday)"].label, "Sunday")
    }

    func test_captureScreen_tappingACircle_togglesItAndLeavesTheOthersAlone() {
        reachPreferencesCaptureScreen()

        let saturday = app.buttons["preferencesCapture.day.\(DayID.saturday)"]
        saturday.tap()
        XCTAssertTrue(saturday.isSelected)

        saturday.tap()
        XCTAssertFalse(saturday.isSelected)

        XCTAssertTrue(
            app.buttons["preferencesCapture.day.\(DayID.monday)"].isSelected,
            "Toggling one day must not disturb the rest of the selection"
        )
    }

    // MARK: - Settings screen

    /// Acceptance: "UI test covers select/deselect round-trip to persisted
    /// `active_days`."
    ///
    /// Persistence is observed by leaving the Preferences tab and returning,
    /// which is the round-trip the F7 screen actually has to survive
    /// (docs/05 §3.1). A full process relaunch would be a stronger proof but
    /// would also reset the demo-mode onboarding state this flow depends on;
    /// the store-level write-through is asserted directly in
    /// `PreferencesStoreTests` instead.
    func test_settingsScreen_selectAndDeselect_survivesLeavingAndReturning() {
        completeOnboardingAndOpenPreferences()

        let saturday = app.buttons["preferences.day.\(DayID.saturday)"]
        XCTAssertTrue(saturday.waitForExistence(timeout: 10))
        XCTAssertFalse(saturday.isSelected)

        saturday.tap()
        XCTAssertTrue(saturday.isSelected)

        returnToPreferencesTab()
        XCTAssertTrue(
            app.buttons["preferences.day.\(DayID.saturday)"].isSelected,
            "A selected day must still be selected after navigating away and back"
        )

        app.buttons["preferences.day.\(DayID.saturday)"].tapWhenReady()
        XCTAssertFalse(app.buttons["preferences.day.\(DayID.saturday)"].isSelected)

        returnToPreferencesTab()
        XCTAssertFalse(
            app.buttons["preferences.day.\(DayID.saturday)"].isSelected,
            "A deselected day must stay deselected — the round-trip has to work in both directions"
        )
    }

    /// Acceptance: the last-day rule (#189, and #188's `activeDays: []` 400).
    ///
    /// Reducing to a single day and tapping it must leave that day selected.
    /// The failure this guards against is not a crash but a *repair*: without
    /// the guard, `validated()` would swap the empty set for Mon–Fri and the
    /// user would watch one tap select five days.
    func test_settingsScreen_refusesToDeselectTheLastRemainingDay() {
        completeOnboardingAndOpenPreferences()

        let monday = app.buttons["preferences.day.\(DayID.monday)"]
        XCTAssertTrue(monday.waitForExistence(timeout: 10))

        for day in [DayID.tuesday, DayID.wednesday, DayID.thursday, DayID.friday] {
            app.buttons["preferences.day.\(day)"].tapWhenReady()
        }
        XCTAssertTrue(monday.isSelected, "Monday should be the only day left selected")

        monday.tap()

        XCTAssertTrue(
            monday.isSelected,
            "Deselecting the only remaining day is refused — an empty day set is a 400 from the API since #188"
        )
        for day in [DayID.tuesday, DayID.wednesday, DayID.thursday, DayID.friday] {
            XCTAssertFalse(
                app.buttons["preferences.day.\(day)"].isSelected,
                "The refusal must be inert — it must NOT fall back to repopulating Mon–Fri"
            )
        }
    }

    /// The rule is stated before it is hit, rather than surfacing only as a
    /// tap that appears to do nothing.
    func test_settingsScreen_showsTheMinimumOneDayNoticeUpFront() {
        completeOnboardingAndOpenPreferences()

        XCTAssertTrue(
            app.staticTexts["preferences.days.minimumNotice"].waitForExistence(timeout: 10),
            "The one-day minimum should be visible before the user runs into it"
        )
    }

    // MARK: - Helpers

    private func reachPreferencesCaptureScreen() {
        signInAndAdvanceToPreferences()
        XCTAssertTrue(app.navigationBars["Preferences"].waitForExistence(timeout: 10))
    }

    private func completeOnboardingAndOpenPreferences() {
        signInAndAdvanceToPreferences()

        XCTAssertTrue(app.navigationBars["Preferences"].waitForExistence(timeout: 10))
        tapAfterScrollingIntoView(app.buttons["preferencesCapture.skip"])

        XCTAssertTrue(app.buttons["done.continue"].waitForExistence(timeout: 10))
        app.buttons["done.continue"].tapWhenReady()

        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Preferences"].tap()
    }

    private func returnToPreferencesTab() {
        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(app.tabBars.buttons["Preferences"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Preferences"].tap()
    }

    private func signInAndAdvanceToPreferences() {
        app.launch()
        app.buttons["welcome.getStarted"].tapWhenReady()
        app.buttons["signIn.showEmailFallback"].tapWhenReady()

        type("test@example.com", into: app.textFields["signIn.emailField"])
        type("longenoughpassword", into: app.secureTextFields["signIn.passwordField"])
        app.buttons["signIn.emailContinue"].tapWhenReady()

        // Generous timeout: follows an async sign-in call, which on a loaded
        // CI simulator host takes noticeably longer than a same-screen wait.
        XCTAssertTrue(app.staticTexts["inviteEmail.headline"].waitForExistence(timeout: 15))
        app.buttons["inviteEmail.confirm"].tapWhenReady()

        XCTAssertTrue(app.buttons["calendarConnect.skip"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.skip"].tapWhenReady()

        XCTAssertTrue(app.buttons["healthPriming.skip"].waitForExistence(timeout: 10))
        app.buttons["healthPriming.skip"].tapWhenReady()
    }

    /// The preferences screen is a long `Form`; elements below the fold can
    /// be absent from the accessibility snapshot entirely (not merely
    /// offscreen), so a plain `.tap()` fails with "No matches found" rather
    /// than just being slow. Mirrors the helper in `OnboardingFlowUITests`.
    private func tapAfterScrollingIntoView(_ element: XCUIElement, maxSwipes: Int = 8) {
        for _ in 0..<maxSwipes {
            if element.exists && element.isHittable {
                element.tap()
                return
            }
            app.swipeUp()
        }
        XCTAssertTrue(element.waitForExistence(timeout: 5), "\(element) never became reachable after scrolling")
        element.tap()
    }

    /// Taps a text field and types into it, retrying if the field does not
    /// pick up keyboard focus on the first attempt (freshly booted
    /// simulators routinely miss the initial tap-to-focus).
    private func type(_ text: String, into field: XCUIElement, retries: Int = 3) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "\(field) never appeared")
        for attempt in 1...retries {
            field.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            if (field.value as? String) != nil {
                field.typeText(text)
                return
            }
            if attempt == retries {
                field.typeText(text)
            }
        }
    }
}
