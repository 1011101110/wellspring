import XCTest
import BandDeriver
@testable import Kairos

/// Verifies the Kairos app target actually links and uses the local
/// BandDeriver Swift package (apps/ios/Packages/BandDeriver, issue #36),
/// and that phrase mapping matches docs/05_UX_FLOWS.md §3.2 exactly.
final class BandPhraseTests: XCTestCase {

    func test_recoveryPhrase_matchesUXSpec() {
        XCTAssertEqual(BandPhrase.recoveryPhrase(.high), "your body looks rested")
        XCTAssertEqual(BandPhrase.recoveryPhrase(.moderate), "you're doing okay")
        XCTAssertEqual(BandPhrase.recoveryPhrase(.low), "your body is asking for gentleness")
    }

    func test_sleepQualityPhrase_matchesUXSpec() {
        XCTAssertEqual(BandPhrase.sleepQualityPhrase(.good), "you slept well")
        XCTAssertEqual(BandPhrase.sleepQualityPhrase(.fair), "sleep was okay")
        XCTAssertEqual(BandPhrase.sleepQualityPhrase(.poor), "sleep was short last night")
    }

    func test_phrasesForHealthBands_returnsRecoveryThenSleep() {
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        let phrases = BandPhrase.phrases(for: bands)
        XCTAssertEqual(phrases, ["your body is asking for gentleness", "sleep was short last night"])
    }
}
