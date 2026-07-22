import Foundation

/// Pure, on-device derivation of the three HealthKit-sourced bands defined
/// in docs/00_FOUNDATION.md §5: `recovery`, `sleepQuality`, `activity`.
///
/// Every function here is a pure function of its inputs — no I/O, no
/// HealthKit access, no persistence. The iOS app is responsible for
/// querying HealthKit, mapping results into the input structs in
/// `HealthInputs.swift`, and calling `BandDeriver.deriveBands(from:)`.
/// Raw values never leave this derivation step: only the resulting
/// `HealthBands` enum triple is what the rest of the app (and eventually
/// the network layer) is allowed to touch.
public enum BandDeriver {

    // MARK: - Thresholds
    //
    // Thresholds are expressed relative to the user's own rolling baseline
    // wherever a baseline is available (personalized signal quality is the
    // whole point of on-device derivation), with fixed population-level
    // fallbacks when the baseline is missing or too thin to trust.

    /// Minimum number of days of baseline history required before we trust
    /// personal-baseline comparisons for HRV/activity. Below this we fall
    /// back to fixed population thresholds.
    static let minimumBaselineDays = 7

    /// HRV z-score cutoffs (personal baseline: (today - mean) / stddev).
    /// z >= +0.5  → high
    /// z <= -0.5  → low
    /// otherwise  → moderate
    static let hrvHighZScore = 0.5
    static let hrvLowZScore = -0.5

    /// Resting HR trend cutoffs, in bpm, vs personal baseline mean.
    /// A resting HR that has crept up nudges recovery down a notch; a
    /// resting HR meaningfully below baseline nudges it up.
    static let restingHRElevatedDeltaBpm = 3.0
    static let restingHRDepressedDeltaBpm = -3.0

    /// Population fallback thresholds when no trustworthy personal
    /// baseline exists yet (new users). Chosen from commonly cited
    /// population HRV(SDNN) ranges for adults; intentionally conservative
    /// (defaults to `moderate` rather than asserting `high`/`low` on thin
    /// evidence).
    static let fallbackHRVLowMs = 25.0
    static let fallbackHRVHighMs = 60.0

    /// Sleep duration cutoffs, in minutes of total time asleep.
    static let sleepPoorMaxMinutes = 5.0 * 60.0     // < 5h asleep => poor
    static let sleepGoodMinMinutes = 7.0 * 60.0      // >= 7h asleep => candidate good

    /// Minimum fraction of session time spent asleep (vs awake/interrupted)
    /// required to call sleep "good" even if duration alone qualifies.
    static let sleepGoodMinEfficiency = 0.85

    /// Minimum combined deep+REM fraction of total sleep required for
    /// "good" sleep quality (restorative-stage proxy).
    static let sleepGoodMinRestorativeFraction = 0.30

    /// Activity cutoffs vs personal baseline (ratio of today's combined
    /// activity score to baseline mean).
    static let activityActiveRatio = 1.2
    static let activitySedentaryRatio = 0.5

    /// Population fallback step/energy thresholds when no baseline exists.
    static let fallbackSedentarySteps = 3000.0
    static let fallbackActiveSteps = 8000.0
    static let fallbackSedentaryEnergyKcal = 150.0
    static let fallbackActiveEnergyKcal = 400.0

    /// Outlier clamps: values outside these ranges are treated as sensor
    /// noise/glitches and clamped before use, rather than being allowed to
    /// blow out the derived band on a single bad sample.
    static let hrvPlausibleRangeMs = 1.0...300.0
    static let restingHRPlausibleRangeBpm = 25.0...220.0
    static let stepsPlausibleMax = 100_000.0
    static let activeEnergyPlausibleMaxKcal = 20_000.0

    // MARK: - Public entry point

