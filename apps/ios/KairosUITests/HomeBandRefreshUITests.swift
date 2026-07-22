import XCTest

/// UI tests for the manual "Refresh now" trigger on Home (issue #37 / EPIC
/// E4: morning band upload) — driven through the real app UI in demo mode
/// (fake HealthKit/upload services, no live network/HealthKit dependency,
/// per docs/00_FOUNDATION.md §11). Covers both the "HealthKit data
/// available" happy path and the denied/no-health-data graceful
/// degradation path (docs/05_UX_FLOWS.md §3.1 Home: "Bands section shows
/// 'calendar-only today' without complaint").
final class HomeBandRefreshUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-UITEST_MODE", "1"]
    }

    func test_refreshNowButton_isReachableFromHome() {
        completeOnboardingSkippingEverything()

        XCTAssertTrue(app.buttons["home.refreshNowButton"].waitForExistence(timeout: 10))
    }

    func test_tappingRefreshNow_showsUpToDateStatus() {
        completeOnboardingSkippingEverything()

        let refreshButton = app.buttons["home.refreshNowButton"]
        XCTAssertTrue(refreshButton.waitForExistence(timeout: 10))
        refreshButton.tap()

        let status = app.staticTexts["home.bandStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "Today's bands are up to date.")
    }

    /// Denied-permission path: with HealthKit authorization simulated as
    /// denied, "Refresh now" must still complete without crashing or
    /// hanging. A denied *authorization* legitimately surfaces to
    /// `BandUploadService` as empty-but-present sample data (no HealthKit
    /// prompt was ever granted, so every query legitimately returns
    /// nothing).
    ///
    /// Issue #70 (docs/14_IMPROVEMENT_REVIEW.md §1.8) changed what happens
    /// next: `BandDeriver.deriveDerivedBands(from:)` maps this to an
    /// all-omitted `DerivedBands` (no evidence for any category) rather
    /// than the old, incorrect `deriveBands(from:)`-style fabricated
    /// neutral triple (see `BandUploadServiceTests
    /// .test_refreshAndUpload_deniedPermission_emptyInput_uploadsAllOmittedRequest_neverFabricates`,
    /// which replaces this test's old doc-referenced
    /// `..._stillDerivesNeutralBandsAndUploads` — a name that literally
    /// described the bug this issue fixes). Uploading an all-omitted
    /// payload is still a *successful* upload (there's nothing dishonest
    /// about correctly reporting zero evidence), so the button still
    /// completes successfully and shows the same "up to date" status here
    /// — this test's assertion doesn't change, but its rationale does: the
    /// status text is agnostic to *which* (if any) bands were actually
    /// included, and the neutral-fabrication bug this test used to
    /// (unknowingly) exercise is what issue #70 removed. The distinct
    /// "calendar-only" status text is reserved for a hard HealthKit *read*
    /// failure (store unavailable / query error), which is covered at the
    /// unit level in `BandUploadServiceTests` and cannot be triggered from
    /// this UI-level demo-mode harness without a dedicated launch flag.
    func test_tappingRefreshNow_withHealthDenied_stillCompletesWithoutError() {
        app.launchArguments += ["-UITEST_HEALTH_DENIED", "1"]
        completeOnboardingSkippingEverything()

        let refreshButton = app.buttons["home.refreshNowButton"]
        XCTAssertTrue(refreshButton.waitForExistence(timeout: 10))
        refreshButton.tap()

        let status = app.staticTexts["home.bandStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "Today's bands are up to date.", "Denied auth -> no HealthKit evidence -> an honest, all-omitted payload still uploads successfully (issue #70: never a fabricated neutral triple)")
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
