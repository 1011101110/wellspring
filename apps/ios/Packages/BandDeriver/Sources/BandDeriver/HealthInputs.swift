import Foundation

// MARK: - HealthKit-shaped input types
//
// These structs are modeled on what HealthKit would actually hand you
// (HKQuantitySample / HKCategorySample / HKWorkout aggregates), but this
// file has NO import HealthKit and NO dependency on the HealthKit framework.
// The call site (the iOS app target, not this package) is responsible for
// mapping real HKSample objects into these plain-Swift structs before
// calling into BandDeriver. This keeps BandDeriver pure, host-agnostic,
// and unit-testable outside Xcode/the simulator.

/// A single Heart Rate Variability sample, SDNN method, in milliseconds.
/// Mirrors `HKQuantityTypeIdentifier.heartRateVariabilitySDNN`.
public struct HRVSample: Equatable, Sendable {
    public let sdnnMilliseconds: Double
    public let date: Date

    public init(sdnnMilliseconds: Double, date: Date) {
        self.sdnnMilliseconds = sdnnMilliseconds
        self.date = date
    }
}

/// A single resting heart rate sample, in beats per minute.
/// Mirrors `HKQuantityTypeIdentifier.restingHeartRate`.
public struct RestingHRSample: Equatable, Sendable {
    public let beatsPerMinute: Double
    public let date: Date

    public init(beatsPerMinute: Double, date: Date) {
        self.beatsPerMinute = beatsPerMinute
        self.date = date
    }
}

/// Duration, in minutes, spent in each sleep stage during the most recent
/// sleep session. Mirrors the category values under
/// `HKCategoryTypeIdentifier.sleepAnalysis` (Apple's stage granularity).
public struct SleepStageDurations: Equatable, Sendable {
    public let remMinutes: Double
    public let coreMinutes: Double
    public let deepMinutes: Double
    /// Time scored "in bed" or "awake" during the session (interruptions).
    public let awakeMinutes: Double

    public init(
        remMinutes: Double,
        coreMinutes: Double,
        deepMinutes: Double,
        awakeMinutes: Double
    ) {
        self.remMinutes = remMinutes
        self.coreMinutes = coreMinutes
        self.deepMinutes = deepMinutes
        self.awakeMinutes = awakeMinutes
    }

    /// Total time asleep (excludes awake interruptions).
    public var asleepMinutes: Double {
        remMinutes + coreMinutes + deepMinutes
    }

    /// Total session span, including awake interruptions.
    public var totalSessionMinutes: Double {
        asleepMinutes + awakeMinutes
    }
}

/// Recent activity aggregates, roughly mirroring what you'd assemble from
/// `HKStatisticsQuery` over `.stepCount`, `.activeEnergyBurned`, and
/// `HKWorkout` fetches for the trailing window.
public struct ActivitySummary: Equatable, Sendable {
    public let steps: Double
    public let activeEnergyBurnedKcal: Double
    public let workoutMinutes: Double

    public init(
        steps: Double,
        activeEnergyBurnedKcal: Double,
        workoutMinutes: Double
    ) {
        self.steps = steps
        self.activeEnergyBurnedKcal = activeEnergyBurnedKcal
        self.workoutMinutes = workoutMinutes
    }
}

/// A personal rolling baseline computed on-device from historical samples
/// (e.g. a trailing 28/60-day window). `nil` fields mean "insufficient
/// history" and callers should fall back to population defaults.
public struct PersonalBaseline: Equatable, Sendable {
    /// Mean HRV (SDNN, ms) over the rolling baseline window.
    public let meanHRVMilliseconds: Double?
    /// Standard deviation of HRV (SDNN, ms) over the rolling baseline window.
    public let stdDevHRVMilliseconds: Double?
    /// Mean resting HR (bpm) over the rolling baseline window.
    public let meanRestingHRBpm: Double?
    /// Mean daily steps over the rolling baseline window.
    public let meanDailySteps: Double?
    /// Mean daily active energy (kcal) over the rolling baseline window.
    public let meanDailyActiveEnergyKcal: Double?
    /// Number of days of history backing this baseline. Used to decide
    /// whether the baseline is trustworthy enough to compare against.
    public let sampleDays: Int

    public init(
        meanHRVMilliseconds: Double?,
        stdDevHRVMilliseconds: Double?,
        meanRestingHRBpm: Double?,
        meanDailySteps: Double?,
        meanDailyActiveEnergyKcal: Double?,
        sampleDays: Int
    ) {
        self.meanHRVMilliseconds = meanHRVMilliseconds
        self.stdDevHRVMilliseconds = stdDevHRVMilliseconds
        self.meanRestingHRBpm = meanRestingHRBpm
        self.meanDailySteps = meanDailySteps
        self.meanDailyActiveEnergyKcal = meanDailyActiveEnergyKcal
        self.sampleDays = sampleDays
    }

    /// No baseline history at all (e.g. brand-new user / first launch).
    public static let empty = PersonalBaseline(
        meanHRVMilliseconds: nil,
        stdDevHRVMilliseconds: nil,
        meanRestingHRBpm: nil,
        meanDailySteps: nil,
        meanDailyActiveEnergyKcal: nil,
        sampleDays: 0
    )
}

/// The full set of HealthKit-shaped inputs BandDeriver needs to compute
/// today's bands. Assembled by the iOS app from live HealthKit queries (or
/// from fixture data in demo mode per docs/00_FOUNDATION.md §11).
public struct BandDeriverInput: Equatable, Sendable {
    /// Most recent HRV samples (typically the current day / most recent
    /// sleep-adjacent reading). Empty if unavailable.
    public let recentHRV: [HRVSample]
    /// Most recent resting HR samples, most-recent-last.
    public let recentRestingHR: [RestingHRSample]
    /// Sleep stage durations for the most recent completed sleep session.
    /// `nil` if no sleep data is available (e.g. permission denied, watch
    /// not worn overnight).
    public let lastNightSleep: SleepStageDurations?
    /// Activity aggregates for the trailing window (e.g. last 24h).
    /// `nil` when there is no activity data at all (permission denied,
    /// activity queries errored, or the category was never queried) — which
    /// is deliberately distinct from a real all-zeros summary (a device
    /// that recorded genuinely no movement). `nil` yields **no** activity
    /// band (omitted), while zeros yield an honest `sedentary`.
    public let recentActivity: ActivitySummary?
    /// Personal rolling baseline for comparison.
    public let baseline: PersonalBaseline

    public init(
        recentHRV: [HRVSample],
        recentRestingHR: [RestingHRSample],
        lastNightSleep: SleepStageDurations?,
        recentActivity: ActivitySummary?,
        baseline: PersonalBaseline
    ) {
        self.recentHRV = recentHRV
        self.recentRestingHR = recentRestingHR
        self.lastNightSleep = lastNightSleep
        self.recentActivity = recentActivity
        self.baseline = baseline
    }
}
