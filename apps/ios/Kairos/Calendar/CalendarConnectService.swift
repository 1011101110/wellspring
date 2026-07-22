import Foundation

/// The three calendar-connect paths from docs/05_UX_FLOWS.md §2 screen 3.
public enum CalendarConnectionKind: String, Equatable, Sendable {
    case google
    case appleEventKit
    case emailOnly
}

public enum CalendarConnectStatus: Equatable, Sendable {
    case notConnected
    case connected(CalendarConnectionKind)
    case denied(CalendarConnectionKind)
}

public enum CalendarConnectError: Error, Equatable, LocalizedError {
    case notImplemented(String)
    case permissionDenied
    case cancelled
    case unknown(String)

    public var errorDescription: String? {
        switch self {
        case .notImplemented(let detail):
            return detail
        case .permissionDenied:
            return "Calendar access was denied."
        case .cancelled:
            return "Calendar connect was cancelled."
        case .unknown(let detail):
            return detail
        }
    }
}

/// Abstraction over "how the app connects a calendar," per
/// docs/05_UX_FLOWS.md §2 screen 3 and docs/00_FOUNDATION.md §8 (calendar
/// access is free/busy + event insertion only; titles/attendees are never
/// read for the ambient case).
///
/// - `EventKitCalendarConnectService` is real today: EventKit needs no
///   external OAuth credential, so "I use Apple Calendar" can be fully
///   wired now.
/// - Google OAuth is backend-managed (`ASWebAuthenticationSession` to a
///   backend flow per the UX doc, issue #124) — `GoogleCalendarConnectService`
///   fetches the authorization URL from `GET /v1/connect/google` and drives
///   the session; `EventKitCalendarConnectService` delegates `.google` to
///   it when injected, and falls back to a clear `.notImplemented` error
///   when it isn't (e.g. Demo Mode's `FakeCalendarConnectService`, which
///   intentionally never wires a live Google collaborator).
/// - "Just email me invites" needs no device permission at all; it is
///   satisfied entirely by the invite-email capture step (see
///   `AuthService.setInviteEmail`), so it's modeled here as an always-
///   available connect call that just records the choice.
public protocol CalendarConnectService: AnyObject, Sendable {
    var status: CalendarConnectStatus { get }

    /// Priming copy shown before requesting the given kind's permission,
    /// per docs/05_UX_FLOWS.md §1 P3 ("what we send / what never leaves
    /// your phone").
    func primingCopy(for kind: CalendarConnectionKind) -> (whatWeSend: String, whatNeverLeaves: String)

    @discardableResult
    func connect(_ kind: CalendarConnectionKind) async throws -> CalendarConnectStatus
}

public extension CalendarConnectService {
    func primingCopy(for kind: CalendarConnectionKind) -> (whatWeSend: String, whatNeverLeaves: String) {
        switch kind {
        case .google:
            return (
                whatWeSend: "When you're free or busy, and one new event we create for your devotional.",
                whatNeverLeaves: "Meeting titles, attendees, or locations — and we never store your calendar."
            )
        case .appleEventKit:
            return (
                whatWeSend: "Free/busy times read on this device to find a quiet gap.",
                whatNeverLeaves: "Event titles, attendees, notes, and locations stay on your phone."
            )
        case .emailOnly:
            return (
                whatWeSend: "Nothing beyond the invite email itself — a calendar file (.ics) mailed to you daily.",
                whatNeverLeaves: "We never connect to or read any calendar."
            )
        }
    }
}
