import XCTest
@testable import BandDeriver

final class BandDeriverIntegrationTests: XCTestCase {

    private let refDate = Date(timeIntervalSince1970: 1_800_000_000)

    func test_deriveBands_combinesAllThreeSignalsFromFullInput() {
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 65, date: refDate)],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 55, date: refDate)],
            lastNightSleep: SleepStageDurations(
                remMinutes: 120, coreMinutes: 150, deepMinutes: 150, awakeMinutes: 10
            ),
            recentActivity: ActivitySummary(
                steps: 9000, activeEnergyBurnedKcal: 450, workoutMinutes: 30
            ),
            baseline: PersonalBaseline(
                meanHRVMilliseconds: 45,
                stdDevHRVMilliseconds: 10,
                meanRestingHRBpm: 60,
                meanDailySteps: 6000,
                meanDailyActiveEnergyKcal: 250,
                sampleDays: 30
            )
        )

        let bands = BandDeriver.deriveBands(from: input)

        XCTAssertEqual(bands.recovery, .high)
        XCTAssertEqual(bands.sleepQuality, .good)
        XCTAssertEqual(bands.activity, .active)
    }

    func test_deriveBands_brandNewUserWithNoHistory_returnsSensibleDefaultsNoCrash() {
        // First-launch scenario: no baseline, no sleep, no HRV samples yet.
        let input = BandDeriverInput(
            recentHRV: [],
            recentRestingHR: [],
            lastNightSleep: nil,
            recentActivity: ActivitySummary(steps: 0, activeEnergyBurnedKcal: 0, workoutMinutes: 0),
            baseline: .empty
        )

        let bands = BandDeriver.deriveBands(from: input)

        XCTAssertEqual(bands.recovery, .moderate)
        XCTAssertEqual(bands.sleepQuality, .fair)
        XCTAssertEqual(bands.activity, .sedentary)
    }

    func test_deriveBands_poorRecoveryPoorSleepSedentaryActivity() {
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 18, date: refDate)],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 70, date: refDate)],
            lastNightSleep: SleepStageDurations(
                remMinutes: 20, coreMinutes: 80, deepMinutes: 10, awakeMinutes: 60
            ),
            recentActivity: ActivitySummary(steps: 500, activeEnergyBurnedKcal: 40, workoutMinutes: 0),
            baseline: PersonalBaseline(
                meanHRVMilliseconds: 45,
                stdDevHRVMilliseconds: 10,
                meanRestingHRBpm: 60,
                meanDailySteps: 6000,
                meanDailyActiveEnergyKcal: 250,
                sampleDays: 30
            )
        )

        let bands = BandDeriver.deriveBands(from: input)

        XCTAssertEqual(bands.recovery, .low)
        XCTAssertEqual(bands.sleepQuality, .poor)
        XCTAssertEqual(bands.activity, .sedentary)
    }

    func test_deriveBands_isPureAndDeterministic() {
        let input = BandDeriverInput(
            recentHRV: [HRVSample(sdnnMilliseconds: 42, date: refDate)],
            recentRestingHR: [RestingHRSample(beatsPerMinute: 61, date: refDate)],
            lastNightSleep: SleepStageDurations(
                remMinutes: 90, coreMinutes: 200, deepMinutes: 80, awakeMinutes: 30
            ),
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

        let first = BandDeriver.deriveBands(from: input)
        let second = BandDeriver.deriveBands(from: input)

        XCTAssertEqual(first, second)
    }
}
