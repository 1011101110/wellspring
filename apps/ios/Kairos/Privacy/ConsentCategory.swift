import Foundation

/// The four independently-revocable consent categories on the Data &
/// Privacy screen, per docs/04_DATA_PRIVACY_SECURITY.md §3's consent table
/// and docs/05_UX_FLOWS.md §3.1's "Data & Privacy" row: "Per-category
/// toggles (calendar / recovery / sleep / activity, each independently
/// revocable)."
///
/// This is deliberately a superset-compatible but *separate* enum from
/// `HealthCategory` (Health/HealthConnectService.swift): `HealthCategory`
/// models "which HealthKit read types to request," while
/// `ConsentCategory` models "which signal categories the user has opted
/// into sending to Kairos at all" (calendar is not a HealthKit concept).
/// Keeping them distinct means the OS-permission layer and the
/// user-facing consent layer can never be silently conflated.
public enum ConsentCategory: String, CaseIterable, Equatable, Sendable, Identifiable {
    case calendar
    case recovery
    case sleep
    case activity

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .calendar: return "Calendar"
        case .recovery: return "Recovery (HRV)"
        case .sleep: return "Sleep"
        case .activity: return "Activity"
        }
    }

    /// Plain-language "what we send / what never leaves" copy, matching
    /// the priming-screen pattern already used by `CalendarConnectService`
    /// and `HealthConnectService` (docs/05_UX_FLOWS.md §1 P3).
    public var whatWeSend: String {
        switch self {
        case .calendar:
            return "When you're free or busy, and one new event we create for your devotional."
        case .recovery:
            return "One word — like 'rested' or 'low' — derived from your HRV and resting heart rate."
        case .sleep:
            return "One word — like 'good' or 'short' — derived from last night's sleep."
        case .activity:
            return "One word — like 'active' or 'sedentary' — derived from recent workouts and steps."
        }
    }

    public var whatNeverLeaves: String {
        switch self {
        case .calendar:
            return "Meeting titles, attendees, locations, or notes — and we never store your calendar."
        case .recovery:
            return "Your heart-rate and HRV readings themselves."
        case .sleep:
            return "Sleep stages, times, and duration."
        case .activity:
            return "Your step counts, workouts, and energy burned."
        }
    }

    /// What happens to the product when this category is denied/off, per
    /// docs/04_DATA_PRIVACY_SECURITY.md §3's "Denied behavior" column.
    public var deniedBehaviorDescription: String {
        switch self {
        case .calendar:
            return "Wellspring switches to email-invite-only mode — you pick a fixed time."
        case .recovery, .sleep, .activity:
            return "This band is left out of your devotional; format falls back to your preference."
        }
    }
}
