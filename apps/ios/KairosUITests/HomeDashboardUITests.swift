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
}