    /// Derive today's `HealthBands` from HealthKit-shaped input data.
    public static func deriveBands(from input: BandDeriverInput) -> HealthBands {
        HealthBands(
            recovery: deriveRecovery(
                recentHRV: input.recentHRV,
                recentRestingHR: input.recentRestingHR,
                baseline: input.baseline
            ),
            sleepQuality: deriveSleepQuality(sleep: input.lastNightSleep),
            // Missing activity data entirely -> sensible default (.moderate),
            // no verdict — same pattern as deriveRecovery's missing-HRV guard
            // above. This legacy always-a-verdict path is unrelated to the
            // upload-omission distinction `DerivedBands` exists for (#70);
            // it stays load-bearing for callers that need a guaranteed triple.
            activity: input.recentActivity.map {
                deriveActivity(activity: $0, baseline: input.baseline)
            } ?? .moderate
        )
    }

    /// Derive today's `DerivedBands` — the honest, omission-capable sibling
    /// of `deriveBands(from:)` (docs/14_IMPROVEMENT_REVIEW.md §1.8 / issue
    /// #70). Each of the three categories is `nil` when there is no
    /// evidence for it at all (empty HRV samples, no sleep session, no
    /// activity summary — the last of which the caller is responsible for
    /// setting to `nil` for a withheld-consent or errored category, per
    /// `BandDeriverInput.recentActivity`'s doc comment), rather than
    /// silently falling back to a fabricated `moderate`/`fair`/`sedentary`
    /// verdict. This is a separate function (not a change to
    /// `deriveBands`/`deriveRecovery`/`deriveSleepQuality`/`deriveActivity`)
    /// so every existing "no data -> sensible default" test for the
    /// always-a-verdict path keeps passing unmodified — callers that need a
    /// guaranteed triple (e.g. any future population-level analytics) keep
    /// using `deriveBands`; callers that must never invent a band for an
    /// unconsented or unmeasured category (the upload path) use this one.
    public static func deriveDerivedBands(from input: BandDeriverInput) -> DerivedBands {
        DerivedBands(
            recovery: input.recentHRV.isEmpty ? nil : deriveRecovery(
                recentHRV: input.recentHRV,
                recentRestingHR: input.recentRestingHR,
                baseline: input.baseline
            ),
            sleepQuality: input.lastNightSleep.map { deriveSleepQuality(sleep: $0) },
            activity: input.recentActivity.map { deriveActivity(activity: $0, baseline: input.baseline) }
        )
    }

    // MARK: - Recovery

    static func deriveRecovery(
        recentHRV: [HRVSample],
        recentRestingHR: [RestingHRSample],
        baseline: PersonalBaseline
    ) -> RecoveryBand {
        // Missing HRV data entirely → sensible default, no verdict.
        guard let latestHRV = recentHRV.last else {
            return .moderate
        }

        let clampedHRV = clamp(latestHRV.sdnnMilliseconds, to: hrvPlausibleRangeMs)

        var hrvBand: RecoveryBand
        let hasTrustworthyBaseline =
            baseline.sampleDays >= minimumBaselineDays
                && baseline.meanHRVMilliseconds != nil
                && (baseline.stdDevHRVMilliseconds ?? 0) > 0

        if hasTrustworthyBaseline,
           let mean = baseline.meanHRVMilliseconds,
           let stdDev = baseline.stdDevHRVMilliseconds, stdDev > 0 {
            let zScore = (clampedHRV - mean) / stdDev
            if zScore >= hrvHighZScore {
                hrvBand = .high
            } else if zScore <= hrvLowZScore {
                hrvBand = .low
            } else {
                hrvBand = .moderate
            }
        } else {
            // Insufficient baseline history → population fallback.
            if clampedHRV >= fallbackHRVHighMs {
                hrvBand = .high
            } else if clampedHRV <= fallbackHRVLowMs {
                hrvBand = .low
            } else {
                hrvBand = .moderate
            }
        }

        // Resting-HR trend can nudge the band by one step in either
        // direction, but never further than the adjacent band.
        if let latestRestingHR = recentRestingHR.last,
           let baselineRestingHR = baseline.meanRestingHRBpm,
           baseline.sampleDays >= minimumBaselineDays {
            let clampedRestingHR = clamp(latestRestingHR.beatsPerMinute, to: restingHRPlausibleRangeBpm)
            let delta = clampedRestingHR - baselineRestingHR

            if delta >= restingHRElevatedDeltaBpm {
                hrvBand = stepDown(hrvBand)
            } else if delta <= restingHRDepressedDeltaBpm {
                hrvBand = stepUp(hrvBand)
            }
        }

        return hrvBand
    }

