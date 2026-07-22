import Foundation
import HealthKit
import BandDeriver

/// Real `HealthSampleReading` backed by `HKHealthStore`. Queries the
/// trailing windows BandDeriver expects (recent HRV/resting-HR samples,
/// last night's sleep stages, trailing-24h activity, and a rolling
/// baseline) and maps every HealthKit result type into the plain-Swift
/// structs from `HealthInputs.swift` — raw `HKSample` objects never leave
/// this file.
///
/// Every individual query is independently best-effort: a failure or empty
/// result for one signal (e.g. no sleep data because a watch wasn't worn)
/// does not fail the whole read — it just yields `nil`/empty for that
/// field, which `BandDeriver` already treats as "insufficient evidence,
/// sensible default" (see `BandDeriver.swift`). This method only throws
/// `HealthSampleReadError` for a genuinely unavailable health store, so a
/// denied/partial-permission device still produces a (moderate/neutral)
/// band set rather than crashing or blocking the upload entirely.
public final class HealthKitSampleReader: HealthSampleReading, @unchecked Sendable {
    private let store = HKHealthStore()

    /// Rolling baseline window, in days, used for personal-baseline
    /// comparisons in `BandDeriver` (mirrors `BandDeriver.minimumBaselineDays`
    /// intent — more history than the minimum so early z-scores are stable).
    private let baselineWindowDays: Int

    public init(baselineWindowDays: Int = 28) {
        self.baselineWindowDays = baselineWindowDays
    }

    public func readTodayInput(enabledCategories: Set<HealthCategory>) async throws -> BandDeriverInput {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw HealthSampleReadError.unavailable
        }

        // Categories not in `enabledCategories` (consent withheld) are never
        // queried at all (issue #70) — their `BandDeriverInput` fields are
        // populated with the "no evidence" value directly, without ever
        // touching HealthKit.
        let recoveryEnabled = enabledCategories.contains(.recovery)
        let sleepEnabled = enabledCategories.contains(.sleepQuality)
        let activityEnabled = enabledCategories.contains(.activity)

        async let hrv = recoveryEnabled ? recentHRVSamples() : []
        async let restingHR = recoveryEnabled ? recentRestingHRSamples() : []
        async let sleep = sleepEnabled ? lastNightSleep() : nil
        async let activity = activityEnabled ? recentActivity() : nil
        // The personal baseline backs recovery + activity comparisons; it's
        // only computed when at least one of those two categories is
        // enabled, so a user who withheld both never has HealthKit queried
        // for either's baseline history.
        async let baseline = (recoveryEnabled || activityEnabled) ? personalBaseline() : .empty

