import Foundation
import BandDeriver

/// Abstraction over "how the app fetches recent HealthKit samples and
/// assembles them into BandDeriver's input shape."
///
/// This is the ONLY seam in the app that imports HealthKit for sample
/// *fetching* (as opposed to `HealthConnectService`, which only handles the
/// authorization prompt). BandDeriver itself (apps/ios/Packages/BandDeriver)
/// stays HealthKit-free by design (issue #36) — it only knows about the
/// plain-Swift structs in `HealthInputs.swift`. This type is the mapping
/// layer the foundation doc's §3 role split requires: "on-device derivation
/// of health bands from HealthKit" is an iOS-app responsibility, and
/// BandDeriver is the pure-function core that derivation calls into.
///
/// Modeled as a protocol (like `HealthConnectService`/`CalendarConnectService`)
/// so the HealthKit-to-`BandDeriverInput` mapping logic is unit-testable
/// with fixture sample data, with zero dependency on a real device or a
/// granted HealthKit authorization (docs/07_TEST_PLAN.md's acknowledged
/// simulator/device limitation only applies to *true background execution
/// timing* and *real permission sheets* — the mapping logic itself does
/// not require either).
public protocol HealthSampleReading: AnyObject, Sendable {
    /// Assembles today's `BandDeriverInput` from HealthKit (or fixture data
    /// in the fake), querying only the given `enabledCategories` (issue #70
    /// / docs/14_IMPROVEMENT_REVIEW.md §1.8): a category the user has
    /// withheld consent for must never be queried from HealthKit at all —
    /// not merely omitted downstream — so its corresponding
    /// `BandDeriverInput` field(s) are populated with the "no evidence"
    /// value (empty array / `nil`) without ever calling into HealthKit for
    /// it. Never throws for "no data" — HealthKit legitimately returns
    /// empty result sets (new user, denied permission, watch not worn) and
    /// `BandDeriverInput` represents that with empty/`nil` fields, which
    /// `BandDeriver.deriveDerivedBands(from:)` maps to an omitted category
    /// rather than a fabricated verdict. This method only throws for
    /// genuine read failures (HealthKit unavailable, or a query itself
    /// erroring — see `HealthSampleReadError.queryFailed`) so callers can
    /// distinguish "legitimately empty" from "failed" and still degrade
    /// gracefully either way (calendar-only mode).
    func readTodayInput(enabledCategories: Set<HealthCategory>) async throws -> BandDeriverInput
}

/// Errors a `HealthSampleReading` conformance can surface. Every case is
/// handled by `BandUploadService` as "degrade gracefully, never crash, app
/// continues in calendar-only mode" (issue #37 acceptance criteria).
public enum HealthSampleReadError: Error, Equatable, LocalizedError {
    case unavailable
    case queryFailed(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Health data isn't available on this device."
        case .queryFailed(let detail):
            return "Couldn't read health data: \(detail)"
        }
    }
}