    private static func stepDown(_ band: RecoveryBand) -> RecoveryBand {
        switch band {
        case .high: return .moderate
        case .moderate: return .low
        case .low: return .low
        }
    }

    private static func stepUp(_ band: RecoveryBand) -> RecoveryBand {
        switch band {
        case .low: return .moderate
        case .moderate: return .high
        case .high: return .high
        }
    }

    // MARK: - Sleep quality

    static func deriveSleepQuality(sleep: SleepStageDurations?) -> SleepQualityBand {
        // No sleep data at all → sensible default, no verdict.
        guard let sleep = sleep else {
            return .fair
        }

        let asleep = max(0, sleep.asleepMinutes)
        let totalSession = max(sleep.totalSessionMinutes, asleep) // avoid div-by-zero

        if asleep < sleepPoorMaxMinutes {
            return .poor
        }

        guard asleep >= sleepGoodMinMinutes else {
            // Between poor and good duration cutoffs → fair, regardless of
            // stage distribution.
            return .fair
        }

        let efficiency = totalSession > 0 ? asleep / totalSession : 0
        let restorativeFraction = asleep > 0
            ? (sleep.deepMinutes + sleep.remMinutes) / asleep
            : 0

        if efficiency >= sleepGoodMinEfficiency
            && restorativeFraction >= sleepGoodMinRestorativeFraction {
            return .good
        }

        // Long enough in bed, but fragmented or stage-poor → fair.
        return .fair
    }

    // MARK: - Activity

    static func deriveActivity(
        activity: ActivitySummary,
        baseline: PersonalBaseline
    ) -> ActivityBand {
        let clampedSteps = clamp(activity.steps, to: 0...stepsPlausibleMax)
        let clampedEnergy = clamp(activity.activeEnergyBurnedKcal, to: 0...activeEnergyPlausibleMaxKcal)
        let workoutMinutes = max(0, activity.workoutMinutes)

        // Any recorded workout of meaningful length is a strong active
        // signal regardless of baseline.
        if workoutMinutes >= 20 {
            return .active
        }

        let hasTrustworthyBaseline =
            baseline.sampleDays >= minimumBaselineDays
                && baseline.meanDailySteps != nil
                && baseline.meanDailyActiveEnergyKcal != nil
                && (baseline.meanDailySteps ?? 0) > 0

        if hasTrustworthyBaseline,
           let meanSteps = baseline.meanDailySteps, meanSteps > 0,
           let meanEnergy = baseline.meanDailyActiveEnergyKcal, meanEnergy > 0 {
            let stepRatio = clampedSteps / meanSteps
            let energyRatio = clampedEnergy / meanEnergy
            // Combine the two signals by averaging their baseline ratios.
            let combinedRatio = (stepRatio + energyRatio) / 2.0

            if combinedRatio >= activityActiveRatio {
                return .active
            } else if combinedRatio <= activitySedentaryRatio {
                return .sedentary
            } else {
                return .moderate
            }
        }

        // Insufficient baseline history → population fallback.
        if clampedSteps >= fallbackActiveSteps || clampedEnergy >= fallbackActiveEnergyKcal {
            return .active
        } else if clampedSteps <= fallbackSedentarySteps && clampedEnergy <= fallbackSedentaryEnergyKcal {
            return .sedentary
        } else {
            return .moderate
        }
    }

    // MARK: - Helpers

    private static func clamp(_ value: Double, to range: ClosedRange<Double>) -> Double {
        min(max(value, range.lowerBound), range.upperBound)
    }
}
