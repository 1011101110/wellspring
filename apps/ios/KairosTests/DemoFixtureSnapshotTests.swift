import XCTest
import BandDeriver
@testable import Kairos

/// Unit-level coverage for the demo-mode fixture pipeline (issue #41 / EPIC
/// E8): proves the bundled copy of `fixtures/snapshots/low_poor_heavy.json`
/// decodes into real, non-placeholder content and maps to the correct
/// on-device `HealthBands`. Deliberately a plain `XCTestCase` against the
/// decoder rather than a UI-driving test — fast and immune to simulator
/// flakiness, per this task's anti-thrashing guidance; the UI-level arc is
/// covered separately by `DemoModeUITests`.
final class DemoFixtureSnapshotTests: XCTestCase {

    func test_load_decodesRealDavidFixtureContent() throws {
        let snapshot = try DemoFixtureLoader.load(bundle: .main)

        XCTAssertEqual(snapshot.fixtureKey, "low_poor_heavy")
        XCTAssertEqual(snapshot.bands.recovery, .low)
        XCTAssertEqual(snapshot.bands.sleepQuality, .poor)
        XCTAssertEqual(snapshot.bands.busyness, "heavy")
        XCTAssertFalse(snapshot.bands.distressSignal)

        // Real fixture content, not placeholder/lorem-ipsum text.
        XCTAssertEqual(snapshot.devotionalOutput.format, "micro")
        XCTAssertEqual(snapshot.devotionalOutput.theme, "rest")
        XCTAssertEqual(snapshot.devotionalOutput.verses.first?.usfm, "MAT.11.28-MAT.11.30")
        XCTAssertTrue(snapshot.devotionalOutput.verses.first?.fetchedText.contains("Come to Me, all you who labor and are heavy-laden") ?? false)
        XCTAssertEqual(snapshot.devotionalOutput.verses.first?.attribution, "Berean Standard Bible (BSB). Public domain.")
        XCTAssertTrue(snapshot.devotionalOutput.devotionalBody.contains("Your body kept score last night"))
        XCTAssertTrue(snapshot.devotionalOutput.cardSummary.contains("Come to Me, weary one"))

        // actionStep is nil, not present: Foundation §6 reserves actionStep for
        // standard/extended formats only, and this fixture is "micro" — the
        // stray field was removed from the fixture as part of issue #90.
        XCTAssertNil(snapshot.devotionalOutput.actionStep)
    }

    func test_healthBands_derivesCorrectTripleFromFixture() throws {
        let snapshot = try DemoFixtureLoader.load(bundle: .main)

        XCTAssertEqual(
            snapshot.healthBands,
            HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        )
    }

    func test_load_unknownFixtureName_throwsResourceNotFound() {
        XCTAssertThrowsError(try DemoFixtureLoader.load("does_not_exist", bundle: .main)) { error in
            XCTAssertEqual(error as? DemoFixtureLoader.LoadError, .resourceNotFound("does_not_exist"))
        }
    }

    /// Demo mode wires the fixture in automatically (no separate opt-in
    /// screen needed beyond the demo-mode toggle itself) — proven at the
    /// `AppEnvironment` composition-root level rather than via UI, per the
    /// anti-thrashing preference for unit-level coverage where it proves the
    /// same behavior.
    @MainActor
    func test_appEnvironment_demoMode_loadsFixture() {
        let env = AppEnvironment(isDemoMode: true)

        XCTAssertNotNil(env.demoFixture)
        XCTAssertEqual(env.demoFixture?.fixtureKey, "low_poor_heavy")
    }

    @MainActor
    func test_appEnvironment_nonDemoMode_hasNoFixture() {
        let env = AppEnvironment(
            authService: AnyAuthService(FakeAuthService()),
            calendarService: FakeCalendarConnectService(),
            healthService: FakeHealthConnectService(),
            isDemoMode: false
        )

        XCTAssertNil(env.demoFixture)
    }
}
