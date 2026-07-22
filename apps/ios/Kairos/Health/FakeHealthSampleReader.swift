import Foundation
import BandDeriver

/// In-memory `HealthSampleReading` for unit tests, previews, and Demo Mode.
/// Never touches HealthKit — lets `BandUploadService` tests exercise the
/// "HealthKit read succeeds," "HealthKit read fails/denied → graceful
/// degradation," and "HealthKit legitimately returns no data" paths
/// deterministically, without a real device or granted authorization
/// (issue #37 testing scope).
public final class FakeHealthSampleReader: HealthSampleReading, @unchecked Sendable {
    public var nextInput: BandDeriverInput
    public var nextError: HealthSampleReadError?
    public private(set) var readCallCount = 0
    /// The `enabledCategories` set passed to the most recent
    /// `readTodayInput(enabledCategories:)` call — lets tests assert
    /// `BandUploadService` only ever requests categories the user has
    /// consented to (issue #70), mirroring `FakeHealthConnectService
    /// .lastRequestedCategories`'s existing pattern.
    public private(set) var lastEnabledCategories: Set<HealthCategory> = []

    public init(nextInput: BandDeriverInput = .empty, nextError: HealthSampleReadError? = nil) {
        self.nextInput = nextInput
        self.nextError = nextError
    }

    public func readTodayInput(enabledCategories: Set<HealthCategory>) async throws -> BandDeriverInput {
        readCallCount += 1
        lastEnabledCategories = enabledCategories
        if let nextError {
            throw nextError
        }
        return nextInput
    }
}

public extension BandDeriverInput {
    /// Fully empty input — mirrors "no permission granted yet" / "brand
    /// new user, nothing synced" (every field empty/nil, baseline `.empty`).
    /// `BandDeriver.deriveBands(from:)` is designed to map this to sensible
    /// neutral bands rather than crashing (see `BandDeriver.swift`
    /// "sensible default, no verdict" comments), which is exactly the
    /// graceful-degradation behavior issue #37 asks to verify; separately,
    /// `BandDeriver.deriveDerivedBands(from:)` maps this same input to
    /// every category `nil` (issue #70) — which requires `recentActivity`
    /// to genuinely be `nil` here (no evidence at all), not a *present*
    /// all-zeros `ActivitySummary` (which `deriveDerivedBands` correctly
    /// treats as a real, honest "measured and it was zero" sedentary
    /// verdict rather than an omission — see `DerivedBandsTests`
    /// `.test_zeroActivitySummary_isHonestSedentary_notOmitted` in the
    /// BandDeriver package). This field was a stale all-zeros summary
    /// left over from before `recentActivity` became `ActivitySummary?`
    /// (issue #70's sweep) — fixed to `nil` to actually match this
    /// property's own "every field empty/nil" doc comment above.
    static let empty = BandDeriverInput(
        recentHRV: [],
        recentRestingHR: [],
        lastNightSleep: nil,
        recentActivity: nil,
        baseline: .empty
    )

    /// Demo Mode fixture — deliberately below-baseline HRV + short sleep,
    /// mirroring the `low_poor_heavy` fallback-key persona
    /// (docs/05_UX_FLOWS.md §8, `KairosUser.demoDavid`) so "Refresh now"
    /// in demo mode produces a recognizable, non-trivial band set rather
    /// than always landing on the empty-input neutral defaults.
    static let demoFixture = BandDeriverInput(
        recentHRV: [HRVSample(sdnnMilliseconds: 22, date: Date())],
        recentRestingHR: [RestingHRSample(beatsPerMinute: 68, date: Date())],
        lastNightSleep: SleepStageDurations(remMinutes: 40, coreMinutes: 90, deepMinutes: 20, awakeMinutes: 60),
        recentActivity: ActivitySummary(steps: 1200, activeEnergyBurnedKcal: 60, workoutMinutes: 0),
        baseline: PersonalBaseline(
            meanHRVMilliseconds: 45,
            stdDevHRVMilliseconds: 8,
            meanRestingHRBpm: 62,
            meanDailySteps: 7000,
            meanDailyActiveEnergyKcal: 350,
            sampleDays: 30
        )
    )
}
