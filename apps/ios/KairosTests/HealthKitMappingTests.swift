import XCTest
import HealthKit
import BandDeriver
@testable import Kairos

/// Issue #37: "the HealthKit-to-BandDeriver-input mapping logic (unit
/// testable with mocked/fake HealthKit sample data — do NOT require a real
/// device or real HealthKit authorization to test this layer)."
///
/// `HKQuantitySample`/`HKCategorySample`/`HKWorkout` are plain HealthKit
/// model objects with public initializers — they do not require an
/// `HKHealthStore`, a real device, or granted authorization to construct,
/// which is exactly what makes `HealthKitMapping`'s pure functions
/// testable here in the simulator/CI without any live HealthKit access.
final class HealthKitMappingTests: XCTestCase {

    // MARK: - HRV / resting HR mapping

    func test_hrvSamples_mapsQuantityToSDNNMilliseconds_sortedByDate() throws {
        let type = try XCTUnwrap(HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN))
        let later = Date()
        let earlier = later.addingTimeInterval(-3600)

        let sampleLater = HKQuantitySample(
            type: type,
            quantity: HKQuantity(unit: .secondUnit(with: .milli), doubleValue: 55),
            start: later, end: later
        )
        let sampleEarlier = HKQuantitySample(
            type: type,
            quantity: HKQuantity(unit: .secondUnit(with: .milli), doubleValue: 40),
            start: earlier, end: earlier
        )

