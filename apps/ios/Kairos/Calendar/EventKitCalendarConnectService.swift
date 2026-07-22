import Foundation
import EventKit

/// Real implementation of the "I use Apple Calendar" and "just email me
/// invites" paths (docs/05_UX_FLOWS.md §2 screen 3b/3c) using local
/// EventKit — this needs no external OAuth credential, unlike Google
/// Calendar, so it can be fully live today. `.google` is delegated to an
/// injected collaborator (issue #124) — this type stays EventKit-focused
/// rather than growing a second, unrelated concern.
///
/// Only free/busy is ever read (docs/00_FOUNDATION.md §8): this service
/// intentionally exposes no API for reading event titles/attendees/notes,
/// only the connection/permission lifecycle itself. Actual free/busy gap
/// computation is a separate concern (BusynessAnalyzer, backend-side per
/// docs/00_FOUNDATION.md §3) and out of scope for this service.
public final class EventKitCalendarConnectService: CalendarConnectService, @unchecked Sendable {
    private let store = EKEventStore()
    private var _status: CalendarConnectStatus = .notConnected
    /// `.google` delegates here (issue #124). `nil` (the default) preserves
    /// the pre-#124 "not implemented" behavior for any call site that
    /// doesn't explicitly wire a real Google collaborator — e.g. tests that
    /// only care about the EventKit/email paths.
    private let googleConnectService: (any CalendarConnectService)?

    public var status: CalendarConnectStatus {
        if let googleConnectService, case .connected(.google) = googleConnectService.status {
            return googleConnectService.status
        }
        return _status
    }

    public init(googleConnectService: (any CalendarConnectService)? = nil) {
        self.googleConnectService = googleConnectService
        _status = Self.currentStatus(for: EKEventStore.authorizationStatus(for: .event))
    }

    @discardableResult
    public func connect(_ kind: CalendarConnectionKind) async throws -> CalendarConnectStatus {
        switch kind {
        case .appleEventKit:
            return try await connectEventKit()
        case .emailOnly:
            // No device permission required — recording the choice is the
            // entire "connection."
            _status = .connected(.emailOnly)
            return _status
        case .google:
            guard let googleConnectService else {
                throw CalendarConnectError.notImplemented(
                    "Google Calendar connect requires a Google OAuth client, which does not exist yet in this environment. See docs/10_CREDENTIALS_ACCESS.md."
                )
            }
            return try await googleConnectService.connect(.google)
        }
    }

    private func connectEventKit() async throws -> CalendarConnectStatus {
        let granted: Bool
        do {
            if #available(iOS 17.0, *) {
                granted = try await store.requestFullAccessToEvents()
            } else {
                granted = try await withCheckedThrowingContinuation { continuation in
                    store.requestAccess(to: .event) { granted, error in
                        if let error {
                            continuation.resume(throwing: error)
                        } else {
                            continuation.resume(returning: granted)
                        }
                    }
                }
            }
        } catch {
            _status = .denied(.appleEventKit)
            throw CalendarConnectError.unknown(error.localizedDescription)
        }

        if granted {
            _status = .connected(.appleEventKit)
            return _status
        }

        // Denied/restricted: throw `.permissionDenied` rather than
        // returning `.denied(.appleEventKit)` as a "successful" value.
        // `OnboardingViewModel.connectCalendar` degrades a thrown
        // `.permissionDenied` to email-invites-only mode
        // (docs/04_DATA_PRIVACY_SECURITY.md §3 "Denied behavior:
        // .ics-invite-only mode") — that branch only fires on a thrown
        // error, so a silent non-throwing `.denied` return here would leave
        // the user stranded in a `.denied` status the rest of the app never
        // checks for. Mirrors `FakeCalendarConnectService`'s
        // `nextError = .permissionDenied` contract exactly, so the same
        // view-model test coverage proves both paths.
        _status = .denied(.appleEventKit)
        throw CalendarConnectError.permissionDenied
    }

    private static func currentStatus(for authStatus: EKAuthorizationStatus) -> CalendarConnectStatus {
        switch authStatus {
        case .authorized, .fullAccess:
            return .connected(.appleEventKit)
        case .denied, .restricted, .writeOnly:
            return .denied(.appleEventKit)
        case .notDetermined:
            return .notConnected
        @unknown default:
            return .notConnected
        }
    }
}
