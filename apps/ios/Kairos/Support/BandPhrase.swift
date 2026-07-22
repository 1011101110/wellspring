import Foundation
import BandDeriver

/// Maps BandDeriver's on-device `HealthBands` output (plus the two
/// backend-derived bands, `busyness` and `communicationLoad` —
/// docs/00_FOUNDATION.md §5) to the gentle-phrase copy from
/// docs/05_UX_FLOWS.md §3.2 — bands are surfaced as sentences, never
/// numbers (P5, "bands as gentle phrases, never scores/graphs/verdicts").
/// This is the seam where the Kairos app depends on the local BandDeriver
/// Swift package (apps/ios/Packages/BandDeriver, issue #36) rather than
/// reimplementing band derivation.
///
/// `recovery`/`sleepQuality`/`busyness` phrases are pinned verbatim by
/// docs/05_UX_FLOWS.md §3.2's table. `activity` and `communicationLoad`
/// have no entry in that table (only three of the five canonical bands are
/// listed there), so their phrasing here follows the same descriptive,
/// non-judgmental tone rule ("phrases describe, never judge") the doc
/// states applies to all bands, and mirrors the on-device priming copy
/// already shipped in `HealthConnectService.primingCopy(for:)`.
enum BandPhrase {
    static func recoveryPhrase(_ band: RecoveryBand) -> String {
        switch band {
        case .high: return "your body looks rested"
        case .moderate: return "you're doing okay"
        case .low: return "your body is asking for gentleness"
        }
    }

    static func sleepQualityPhrase(_ band: SleepQualityBand) -> String {
        switch band {
        case .good: return "you slept well"
        case .fair: return "sleep was okay"
        case .poor: return "sleep was short last night"
        }
    }

    static func activityPhrase(_ band: ActivityBand) -> String {
        switch band {
        case .active: return "you've been moving today"
        case .moderate: return "a steady amount of movement"
        case .sedentary: return "today has been a quiet, still day"
        }
    }

    /// docs/00_FOUNDATION.md §5 `busyness` values: `light` · `moderate` ·
    /// `heavy`. Phrasing pinned verbatim by docs/05_UX_FLOWS.md §3.2.
    static func busynessPhrase(_ band: String) -> String {
        switch band {
        case "light": return "today has room to breathe"
        case "moderate": return "a steady day"
        case "heavy": return "today looks heavy"
        default: return "calendar-only today"
        }
    }

    /// `communicationLoad` is a stretch signal (§5), off by default, and
    /// `nil` whenever not connected — matched by `nil` here rather than a
    /// band value.
    static func communicationLoadPhrase(_ band: String?) -> String {
        switch band {
        case "light": return "messages have been light"
        case "moderate": return "a normal amount of messages"
        case "heavy": return "messages have been a lot today"
        default: return "not tracked today"
        }
    }

    static func phrases(for bands: HealthBands) -> [String] {
        [recoveryPhrase(bands.recovery), sleepQualityPhrase(bands.sleepQuality)]
    }
}
