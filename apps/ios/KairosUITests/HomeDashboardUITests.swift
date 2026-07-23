import XCTest

/// Smoke tests for the signed-in Home dashboard (issue #252). Launches with
/// `-UITEST_ONBOARDING_COMPLETE` so the app starts signed-in + onboarded on
/// the Home tab (demo services, no live network), then asserts each card is
/// present as we scroll. Also captures full-screen screenshots as attachments
/// for visual review.
final class HomeDashboardUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-UITEST_MODE", "1", "-UITEST_ONBOARDING_COMPLETE", "1"]
    }

    private func snapshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func test_dashboard_showsEveryCard() {
        app.launch()

        // Lands on Home, not onboarding.
        XCTAssertTrue(app.staticTexts["home.today.theme"].waitForExistence(timeout: 15),
                      "Should start on the Home dashboard, not onboarding")
        XCTAssertTrue(app.buttons["home.today.openButton"].exists)
        XCTAssertTrue(app.staticTexts["home.today.attribution"].exists,
                      "The featured verse must carry its attribution (Foundation §4.3)")
        snapshot("01-top-today-upcoming")

        // Coming up.
        XCTAssertTrue(app.staticTexts["Coming up"].exists)

        // Scroll and confirm the mid cards.
        app.swipeUp(); app.swipeUp()
        snapshot("02-calendar-invite-journal")
        XCTAssertTrue(app.staticTexts["Calendar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Your journal"].exists)
        XCTAssertTrue(app.textViews["home.journal.field"].exists)

        // Scroll to the lower cards.
        app.swipeUp(); app.swipeUp()
        snapshot("03-history-recap-comingsoon")
        XCTAssertTrue(app.staticTexts["Your devotionals"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coming to Wellspring"].exists)

        // The distress front door (#77) is preserved at the bottom.
        app.swipeUp()
        snapshot("04-bottom-distress")
        XCTAssertTrue(app.buttons["home.distressCheckinButton"].exists)
    }

    /// Tapping "Open today's devotional" pushes the native in-app reader (#3),
    /// not a web session — the reader shows the real verse + transcript.
    func test_openingTodaysDevotional_pushesNativeReader() {
        app.launch()
        let openButton = app.buttons["home.today.openButton"]
        XCTAssertTrue(openButton.waitForExistence(timeout: 15))
        openButton.tap()

        XCTAssertTrue(app.staticTexts["devotionalDetail.theme"].waitForExistence(timeout: 10),
                      "Should push the native reader")
        XCTAssertTrue(app.staticTexts["devotionalDetail.verseText"].exists)
        XCTAssertTrue(app.staticTexts["devotionalDetail.transcript"].exists)
        XCTAssertTrue(app.buttons["devotionalDetail.completeButton"].exists)
        snapshot("05-native-reader")
    }

    /// The free/busy "Your day" card (#6) renders on Home, and the History
    /// tab (#4) is now a full archive, not an empty placeholder.
    func test_freeBusyCard_andHistoryArchive() {
        app.launch()
        XCTAssertTrue(app.staticTexts["home.today.theme"].waitForExistence(timeout: 15))

        // Free/busy day card is present after scrolling.
        app.swipeUp(); app.swipeUp()
        XCTAssertTrue(app.staticTexts["Your day"].waitForExistence(timeout: 5), "The free/busy day card should render (#6)")
        snapshot("06-freebusy-card")

        // History tab is a real archive now.
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(app.navigationBars["Your devotionals"].waitForExistence(timeout: 10),
                      "History tab should be the full archive (#4), not the empty placeholder")
        XCTAssertFalse(app.staticTexts["history.emptyState"].exists, "should not show the old placeholder")
        snapshot("07-history-archive")
    }
}
