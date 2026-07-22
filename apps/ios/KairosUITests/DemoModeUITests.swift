import XCTest

/// UI test for issue #41 / EPIC E8 (demo/fixture mode) — walks the visible
/// slice of the docs/05_UX_FLOWS.md §8 judge-facing arc through the real
/// app UI in demo mode: Home renders the fixture's band phrases and
/// next-devotional card, and tapping into the devotional detail renders the
/// fixture's real verse text, attribution, and transcript body (not
/// placeholder copy). No live HealthKit/EventKit/network/LLM dependency —
/// demo mode backs every service with fakes and loads
/// `fixtures/snapshots/low_poor_heavy.json` directly (docs/00_FOUNDATION.md
/// §11).
///
/// Reuses the exact onboarding-skip helper pattern already proven reliable
/// in `HomeBandRefreshUITests`/`OnboardingFlowUITests` rather than inventing
/// a new driving approach, per this task's anti-thrashing guidance.
final class DemoModeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-UITEST_MODE", "1"]
    }

    /// The full visible arc: Home shows real fixture band phrases and a
    /// next-devotional card -> tapping the card opens devotional detail ->
    /// detail shows the real fixture verse, attribution, transcript body,
    /// and prayer (not placeholder text).
    func test_demoModeArc_homeShowsFixtureBands_detailShowsFixtureVerseAndTranscript() {
        completeOnboardingSkippingEverything()

        // --- Home: fixture band phrases render (docs/05_UX_FLOWS.md §8
        // t=0-5s: "your body is asking for gentleness · sleep was short
        // last night · today looks heavy" for the low_poor_heavy fixture).
        // Asserted directly on the `staticTexts` (what a judge/screen-reader
        // actually sees) rather than first requiring the wrapping "Other"
        // accessibility-container element to resolve — the container query
        // is redundant with (and flakier than) checking its labeled
        // children directly. ---
        XCTAssertTrue(app.staticTexts["your body is asking for gentleness"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["sleep was short last night"].exists)
        XCTAssertTrue(app.staticTexts["today looks heavy"].exists)

        // --- Home: next-devotional card shows the fixture's real
        // cardSummary (verbatim from fixtures/snapshots/low_poor_heavy.json),
        // not placeholder text. ---
        let card = app.buttons["home.nextDevotionalCard"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts["Come to Me, weary one — Jesus offers rest for a heavy-laden day. Matthew 11:28-30."].exists,
            "Home card must show the real fixture cardSummary verbatim"
        )

        // --- Tap "Join" -> devotional detail. ---
        card.tap()

        // --- Devotional detail: real fixture verse text + attribution +
        // transcript + prayer render (docs/05_UX_FLOWS.md §3.1 "Devotional
        // detail" / §8 t=18-28s "tap Join" beat). ---
        let verseText = app.staticTexts["devotionalDetail.verseText"]
        XCTAssertTrue(verseText.waitForExistence(timeout: 10))
        XCTAssertEqual(
            verseText.label,
            "Come to Me, all you who labor and are heavy-laden, and I will give you rest. Take My yoke upon you and learn from Me, for I am gentle and humble in heart, and you will find rest for your souls. For My yoke is easy and My burden is light."
        )

        let attribution = app.staticTexts["devotionalDetail.attribution"]
        XCTAssertTrue(attribution.exists)
        XCTAssertEqual(attribution.label, "Berean Standard Bible (BSB). Public domain.")

        let transcript = app.staticTexts["devotionalDetail.transcript"]
        XCTAssertTrue(transcript.exists)
        XCTAssertTrue(transcript.label.contains("Your body kept score last night"))

        let prayer = app.staticTexts["devotionalDetail.prayer"]
        XCTAssertTrue(prayer.exists)
        XCTAssertTrue(prayer.label.contains("Jesus, I'm running on empty"))

        // --- "Tap join -> audio plays" beat: play control present and
        // toggles to a Pause state on tap. ---
        let playButton = app.buttons["devotionalDetail.playButton"]
        XCTAssertTrue(playButton.exists)
        playButton.tap()
        XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout: 5))

        // --- "Amen — mark complete" closes the arc quietly (P2, zero guilt). ---
        let completeButton = app.buttons["devotionalDetail.completeButton"]
        XCTAssertTrue(completeButton.exists)
        completeButton.tap()
        XCTAssertTrue(app.buttons["Completed \u{2713}"].waitForExistence(timeout: 5))
    }

    // MARK: - Helpers

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

    private func type(_ text: String, into field: XCUIElement, retries: Int = 3) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "\(field) never appeared")
        for attempt in 1...retries {
            field.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            if (field.value as? String) != nil {
                field.typeText(text)
                if let value = field.value as? String, value.contains(text) || value != field.placeholderValue {
                    return
                }
            }
            if attempt == retries {
                field.typeText(text)
            }
        }
    }

    /// Fastest path from launch to the Home tab: sign in, skip every
    /// optional onboarding step, land on Done, continue into the tab shell.
    /// Identical to the helper in `HomeBandRefreshUITests` — kept local
    /// (rather than shared) to match this codebase's existing per-file
    /// helper-duplication convention for UI tests.
    private func completeOnboardingSkippingEverything() {
        app.launch()
        app.buttons["welcome.getStarted"].tap()
        app.buttons["signIn.showEmailFallback"].tap()

        type("test@example.com", into: app.textFields["signIn.emailField"])
        type("longenoughpassword", into: app.secureTextFields["signIn.passwordField"])
        app.buttons["signIn.emailContinue"].tap()

        XCTAssertTrue(app.staticTexts["inviteEmail.headline"].waitForExistence(timeout: 15))
        app.buttons["inviteEmail.confirm"].tap()

        XCTAssertTrue(app.buttons["calendarConnect.skip"].waitForExistence(timeout: 10))
        app.buttons["calendarConnect.skip"].tap()

        XCTAssertTrue(app.buttons["healthPriming.skip"].waitForExistence(timeout: 10))
        app.buttons["healthPriming.skip"].tap()

        XCTAssertTrue(app.navigationBars["Preferences"].waitForExistence(timeout: 10))
        tapAfterScrollingIntoView(app.buttons["preferencesCapture.skip"])

        XCTAssertTrue(app.buttons["done.continue"].waitForExistence(timeout: 10))
        app.buttons["done.continue"].tap()

        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
    }
}
