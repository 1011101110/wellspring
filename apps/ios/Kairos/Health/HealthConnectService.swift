import Foundation

/// The three independently-toggleable HealthKit categories from
/// docs/05_UX_FLOWS.md §2 screen 4 / docs/04_DATA_PRIVACY_SECURITY.md §3.
/// Mirrors `BandDeriver`'s three closed bands (`RecoveryBand`,
/// `SleepQualityBand`, `ActivityBand`) one-for-one — each category maps to
/// exactly one on-device-derived band and nothing else is ever requested.
public enum HealthCategory: String, CaseIterable, Equatable, Sendable {
    case recovery
    case sleepQuality
    case activity
}

/// Per-category authorization state. HealthKit itself only exposes a
/// coarse "have we asked" signal for read permissions (Apple does not let
/// apps distinguish "denied" from "granted" for privacy-sensitive read
/// types), so this is intentionally a simple two-state model from the
/// app's point of view plus "not yet requested."
public enum HealthAuthState: Equatable, Sendable {
    case notRequested
    case requested
    case denied
}

public enum HealthConnectError: Error, Equatable, LocalizedError {
    case unavailable
    case cancelled
    case unknown(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Health data isn't available on this device."
        case .cancelled:
            return "Health sharing was cancelled."
        case .unknown(let detail):
            return detail
        }
    }
}

/// Abstraction over "how the app requests HealthKit read access," per
/// docs/05_UX_FLOWS.md §2 screen 4 and docs/04_DATA_PRIVACY_SECURITY.md §3:
/// each of the three categories is requested (and revocable) independently,
/// and only categories the user explicitly toggles on are ever requested
/// from HealthKit. Raw samples never leave the device — this service exists
/// purely to gate *whether BandDeriver ever runs* for a given category; the
/// actual sample-fetching + band derivation is a separate concern (the app
/// assembles `BandDeriverInput` from HealthKit queries and calls into the
/// existing `BandDeriver` package).
public protocol HealthConnectService: AnyObject, Sendable {
    /// Priming copy shown before requesting the given category, per
    /// docs/05_UX_FLOWS.md §1 P3 / §2 screen 4 ("what we send / what never
    /// leaves your phone").
    func primingCopy(for category: HealthCategory) -> (whatWeSend: String, whatNeverLeaves: String)

    /// Requests HealthKit read authorization for exactly the given set of
    /// categories (categories not in the set are never touched). Returns
    /// the resulting per-category auth state.
    func requestAuthorization(for categories: Set<HealthCategory>) async throws -> [HealthCategory: HealthAuthState]
}

public extension HealthConnectService {
    func primingCopy(for category: HealthCategory) -> (whatWeSend: String, whatNeverLeaves: String) {
        switch category {
        case .recovery:
            return (
                whatWeSend: "One word — like 'rested' or 'low' — derived from your HRV and resting heart rate.",
                whatNeverLeaves: "Your heart-rate and HRV readings themselves."
            )
        case .sleepQuality:
            return (
                whatWeSend: "One word — like 'good' or 'short'  — derived from last night's sleep.",
                whatNeverLeaves: "Sleep stages, times, and duration."
            )
        case .activity:
            return (
                whatWeSend: "One word — like 'active' or 'sedentary' — derived from recent workouts and steps.",
                whatNeverLeaves: "Your step counts, workouts, and energy burned."
            )
        }
    }
}
