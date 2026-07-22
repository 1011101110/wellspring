import Foundation

/// Real implementation of the "Connect Google Calendar" path
/// (docs/05_UX_FLOWS.md §2 screen 3a), issue #124. Replaces
/// `StubGoogleCalendarConnectService`'s permanent `.notImplemented` — shape
/// kept identical to that stub's own TODO comment: `connect(.google)` kicks
/// off the web session and resolves to `.connected(.google)` on success.
///
/// Composes two collaborators rather than importing `URLSession`/
/// `AuthenticationServices` directly, so the orchestration below (fetch
/// authUrl -> present session -> parse callback) is unit-testable against
/// fakes with zero live network or UI dependency:
/// - `GoogleConnecting` — HTTP call to `GET /v1/connect/google`.
/// - `GoogleOAuthSessionRunning` — the `ASWebAuthenticationSession` seam.
public final class GoogleCalendarConnectService: CalendarConnectService, @unchecked Sendable {
    /// The scheme registered in `Info.plist`'s `CFBundleURLTypes` and
    /// matched against the backend's final redirect
    /// (`apps/api/src/routes/connect.ts`'s `mobileCallbackScheme`, default
    /// `"kairos"` — must stay in sync with that default).
    private static let callbackURLScheme = "kairos"

    private let connectClient: any GoogleConnecting
    private let sessionRunner: any GoogleOAuthSessionRunning
    private var _status: CalendarConnectStatus

    public var status: CalendarConnectStatus { _status }

    public init(
        connectClient: any GoogleConnecting,
        sessionRunner: any GoogleOAuthSessionRunning,
        status: CalendarConnectStatus = .notConnected
    ) {
        self.connectClient = connectClient
        self.sessionRunner = sessionRunner
        self._status = status
    }

    @discardableResult
    public func connect(_ kind: CalendarConnectionKind) async throws -> CalendarConnectStatus {
        guard kind == .google else {
            throw CalendarConnectError.notImplemented("GoogleCalendarConnectService only handles .google.")
        }

        let authURL: URL
        do {
            authURL = try await connectClient.fetchAuthorizationURL()
        } catch let error as GoogleConnectClientError {
            throw CalendarConnectError.unknown(error.errorDescription ?? "Could not start Google Calendar connect.")
        }

        let callbackURL: URL
        do {
            callbackURL = try await sessionRunner.run(url: authURL, callbackURLScheme: Self.callbackURLScheme)
        } catch let error as GoogleOAuthSessionError {
            _status = .notConnected
            switch error {
            case .cancelled:
                throw CalendarConnectError.cancelled
            case .presentationFailed(let detail):
                throw CalendarConnectError.unknown(detail)
            }
        }

        switch GoogleOAuthCallbackParser.parse(callbackURL) {
        case .success(let status):
            _status = status
            return status
        case .failure(let error):
            _status = (error == .permissionDenied) ? .denied(.google) : .notConnected
            throw error
        }
    }
}
