import XCTest
@testable import BandDeriver

final class ActivityBandTests: XCTestCase {

    private func baseline(days: Int = 30) -> PersonalBaseline {
        PersonalBaseline(
            meanHRVMilliseconds: 45,
            stdDevHRVMilliseconds: 10,
            meanRestingHRBpm: 60,
            meanDailySteps: 6000,
            meanDailyActiveEnergyKcal: 250,
            sampleDays: days
        )
    }

    private func activity(steps: Double, energy: Double, workoutMinutes: Double = 0) -> ActivitySummary {
        ActivitySummary(steps: steps, activeEnergyBurnedKcal: energy, workoutMinutes: workoutMinutes)
    }

    // MARK: - Workout override

    func test_workoutAtExactly20Minutes_isActiveRegardlessOfBaseline() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 0, energy: 0, workoutMinutes: 20),
            baseline: .empty
        )
        XCTAssertEqual(result, .active)
    }

    func test_workoutJustUnder20Minutes_doesNotOverride() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 0, energy: 0, workoutMinutes: 19.9),
            baseline: .empty
        )
        // Falls through to population fallback: 0 steps/energy -> sedentary.
        XCTAssertEqual(result, .sedentary)
    }

    // MARK: - No baseline → population fallback boundaries

    func test_noBaseline_stepsExactlyAtSedentaryBoundary_isSedentary() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 3000, energy: 0),
            baseline: .empty
        )
        XCTAssertEqual(result, .sedentary)
    }

    func test_noBaseline_stepsJustAboveSedentaryBoundary_isModerate() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 3001, energy: 0),
            baseline: .empty
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_noBaseline_stepsExactlyAtActiveBoundary_isActive() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 8000, energy: 0),
            baseline: .empty
        )
        XCTAssertEqual(result, .active)
    }

    func test_noBaseline_stepsJustBelowActiveBoundary_isModerate() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 7999, energy: 100),
            baseline: .empty
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_noBaseline_energyExactlyAtActiveBoundary_isActive() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 0, energy: 400),
            baseline: .empty
        )
        XCTAssertEqual(result, .active)
    }

    func test_noBaseline_energyExactlyAtSedentaryBoundary_stepsAlsoSedentary_isSedentary() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 3000, energy: 150),
            baseline: .empty
        )
        XCTAssertEqual(result, .sedentary)
    }

    // MARK: - Personal baseline ratio boundaries (baseline steps 6000, energy 250)
    // active: combinedRatio >= 1.2
    // sedentary: combinedRatio <= 0.5
    // moderate: strictly between

    func test_baseline_combinedRatioExactlyAtActiveBoundary_isActive() {
        // steps ratio 1.2, energy ratio 1.2 -> combined 1.2 exactly.
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 7200, energy: 300),
            baseline: baseline()
        )
        XCTAssertEqual(result, .active)
    }

    func test_baseline_combinedRatioJustBelowActiveBoundary_isModerate() {
        // steps ratio 1.19, energy ratio 1.19 -> combined 1.19.
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 7140, energy: 297.5),
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_baseline_combinedRatioExactlyAtSedentaryBoundary_isSedentary() {
        // steps ratio 0.5, energy ratio 0.5 -> combined 0.5 exactly.
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 3000, energy: 125),
            baseline: baseline()
        )
        XCTAssertEqual(result, .sedentary)
    }

    func test_baseline_combinedRatioJustAboveSedentaryBoundary_isModerate() {
        // steps ratio 0.51, energy ratio 0.51 -> combined 0.51.
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 3060, energy: 127.5),
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    func test_baseline_combinedRatioAtOne_isModerate() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 6000, energy: 250),
            baseline: baseline()
        )
        XCTAssertEqual(result, .moderate)
    }

    // MARK: - Insufficient baseline days falls back to population thresholds

    func test_baselineBelowMinimumDays_fallsBackToPopulationThresholds() {
        // 6 days of history (< minimumBaselineDays 7); would be "active"
        // via personal ratio (7200/6000 = 1.2) but baseline isn't trusted.
        // Population fallback: 7200 steps is between 3000 and 8000 -> moderate.
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 7200, energy: 300),
            baseline: baseline(days: 6)
        )
        XCTAssertEqual(result, .moderate)
    }

    // MARK: - Outliers

    func test_extremeOutlierSteps_isClampedNotCrashing() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 999_999_999, energy: 0),
            baseline: baseline()
        )
        XCTAssertEqual(result, .active)
    }

    func test_negativeSteps_doesNotCrash() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: -500, energy: -100),
            baseline: .empty
        )
        XCTAssertEqual(result, .sedentary)
    }

    func test_extremeOutlierEnergy_isClampedNotCrashing() {
        let result = BandDeriver.deriveActivity(
            activity: activity(steps: 0, energy: 999_999_999),
            baseline: .empty
        )
        XCTAssertEqual(result, .active)
    }
}
