import Foundation
import HealthKit
import BandDeriver

/// Pure mapping functions from HealthKit sample types to BandDeriver's
/// plain-Swift input structs (`HealthInputs.swift`). Deliberately split out
/// from `HealthKitSampleReader` (which owns the async `HKHealthStore`
/// *querying*) so this file has no dependency on `HKHealthStore` itself —
/// `HKQuantitySample`/`HKCategorySample`/`HKWorkout` can all be constructed
/// directly in a test target (they are plain HealthKit model objects, not
/// live-store-backed), so this mapping logic is unit-testable with fixture
/// sample data per issue #37's testing scope, with zero dependency on a
/// real device, a simulator with health data, or granted HealthKit
/// authorization.
enum HealthKitMapping {

    // MARK: - HRV / resting HR

    static func hrvSamples(from samples: [HKQuantitySample]) -> [HRVSample] {
        samples
            .map { HRVSample(sdnnMilliseconds: $0.quantity.doubleValue(for: .secondUnit(with: .milli)), date: $0.startDate) }
            .sorted { $0.date < $1.date }
    }

    static func restingHRSamples(from samples: [HKQuantitySample]) -> [RestingHRSample] {
        let unit = HKUnit.count().unitDivided(by: .minute())
        return samples
            .map { RestingHRSample(beatsPerMinute: $0.quantity.doubleValue(for: unit), date: $0.startDate) }
            .sorted { $0.date < $1.date }
    }

    // MARK: - Sleep

    /// Aggregates raw sleep-analysis category samples into stage-duration
    /// totals. `nil` when there are no samples at all (distinct from "zero
    /// minutes in every stage," which would be a strange but technically
    /// valid non-nil result) — mirrors `BandDeriver.deriveSleepQuality`'s
    /// "no sleep data at all -> sensible default" branch, which keys off
    /// `lastNightSleep == nil` specifically.
    static func sleepStageDurations(from samples: [HKCategorySample]) -> SleepStageDurations? {
        guard !samples.isEmpty else { return nil }

        var rem = 0.0, core = 0.0, deep = 0.0, awake = 0.0
        for sample in samples {
            let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60.0
            guard minutes > 0 else { continue }
            switch sample.value {
            case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
                rem += minutes
            case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
                core += minutes
            case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
                deep += minutes
            case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
                // Older watchOS/devices without stage granularity report
                // this single "asleep" value — treat as core/unstaged sleep
                // rather than dropping it, so duration-only sleep data
                // still contributes to the duration-based cutoffs.
                core += minutes
            case HKCategoryValueSleepAnalysis.awake.rawValue,
                 HKCategoryValueSleepAnalysis.inBed.rawValue:
                awake += minutes
            default:
                break
            }
        }
        return SleepStageDurations(remMinutes: rem, coreMinutes: core, deepMinutes: deep, awakeMinutes: awake)
    }

    // MARK: - Activity

    static func totalWorkoutMinutes(from workouts: [HKWorkout]) -> Double {
        workouts.reduce(0.0) { $0 + $1.duration / 60.0 }
    }

    // MARK: - Baseline bucketing

    struct DailyStats: Equatable {
        let mean: Double?
        let stdDev: Double?
        let dayCount: Int

        static let empty = DailyStats(mean: nil, stdDev: nil, dayCount: 0)
    }

    enum Aggregation {
        case average
        case sum
    }

    /// Buckets quantity samples into calendar days (using `calendar`) and
    /// computes the mean (and, for `.average` aggregation, standard
    /// deviation) across those daily values — the shape `PersonalBaseline`
    /// needs for `BandDeriver`'s z-score/ratio comparisons.
    static func dailyStats(
        from samples: [HKQuantitySample],
        unit: HKUnit,
        aggregation: Aggregation,
        calendar: Calendar = .current
    ) -> DailyStats {
        guard !samples.isEmpty else { return .empty }

        var byDay: [Date: [Double]] = [:]
        for sample in samples {
            let day = calendar.startOfDay(for: sample.startDate)
            byDay[day, default: []].append(sample.quantity.doubleValue(for: unit))
        }

        let dailyValues: [Double] = byDay.values.map { values in
            switch aggregation {
            case .average: return values.reduce(0, +) / Double(values.count)
            case .sum: return values.reduce(0, +)
            }
        }
        guard !dailyValues.isEmpty else { return .empty }

        let mean = dailyValues.reduce(0, +) / Double(dailyValues.count)
        let variance = dailyValues.reduce(0) { $0 + pow($1 - mean, 2) } / Double(dailyValues.count)
        return DailyStats(mean: mean, stdDev: sqrt(variance), dayCount: dailyValues.count)
    }
}
