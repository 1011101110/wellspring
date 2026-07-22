import XCTest
@testable import BandDeriver

/// Tests for `BandDeriver.deriveDerivedBands(from:)` — the honest,
/// omission-capable sibling of `deriveBands(from:)` added for issue #70
/// (docs/14_IMPROVEMENT_REVIEW.md §1.8): a category with no evidence must
/// be `nil`, never a fabricated `moderate`/`fair`/`sedentary` verdict.
final class DerivedBandsTests: XCTestCase {

    private let refDate = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: - No evidence at all -> every category nil, not fabricated

    func test_emptyInput_everyCategoryIsNil_isEmptyTrue() {
        let input = BandDeriverInput(
            recentHRV: [],
            recentRestingHR: [],
            lastNightSleep: nil,
            recentActivity: nil,
            baseline: .empty
        )

        let result = BandDeriver.deriveDerivedBands(from: input)

        XCTAssertNil(result.recovery, "No HRV samples -> omit, never fabricate moderate")
        XCTAssertNil(result.sleepQuality, "No sleep session -> omit, never fabricate fair")
        XCTAssertNil(result.activity, "No activity summary -> omit, never fabricate sedentary")
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - Zero-value activity summary is a real (honest) measurement, not an omission

    func test_zeroActivitySummary_isHonestSedentary_notOmitted() {
        // A present-but-all-zeros ActivitySummary means "we asked and
        // measured genuinely no movement" — distinct from `nil` ("we never
        // asked / consent withheld / query errored"). This must still
        // produce a real sedentary verdict, not be treated as missing.
        let input = BandDeriverInput(
            recentHRV: [],
            recentRestingHR: [],
            lastNightSleep: nil,
            recentActivity: ActivitySummary(steps: 0, activeEnergyBurnedKcal: 0, workoutMinutes: 0),
            baseline: .empty
        )

        let result = BandDeriver.deriveDerivedBands(from: input)

        XCTAssertEqual(result.activity, .sedentary)
        XCTAssertFalse(result.isEmpty)
    }

    // MARK: - Each category derives normally when its evidence is present

    func test_fullInput_allThreeCategoriesDerivedNormally_matchesDeriveBands() {
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 65, date: refDate)],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 55, date: refDate)],
            lastNightSleep: SleepStageDurations(
                remMinutes: 120, coreMinutes: 150, deepMinutes: 150, awakeMinutes: 10
            ),
            recentActivity: ActivitySummary(steps: 9000, activeEnergyBurnedKcal: 450, workoutMinutes: 30),
            baseline: PersonalBaseline(
                meanHRVMilliseconds: 45,
                stdDevHRVMilliseconds: 10,
                meanRestingHRBpm: 60,
                meanDailySteps: 6000,
                meanDailyActiveEnergyKcal: 250,
                sampleDays: 30
            )
        )

        let derived = BandDeriver.deriveDerivedBands(from: input)
        let guaranteed = BandDeriver.deriveBands(from: input)

        XCTAssertEqual(derived.recovery, guaranteed.recovery)
        XCTAssertEqual(derived.sleepQuality, guaranteed.sleepQuality)
        XCTAssertEqual(derived.activity, guaranteed.activity)
        XCTAssertFalse(derived.isEmpty)
    }

    // MARK: - Partial evidence: some categories present, some absent

    func test_partialInput_onlyRecoveryHasEvidence_othersOmitted() {
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 65, date: refDate)],
            recentRestingHR: [],
            lastNightSleep: nil,
            recentActivity: nil,
            baseline: .empty
        )

        let result = BandDeriver.deriveDerivedBands(from: input)

        XCTAssertNotNil(result.recovery)
        XCTAssertNil(result.sleepQuality)
        XCTAssertNil(result.activity)
        XCTAssertFalse(result.isEmpty)
    }

    func test_partialInput_onlySleepHasEvidence_othersOmitted() {
        let input = BandDeriverInput(
            recentHRV: [],
            recentRestingHR: [],
            lastNightSleep: SleepStageDurations(remMinutes: 90, coreMinutes: 180, deepMinutes: 90, awakeMinutes: 10),
            recentActivity: nil,
            baseline: .empty
        )

        let result = BandDeriver.deriveDerivedBands(from: input)

        XCTAssertNil(result.recovery)
        XCTAssertNotNil(result.sleepQuality)
        XCTAssertNil(result.activity)
    }

    // MARK: - Purity/determinism, matching deriveBands' own guarantee

    func test_deriveDerivedBands_isPureAndDeterministic() {
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 42, date: refDate)],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 61, date: refDate)],
            lastNightSleep: SleepStageDurations(remMinutes: 90, coreMinutes: 200, deepMinutes: 80, awakeMinutes: 30),
            recentActivity: ActivitySummary(steps: 5000, activeEnergyBurnedKcal: 200, workoutMinutes: 5),
            baseline: PersonalBaseline(
                meanHRVMilliseconds: 45,
                stdDevHRVMilliseconds: 10,
                meanRestingHRBpm: 60,
                meanDailySteps: 6000,
                meanDailyActiveEnergyKcal: 250,
                sampleDays: 30
            )
        )

        let first = BandDeriver.deriveDerivedBands(from: input)
        let second = BandDeriver.deriveDerivedBands(from: input)

        XCTAssertEqual(first, second)
    }
}
