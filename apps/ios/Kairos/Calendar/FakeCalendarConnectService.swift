import Foundation

/// In-memory `CalendarConnectService` for previews, unit tests, and Demo
/// Mode. Never touches EventKit or the network.
///
/// Mirrors `EventKitCalendarConnectService`'s handling of `.google`
/// (always `.notImplemented`, since no Google OAuth client exists yet —
/// docs/10_CREDENTIALS_ACCESS.md) so Demo Mode / UI tests exercise the
/// same "denied/unavailable" UX path a real build would show, rather than
/// silently pretending Google Calendar connect works.
public final class FakeCalendarConnectService: CalendarConnectService, @unchecked Sendable {
    public private(set) var status: CalendarConnectStatus
    public var nextError: CalendarConnectError?

    public init(status: CalendarConnectStatus = .notConnected) {
        self.status = status
    }

    @discardableResult
    public func connect(_ kind: CalendarConnectionKind) async throws -> CalendarConnectStatus {
        if let nextError {
            self.nextError = nil
            throw nextError
        }
        if kind == .google {
            throw CalendarConnectError.notImplemented(
                "Google Calendar connect isn't wired to a live OAuth client yet — use \"I use Apple Calendar\" or \"Just email me invites\" for now."
            )
        }
        status = .connected(kind)
        return status
    }
}