        return try await BandDeriverInput(
            recentHRV: hrv,
            recentRestingHR: restingHR,
            lastNightSleep: sleep,
            recentActivity: activity,
            baseline: baseline
        )
    }

    // MARK: - HRV / resting HR

    private func recentHRVSamples() async throws -> [HRVSample] {
        guard let type = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN) else { return [] }
        let samples = try await quantitySamples(for: type, since: Calendar.current.date(byAdding: .day, value: -1, to: Date()))
        return HealthKitMapping.hrvSamples(from: samples)
    }

    private func recentRestingHRSamples() async throws -> [RestingHRSample] {
        guard let type = HKObjectType.quantityType(forIdentifier: .restingHeartRate) else { return [] }
        let samples = try await quantitySamples(for: type, since: Calendar.current.date(byAdding: .day, value: -1, to: Date()))
        return HealthKitMapping.restingHRSamples(from: samples)
    }

    // MARK: - Sleep

    private func lastNightSleep() async throws -> SleepStageDurations? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        // "Last night" = the trailing 24h window, which is the standard
        // heuristic for "most recent completed sleep session" without
        // needing to detect session boundaries ourselves.
        let since = Calendar.current.date(byAdding: .hour, value: -24, to: Date())
        let samples = try await categorySamples(for: type, since: since)
        return HealthKitMapping.sleepStageDurations(from: samples)
    }

    // MARK: - Activity

    private func recentActivity() async throws -> ActivitySummary {
        let since = Calendar.current.date(byAdding: .hour, value: -24, to: Date()) ?? Date()
        async let steps = sumQuantity(identifier: .stepCount, unit: .count(), since: since)
        async let energy = sumQuantity(identifier: .activeEnergyBurned, unit: .kilocalorie(), since: since)
        async let workoutMinutes = totalWorkoutMinutes(since: since)
        return try await ActivitySummary(
            steps: steps,
            activeEnergyBurnedKcal: energy,
            workoutMinutes: workoutMinutes
        )
    }

    private func totalWorkoutMinutes(since: Date?) async throws -> Double {
        let predicate: NSPredicate? = since.map { HKQuery.predicateForSamples(withStart: $0, end: Date(), options: .strictStartDate) }
        let workouts: [HKWorkout] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: .workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error {
                    continuation.resume(throwing: HealthSampleReadError.queryFailed(error.localizedDescription))
                } else {
                    continuation.resume(returning: (samples as? [HKWorkout]) ?? [])
                }
            }
            store.execute(query)
        }
        return HealthKitMapping.totalWorkoutMinutes(from: workouts)
    }

    // MARK: - Baseline

    /// Rolling personal baseline over `baselineWindowDays`, computed from
    /// daily-average HealthKit statistics. Returns `PersonalBaseline.empty`
    /// when there isn't enough history (a genuinely thin/new-user baseline)
    /// — `BandDeriver` already treats `sampleDays < minimumBaselineDays` as
    /// "use population fallback," so that case is a legitimate, expected
    /// result, not a failure. A real HealthKit *query* error for one of the
    /// four underlying statistics is different — it degrades only that one
    /// series to empty (rather than failing the whole baseline, since the
    /// baseline is already designed to tolerate partial/missing history)
    /// so a transient error on, say, resting-HR history doesn't also erase
    /// a perfectly good HRV baseline.
    private func personalBaseline() async -> PersonalBaseline {
        let windowStart = Calendar.current.date(byAdding: .day, value: -baselineWindowDays, to: Date())

        async let hrvStats = dailyStatsTolerant(identifier: .heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), since: windowStart, aggregation: .average)
        async let hrStats = dailyStatsTolerant(identifier: .restingHeartRate, unit: .count().unitDivided(by: .minute()), since: windowStart, aggregation: .average)
        async let stepsStats = dailyStatsTolerant(identifier: .stepCount, unit: .count(), since: windowStart, aggregation: .sum)
        async let energyStats = dailyStatsTolerant(identifier: .activeEnergyBurned, unit: .kilocalorie(), since: windowStart, aggregation: .sum)

        let (hrv, hr, steps, energy) = await (hrvStats, hrStats, stepsStats, energyStats)

        // Sample-day coverage is approximated from whichever series has the
        // most daily buckets — a rough but conservative stand-in for "how
        // many days of history do we actually have."
        let sampleDays = max(hrv.dayCount, hr.dayCount, steps.dayCount, energy.dayCount)

        return PersonalBaseline(
            meanHRVMilliseconds: hrv.mean,
            stdDevHRVMilliseconds: hrv.stdDev,
            meanRestingHRBpm: hr.mean,
            meanDailySteps: steps.mean,
            meanDailyActiveEnergyKcal: energy.mean,
            sampleDays: sampleDays
        )
    }

    // MARK: - Low-level HealthKit query helpers
    //
    // Every query here propagates a genuine HealthKit query error via
    // `HealthSampleReadError.queryFailed` (issue #70 /
    // docs/14_IMPROVEMENT_REVIEW.md §1.8: "propagate the currently-swallowed
    // query errors") rather than silently mapping it to an empty
    // result — a caller must be able to distinguish "HealthKit legitimately
    // has nothing" from "the query itself failed," since only the former is
    // safe to treat as "no evidence, omit the category."

    private func quantitySamples(for type: HKQuantityType, since: Date?) async throws -> [HKQuantitySample] {
        let predicate: NSPredicate? = since.map { HKQuery.predicateForSamples(withStart: $0, end: Date(), options: .strictStartDate) }
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error {
                    continuation.resume(throwing: HealthSampleReadError.queryFailed(error.localizedDescription))
                } else {
                    continuation.resume(returning: (samples as? [HKQuantitySample]) ?? [])
                }
            }
            store.execute(query)
        }
    }

    private func categorySamples(for type: HKCategoryType, since: Date?) async throws -> [HKCategorySample] {
        let predicate: NSPredicate? = since.map { HKQuery.predicateForSamples(withStart: $0, end: Date(), options: .strictStartDate) }
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error {
                    continuation.resume(throwing: HealthSampleReadError.queryFailed(error.localizedDescription))
                } else {
                    continuation.resume(returning: (samples as? [HKCategorySample]) ?? [])
                }
            }
            store.execute(query)
        }
    }

    private func sumQuantity(identifier: HKQuantityTypeIdentifier, unit: HKUnit, since: Date) async throws -> Double {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return 0 }
        let predicate = HKQuery.predicateForSamples(withStart: since, end: Date(), options: .strictStartDate)
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, error in
                if let error {
                    continuation.resume(throwing: HealthSampleReadError.queryFailed(error.localizedDescription))
                } else {
                    continuation.resume(returning: stats?.sumQuantity()?.doubleValue(for: unit) ?? 0)
                }
            }
            store.execute(query)
        }
    }

    /// Fetches then delegates bucketing/averaging to the pure, unit-tested
    /// `HealthKitMapping.dailyStats(from:unit:aggregation:)`. Propagates a
    /// genuine query error to its caller.
    private func dailyStats(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        since: Date?,
        aggregation: HealthKitMapping.Aggregation
    ) async throws -> HealthKitMapping.DailyStats {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier), let since else {
            return .empty
        }
        let samples = try await quantitySamples(for: type, since: since)
        return HealthKitMapping.dailyStats(from: samples, unit: unit, aggregation: aggregation)
    }

    /// `personalBaseline()`-only wrapper: a query error for one of the four
    /// baseline series degrades to `.empty` for that series alone (see
    /// `personalBaseline`'s doc comment for why the baseline as a whole
    /// tolerates partial history) rather than failing the entire
    /// `readTodayInput` call over a baseline-only error.
    private func dailyStatsTolerant(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        since: Date?,
        aggregation: HealthKitMapping.Aggregation
    ) async -> HealthKitMapping.DailyStats {
        (try? await dailyStats(identifier: identifier, unit: unit, since: since, aggregation: aggregation)) ?? .empty
    }
}
