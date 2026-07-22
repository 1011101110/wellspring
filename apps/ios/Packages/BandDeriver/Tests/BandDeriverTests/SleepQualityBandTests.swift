import XCTest
@testable import BandDeriver

final class SleepQualityBandTests: XCTestCase {

    // MARK: - Missing data → sensible default

    func test_noSleepData_defaultsToFair() {
        let result = BandDeriver.deriveSleepQuality(sleep: nil)
        XCTAssertEqual(result, .fair)
    }

    // MARK: - Duration boundaries
    // poor: asleep < 5h (300 min)
    // fair: 5h <= asleep < 7h, OR >=7h but fails efficiency/restorative checks
    // good: asleep >= 7h (420 min) AND efficiency >= 0.85 AND restorative >= 0.30

    func test_asleepJustUnderPoorBoundary_isPoor() {
        // 299 minutes asleep, well under 300.
        let sleep = SleepStageDurations(
            remMinutes: 60, coreMinutes: 200, deepMinutes: 39, awakeMinutes: 0
        )
        XCTAssertEqual(sleep.asleepMinutes, 299)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .poor)
    }

    func test_asleepExactlyAtPoorBoundary_isFair() {
        // Exactly 300 minutes (5h) asleep == poor boundary is EXCLUSIVE
        // (< is poor), so 300 should NOT be poor.
        let sleep = SleepStageDurations(
            remMinutes: 60, coreMinutes: 200, deepMinutes: 40, awakeMinutes: 0
        )
        XCTAssertEqual(sleep.asleepMinutes, 300)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .fair)
    }

    func test_asleepJustUnderGoodBoundary_isFair() {
        // 419 minutes asleep, just under the 420-minute good-duration cutoff.
        let sleep = SleepStageDurations(
            remMinutes: 100, coreMinutes: 219, deepMinutes: 100, awakeMinutes: 0
        )
        XCTAssertEqual(sleep.asleepMinutes, 419)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .fair)
    }

    func test_asleepExactlyAtGoodDurationBoundary_withGoodStagesAndEfficiency_isGood() {
        // 420 minutes asleep, no awake time (efficiency 1.0), restorative
        // fraction (deep+rem)/asleep = (150+120)/420 = 0.643 >= 0.30.
        let sleep = SleepStageDurations(
            remMinutes: 120, coreMinutes: 150, deepMinutes: 150, awakeMinutes: 0
        )
        XCTAssertEqual(sleep.asleepMinutes, 420)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .good)
    }

    // MARK: - Efficiency boundary (asleep / totalSession >= 0.85)

    func test_efficiencyExactlyAtBoundary_isGood() {
        // asleep = 425.5 min (>=420), awake = 75 min → total 500.5,
        // efficiency = 425.5/500.5 = 0.85 exactly (chosen to land on boundary).
        // restorative = (150+120)/425.5 = 0.634 >= 0.30
        let asleep = 425.5
        let total = asleep / 0.85
        let awake = total - asleep
        let sleep = SleepStageDurations(
            remMinutes: 120, coreMinutes: asleep - 120 - 150, deepMinutes: 150, awakeMinutes: awake
        )
        XCTAssertEqual(sleep.asleepMinutes, asleep, accuracy: 0.001)
        let efficiency = sleep.asleepMinutes / sleep.totalSessionMinutes
        XCTAssertEqual(efficiency, 0.85, accuracy: 0.0001)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .good)
    }

    func test_efficiencyJustBelowBoundary_isFair() {
        // Long enough asleep (450 min) but heavily fragmented: awake time
        // pushes efficiency under 0.85.
        let sleep = SleepStageDurations(
            remMinutes: 120, coreMinutes: 180, deepMinutes: 150, awakeMinutes: 200
        )
        let efficiency = sleep.asleepMinutes / sleep.totalSessionMinutes
        XCTAssertLessThan(efficiency, 0.85)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .fair)
    }

    // MARK: - Restorative-fraction boundary ((deep+rem)/asleep >= 0.30)

    func test_restorativeFractionExactlyAtBoundary_isGood() {
        // asleep = 450 min, deep+rem = 135 min → fraction exactly 0.30.
        // efficiency 1.0 (no awake time).
        let sleep = SleepStageDurations(
            remMinutes: 67.5, coreMinutes: 315, deepMinutes: 67.5, awakeMinutes: 0
        )
        XCTAssertEqual(sleep.asleepMinutes, 450, accuracy: 0.001)
        let restorative = (sleep.deepMinutes + sleep.remMinutes) / sleep.asleepMinutes
        XCTAssertEqual(restorative, 0.30, accuracy: 0.0001)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .good)
    }

    func test_restorativeFractionJustBelowBoundary_isFair() {
        // Long, efficient sleep but almost all light/core stage — should
        // not qualify as "good" without restorative (deep+REM) sleep.
        let sleep = SleepStageDurations(
            remMinutes: 60, coreMinutes: 360, deepMinutes: 60, awakeMinutes: 0
        )
        let restorative = (sleep.deepMinutes + sleep.remMinutes) / sleep.asleepMinutes
        XCTAssertLessThan(restorative, 0.30)
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .fair)
    }

    // MARK: - Outliers / degenerate input

    func test_zeroDurationSleepSession_isPoorNotCrashing() {
        let sleep = SleepStageDurations(
            remMinutes: 0, coreMinutes: 0, deepMinutes: 0, awakeMinutes: 0
        )
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .poor)
    }

    func test_negativeMinutesClampedToNonNegative_doesNotCrash() {
        // Defensive: HealthKit shouldn't hand us negatives, but a corrupted
        // sample must not crash or produce nonsense (e.g. negative asleep).
        let sleep = SleepStageDurations(
            remMinutes: -10, coreMinutes: -10, deepMinutes: -10, awakeMinutes: -10
        )
        XCTAssertEqual(BandDeriver.deriveSleepQuality(sleep: sleep), .poor)
    }

    func test_extremeOutlierDuration_doesNotCrash() {
        // Absurdly long "sleep session" (sensor/glitch) should still
        // resolve deterministically to a valid band, not trap.
        let sleep = SleepStageDurations(
            remMinutes: 100_000, coreMinutes: 100_000, deepMinutes: 100_000, awakeMinutes: 0
        )
        let result = BandDeriver.deriveSleepQuality(sleep: sleep)
        XCTAssertTrue([.poor, .fair, .good].contains(result))
        XCTAssertEqual(result, .good)
    }
}
