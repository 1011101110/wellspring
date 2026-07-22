import XCTest
@testable import BandDeriver

final class RecoveryBandTests: XCTestCase {

    private let refDate = Date(timeIntervalSince1970: 1_800_000_000)

    private func baseline(
        meanHRV: Double? = 45,
        stdDevHRV: Double? = 10,
        meanRestingHR: Double? = 60,
        days: Int = 30
    ) -> PersonalBaseline {
        PersonalBaseline(
            meanHRVMilliseconds: meanHRV,
            stdDevHRVMilliseconds: stdDevHRV,
            meanRestingHRBpm: meanRestingHR,
            meanDailySteps: 6000,
            meanDailyActiveEnergyKcal: 250,
            sampleDays: days
        )
    }

    private func hrv(_ ms: Double) -> [HRVSample] {
        [HRVSample(sdnnMilliseconds: ms, date: refDate)]
    }

    private func restingHR(_ bpm: Double) -> [RestingHRSample] {
        [RestingHRSample(beatsPerMinute: bpm, date: refDate)]
    }

    // MARK: - Missing data → sensible default

    func test_noHRVSamples_defaultsToModerate() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: [],
            recentRestingHR: [],
            baseline: .empty
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_noBaselineAtAll_usesPopulationFallback() {
        // Below population low threshold (25ms) → low even with zero baseline.
        let low = BandDeriver.deriveRecovery(
            recentHRV: hrv(20),
            recentRestingHR: [],
            baseline: .empty
        )
        XCTAssertEqual(low, .low)

        // Above population high threshold (60ms) → high.
        let high = BandDeriver.deriveRecovery(
            recentHRV: hrv(65),
            recentRestingHR: [],
            baseline: .empty
        )
        XCTAssertEqual(high, .high)

        // Between the two → moderate.
        let moderate = BandDeriver.deriveRecovery(
            recentHRV: hrv(40),
            recentRestingHR: [],
            baseline: .empty
        )
        XCTAssertEqual(moderate, .moderate)
    }

    // MARK: - Personal baseline z-score boundaries (mean 45, stddev 10)
    // high  : z >= 0.5   → hrv >= 50
    // low   : z <= -0.5  → hrv <= 40
    // moderate: strictly between

    func test_zScore_exactlyAtHighBoundary_isHigh() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(50.0), // z == 0.5 exactly
            recentRestingHR: [],
            baseline: baseline()
        )
        XCTAssertEqual(result, .high)
    }

    func test_zScore_justBelowHighBoundary_isModerate() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(49.9), // z == 0.49
            recentRestingHR: [],
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_zScore_exactlyAtLowBoundary_isLow() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(40.0), // z == -0.5 exactly
            recentRestingHR: [],
            baseline: baseline()
        )
        XCTAssertEqual(result, .low)
    }

    func test_zScore_justAboveLowBoundary_isModerate() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(40.1), // z == -0.49
            recentRestingHR: [],
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_zScore_atMean_isModerate() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(45.0), // z == 0
            recentRestingHR: [],
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    // MARK: - Insufficient baseline days falls back to population thresholds

    func test_baselineBelowMinimumDays_fallsBackToPopulationThresholds() {
        // Only 6 days of history (< minimumBaselineDays == 7); would be
        // "high" via personal z-score (z=2.0) but baseline isn't trusted,
        // so population thresholds apply: 46ms is between 25 and 60 → moderate.
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(46.0),
            recentRestingHR: [],
            baseline: baseline(days: 6)
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_baselineAtExactlyMinimumDays_isTrusted() {
        // Exactly minimumBaselineDays (7) → personal baseline should be used.
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(50.0), // z == 0.5 → high under personal baseline
            recentRestingHR: [],
            baseline: baseline(days: 7)
        )
        XCTAssertEqual(result, .high)
    }

    func test_baselineWithZeroStdDev_fallsBackToPopulationThresholds() {
        // stdDev of 0 would divide-by-zero under a naive z-score; must not
        // trust this baseline and must fall back to population thresholds.
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(46.0), // population moderate range
            recentRestingHR: [],
            baseline: baseline(stdDevHRV: 0)
        )
        XCTAssertEqual(result, .moderate)
    }

    // MARK: - Resting HR trend nudges recovery by one step (delta boundaries ±3bpm)

    func test_restingHR_exactlyAtElevatedBoundary_stepsDown() {
        // HRV alone would be moderate (z=0); resting HR +3bpm over baseline
        // (elevated boundary) should step recovery down to low.
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(45.0),
            recentRestingHR: restingHR(63.0), // baseline 60 + 3
            baseline: baseline()
        )
        XCTAssertEqual(result, .low)
    }

    func test_restingHR_justBelowElevatedBoundary_noNudge() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(45.0),
            recentRestingHR: restingHR(62.9), // baseline 60 + 2.9
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_restingHR_exactlyAtDepressedBoundary_stepsUp() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(45.0),
            recentRestingHR: restingHR(57.0), // baseline 60 - 3
            baseline: baseline()
        )
        XCTAssertEqual(result, .high)
    }

    func test_restingHR_cannotPushBeyondAdjacentBand() {
        // HRV already "high" (z >= 0.5); elevated resting HR should step
        // down only to moderate, not skip straight to low.
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(55.0), // z = 1.0 -> high
            recentRestingHR: restingHR(63.0), // elevated -> step down once
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)

        // HRV already "low"; elevated resting HR should not push it lower
        // than low (there is no lower band).
        let stillLow = BandDeriver.deriveRecovery(
            recentHRV: hrv(30.0), // z = -1.5 -> low
            recentRestingHR: restingHR(63.0),
            baseline: baseline()
        )
        XCTAssertEqual(stillLow, .low)
    }

    // MARK: - Outlier clamping

    func test_extremeOutlierHRV_isClampedNotCrashing() {
        // Absurd sensor glitch value, far above plausible range (300ms max).
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(999_999),
            recentRestingHR: [],
            baseline: baseline()
        )
        // Clamped to 300ms, still evaluated as high vs baseline z-score.
        XCTAssertEqual(result, .high)
    }

    func test_negativeOutlierHRV_isClampedNotCrashing() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(-500),
            recentRestingHR: [],
            baseline: baseline()
        )
        XCTAssertEqual(result, .low)
    }

    func test_extremeOutlierRestingHR_isClampedNotCrashing() {
        let result = BandDeriver.deriveRecovery(
            recentHRV: hrv(45.0),
            recentRestingHR: restingHR(9_999),
            baseline: baseline()
        )
        // Clamped to plausible max (220bpm), still elevated vs baseline -> step down.
        XCTAssertEqual(result, .low)
    }

    // MARK: - Uses latest sample when multiple present

    func test_usesMostRecentHRVSample() {
        let samples = [
            HRVSample(sdnnMilliseconds: 20, date: refDate.addingTimeInterval(-3600)),
            HRVSample(sdnnMilliseconds: 65, date: refDate) // latest, "high" range
        ]
        let result = BandDeriver.deriveRecovery(
            recentHRV: samples,
            recentRestingHR: [],
            baseline: .empty
        )
        XCTAssertEqual(result, .high)
    }
}