        let result = HealthKitMapping.hrvSamples(from: [sampleLater, sampleEarlier])

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].sdnnMilliseconds, 40, "Earlier sample must sort first")
        XCTAssertEqual(result[1].sdnnMilliseconds, 55)
        XCTAssertEqual(result.last?.sdnnMilliseconds, 55, "BandDeriver reads .last as 'latest'")
    }

    func test_hrvSamples_emptyInput_producesEmptyOutput() {
        XCTAssertTrue(HealthKitMapping.hrvSamples(from: []).isEmpty)
    }

    func test_restingHRSamples_mapsQuantityToBPM() throws {
        let type = try XCTUnwrap(HKObjectType.quantityType(forIdentifier: .restingHeartRate))
        let unit = HKUnit.count().unitDivided(by: .minute())
        let sample = HKQuantitySample(
            type: type,
            quantity: HKQuantity(unit: unit, doubleValue: 58),
            start: Date(), end: Date()
        )

        let result = HealthKitMapping.restingHRSamples(from: [sample])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].beatsPerMinute, 58)
    }

    // MARK: - Sleep stage aggregation

    func test_sleepStageDurations_noSamples_isNil() {
        XCTAssertNil(HealthKitMapping.sleepStageDurations(from: []))
    }

    func test_sleepStageDurations_aggregatesEachStageIndependently() throws {
        let type = try XCTUnwrap(HKObjectType.categoryType(forIdentifier: .sleepAnalysis))
        let base = Calendar.current.startOfDay(for: Date())

        func sample(_ value: HKCategoryValueSleepAnalysis, minutes: Double, startOffset: TimeInterval) -> HKCategorySample {
            let start = base.addingTimeInterval(startOffset)
            let end = start.addingTimeInterval(minutes * 60)
            return HKCategorySample(type: type, value: value.rawValue, start: start, end: end)
        }

        let samples = [
            sample(.asleepREM, minutes: 45, startOffset: 0),
            sample(.asleepCore, minutes: 120, startOffset: 45 * 60),
            sample(.asleepDeep, minutes: 30, startOffset: (45 + 120) * 60),
            sample(.awake, minutes: 15, startOffset: (45 + 120 + 30) * 60),
            sample(.inBed, minutes: 5, startOffset: (45 + 120 + 30 + 15) * 60),
        ]

        let result = try XCTUnwrap(HealthKitMapping.sleepStageDurations(from: samples))

        XCTAssertEqual(result.remMinutes, 45, accuracy: 0.01)
        XCTAssertEqual(result.coreMinutes, 120, accuracy: 0.01)
        XCTAssertEqual(result.deepMinutes, 30, accuracy: 0.01)
        XCTAssertEqual(result.awakeMinutes, 20, accuracy: 0.01, "awake + inBed both count as interruption time")
        XCTAssertEqual(result.asleepMinutes, 195, accuracy: 0.01)
        XCTAssertEqual(result.totalSessionMinutes, 215, accuracy: 0.01)
    }

    func test_sleepStageDurations_unspecifiedStage_countsAsCore() throws {
        // Older watchOS/devices without stage granularity report a single
        // "asleep" value with no REM/core/deep breakdown.
        let type = try XCTUnwrap(HKObjectType.categoryType(forIdentifier: .sleepAnalysis))
        let start = Date()
        let end = start.addingTimeInterval(6 * 3600)
        let sample = HKCategorySample(type: type, value: HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, start: start, end: end)

        let result = try XCTUnwrap(HealthKitMapping.sleepStageDurations(from: [sample]))

        XCTAssertEqual(result.coreMinutes, 360, accuracy: 0.01)
        XCTAssertEqual(result.remMinutes, 0)
        XCTAssertEqual(result.deepMinutes, 0)
    }

    func test_sleepStageDurations_zeroOrNegativeDurationSample_isIgnored() throws {
        let type = try XCTUnwrap(HKObjectType.categoryType(forIdentifier: .sleepAnalysis))
        let instant = Date()
        // start == end -> zero-duration sample; must not corrupt the totals.
        let degenerate = HKCategorySample(type: type, value: HKCategoryValueSleepAnalysis.asleepREM.rawValue, start: instant, end: instant)

        let result = try XCTUnwrap(HealthKitMapping.sleepStageDurations(from: [degenerate]))

        XCTAssertEqual(result.remMinutes, 0)
        XCTAssertEqual(result.totalSessionMinutes, 0)
    }

    /// A "good" night by `BandDeriver.deriveSleepQuality`'s thresholds
    /// (>=7h asleep, >=85% efficiency, >=30% restorative) should round-trip
    /// through the real mapping + deriver end to end — this is the
    /// integration point issue #37 cares about most: HealthKit-shaped
    /// input in, correct band out.
    func test_sleepStageDurations_goodNight_derivesGoodBandThroughBandDeriver() throws {
        let type = try XCTUnwrap(HKObjectType.categoryType(forIdentifier: .sleepAnalysis))
        let base = Date()

        func sample(_ value: HKCategoryValueSleepAnalysis, minutes: Double, offset: TimeInterval) -> HKCategorySample {
            let start = base.addingTimeInterval(offset)
            return HKCategorySample(type: type, value: value.rawValue, start: start, end: start.addingTimeInterval(minutes * 60))
        }

        // 90 REM + 240 core + 90 deep = 420 asleep (7h); 10 awake => efficiency 420/430 ~=0.976; restorative (90+90)/420 ~=0.43
        let samples = [
            sample(.asleepREM, minutes: 90, offset: 0),
            sample(.asleepCore, minutes: 240, offset: 90 * 60),
            sample(.asleepDeep, minutes: 90, offset: (90 + 240) * 60),
            sample(.awake, minutes: 10, offset: (90 + 240 + 90) * 60),
        ]
        let sleep = try XCTUnwrap(HealthKitMapping.sleepStageDurations(from: samples))

        let input = BandDeriverInput(
            recentHRV: [], recentRestingHR: [],
            lastNightSleep: sleep,
            recentActivity: ActivitySummary(steps: 0, activeEnergyBurnedKcal: 0, workoutMinutes: 0),
            baseline: .empty
        )
        let bands = BandDeriver.deriveBands(from: input)
        XCTAssertEqual(bands.sleepQuality, .good)
    }

    // MARK: - Workouts

    func test_totalWorkoutMinutes_sumsAllWorkoutDurations() {
        let workoutA = HKWorkout(activityType: .running, start: Date(), end: Date().addingTimeInterval(30 * 60))
        let workoutB = HKWorkout(activityType: .walking, start: Date(), end: Date().addingTimeInterval(15 * 60))

        let total = HealthKitMapping.totalWorkoutMinutes(from: [workoutA, workoutB])

        XCTAssertEqual(total, 45, accuracy: 0.01)
    }

    func test_totalWorkoutMinutes_noWorkouts_isZero() {
        XCTAssertEqual(HealthKitMapping.totalWorkoutMinutes(from: []), 0)
    }

    // MARK: - Daily baseline bucketing

    func test_dailyStats_average_bucketsByCalendarDayAndAveragesWithinDay() throws {
        let type = try XCTUnwrap(HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN))
        let calendar = Calendar(identifier: .gregorian)
        let day1 = calendar.date(from: DateComponents(year: 2026, month: 6, day: 1, hour: 8))!
        let day1b = calendar.date(from: DateComponents(year: 2026, month: 6, day: 1, hour: 20))!
        let day2 = calendar.date(from: DateComponents(year: 2026, month: 6, day: 2, hour: 8))!

        func sample(_ value: Double, at date: Date) -> HKQuantitySample {
            HKQuantitySample(type: type, quantity: HKQuantity(unit: .secondUnit(with: .milli), doubleValue: value), start: date, end: date)
        }

        // Day 1: two samples averaging to 50. Day 2: one sample of 70.
        let samples = [sample(40, at: day1), sample(60, at: day1b), sample(70, at: day2)]

        let stats = HealthKitMapping.dailyStats(from: samples, unit: .secondUnit(with: .milli), aggregation: .average, calendar: calendar)

        XCTAssertEqual(stats.dayCount, 2)
        // Daily values: [50, 70] -> mean 60
        XCTAssertEqual(stats.mean ?? -1, 60, accuracy: 0.01)
        XCTAssertNotNil(stats.stdDev)
    }

    func test_dailyStats_sum_sumsWithinDayThenAveragesAcrossDays() throws {
        let type = try XCTUnwrap(HKObjectType.quantityType(forIdentifier: .stepCount))
        let calendar = Calendar(identifier: .gregorian)
        let day1 = calendar.date(from: DateComponents(year: 2026, month: 6, day: 1, hour: 8))!
        let day1b = calendar.date(from: DateComponents(year: 2026, month: 6, day: 1, hour: 20))!
        let day2 = calendar.date(from: DateComponents(year: 2026, month: 6, day: 2, hour: 8))!

        func sample(_ value: Double, at date: Date) -> HKQuantitySample {
            HKQuantitySample(type: type, quantity: HKQuantity(unit: .count(), doubleValue: value), start: date, end: date)
        }

        // Day 1: 3000 + 2000 = 5000 steps. Day 2: 9000 steps.
        let samples = [sample(3000, at: day1), sample(2000, at: day1b), sample(9000, at: day2)]

        let stats = HealthKitMapping.dailyStats(from: samples, unit: .count(), aggregation: .sum, calendar: calendar)

        XCTAssertEqual(stats.dayCount, 2)
        // Daily totals: [5000, 9000] -> mean 7000
        XCTAssertEqual(stats.mean ?? -1, 7000, accuracy: 0.01)
    }

    func test_dailyStats_emptyInput_returnsEmptyStats() {
        let stats = HealthKitMapping.dailyStats(from: [], unit: .count(), aggregation: .sum)
        XCTAssertNil(stats.mean)
        XCTAssertNil(stats.stdDev)
        XCTAssertEqual(stats.dayCount, 0)
    }

    // MARK: - End-to-end: HealthKit-shaped fixtures -> BandDeriverInput -> BandDeriver

    /// Builds a full `BandDeriverInput` the way `HealthKitSampleReader`
    /// would, purely from HK-constructed fixtures, and confirms it derives
    /// the expected band triple — the concrete "mapping logic is unit
    /// testable with mocked HealthKit sample data" scenario issue #37 asks
    /// for, without touching `HKHealthStore` at all.
    func test_fullPipeline_lowRecoveryPoorSleepSedentary_derivesExpectedBands() throws {
        let hrvType = try XCTUnwrap(HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN))
        let hrvSample = HKQuantitySample(type: hrvType, quantity: HKQuantity(unit: .secondUnit(with: .milli), doubleValue: 15), start: Date(), end: Date())

        let sleepType = try XCTUnwrap(HKObjectType.categoryType(forIdentifier: .sleepAnalysis))
        let shortSleepStart = Date()
        let shortSleep = HKCategorySample(
            type: sleepType, value: HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            start: shortSleepStart, end: shortSleepStart.addingTimeInterval(3 * 3600)
        )

        let input = BandDeriverInput(
            recentHRV: HealthKitMapping.hrvSamples(from: [hrvSample]),
            recentRestingHR: [],
            lastNightSleep: HealthKitMapping.sleepStageDurations(from: [shortSleep]),
            recentActivity: ActivitySummary(steps: 500, activeEnergyBurnedKcal: 20, workoutMinutes: HealthKitMapping.totalWorkoutMinutes(from: [])),
            baseline: .empty
        )

        let bands = BandDeriver.deriveBands(from: input)

        XCTAssertEqual(bands.recovery, .low, "15ms HRV is below the population fallback low threshold (25ms)")
        XCTAssertEqual(bands.sleepQuality, .poor, "3h asleep is below the poor cutoff (5h)")
        XCTAssertEqual(bands.activity, .sedentary, "500 steps / 20 kcal is well under sedentary fallback thresholds")
    }
}
