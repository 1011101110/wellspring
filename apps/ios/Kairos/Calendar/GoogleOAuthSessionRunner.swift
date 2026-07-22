import Foundation
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Abstraction over "how the app presents the Google OAuth web session and
/// waits for the callback" — the only seam in the app that imports
/// `AuthenticationServices` (mirrors `HealthSampleReading`'s doc comment:
/// "the ONLY seam ... so the mapping logic is unit-testable ... with zero
/// dependency on a real device"). `GoogleCalendarConnectService` depends on
/// this protocol, not on `ASWebAuthenticationSession` directly, so its
/// orchestration logic (start session → parse callback → map to
/// `CalendarConnectStatus`) is testable with a fake, with no real UI
/// presentation involved.
public protocol GoogleOAuthSessionRunning: Sendable {
    /// Presents `url` in an ephemeral web session and suspends until the
    /// session completes — either by navigating to `callbackURLScheme`
    /// (returned as the callback URL) or by being cancelled/erroring.
    func run(url: URL, callbackURLScheme: String) async throws -> URL
}

public enum GoogleOAuthSessionError: Error, Equatable, LocalizedError {
    case cancelled
    case presentationFailed(String)

    public var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Calendar connect was cancelled."
        case .presentationFailed(let detail):
            return detail
        }
    }
}

#if canImport(AuthenticationServices)
/// Real implementation: a single-use `ASWebAuthenticationSession` per
/// `run(url:callbackURLScheme:)` call. `ASWebAuthenticationSession` itself
/// (not this wrapper) detects navigation to `callbackURLScheme` and
/// auto-dismisses — see docs/16_CALENDAR_INTEGRATION.md §1's "iOS
/// completion mechanism" note for why the backend's redirect target had to
/// change for this to work at all.
@MainActor
public final class ASWebAuthenticationGoogleOAuthSessionRunner: NSObject, GoogleOAuthSessionRunning {
    public override init() {
        super.init()
    }

    public func run(url: URL, callbackURLScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackURLScheme
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                    return
                }
                if let authError = error as? ASWebAuthenticationSessionError,
                   authError.code == .canceledLogin {
                    continuation.resume(throwing: GoogleOAuthSessionError.cancelled)
                    return
                }
                continuation.resume(
                    throwing: GoogleOAuthSessionError.presentationFailed(
                        error?.localizedDescription ?? "Unknown ASWebAuthenticationSession error."
                    )
                )
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            if !session.start() {
                continuation.resume(
                    throwing: GoogleOAuthSessionError.presentationFailed("Could not start the web authentication session.")
                )
            }
        }
    }
}

extension ASWebAuthenticationGoogleOAuthSessionRunner: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        return UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }
}
#endif

/// In-memory `GoogleOAuthSessionRunning` for unit tests.
public final class FakeGoogleOAuthSessionRunner: GoogleOAuthSessionRunning, @unchecked Sendable {
    public var nextResult: Result<URL, Error> = .success(
        URL(string: "kairos://connect-callback?status=success")!
    )
    public private(set) var lastRequestedURL: URL?
    public private(set) var lastCallbackScheme: String?

    public init() {}

    public func run(url: URL, callbackURLScheme: String) async throws -> URL {
        lastRequestedURL = url
        lastCallbackScheme = callbackURLScheme
        return try nextResult.get()
    }
}

/// Pure parsing of the callback URL's `status`/`reason` query params into a
/// `CalendarConnectStatus`/thrown `CalendarConnectError` — fully
/// unit-testable with no framework dependency (mirrors this codebase's
/// consistent split of "pure logic" from "framework glue," e.g.
/// `HealthKitMapping` vs `HealthKitSampleReader`).
enum GoogleOAuthCallbackParser {
    static func parse(_ url: URL) -> Result<CalendarConnectStatus, CalendarConnectError> {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = components?.queryItems ?? []
        let status = query.first(where: { $0.name == "status" })?.value

        switch status {
        case "success":
            return .success(.connected(.google))
        case "error":
            let reason = query.first(where: { $0.name == "reason" })?.value
            if reason == "denied" {
                return .failure(.permissionDenied)
            }
            return .failure(.unknown(reason ?? "Google Calendar connect failed."))
        default:
            return .failure(.unknown("Unrecognized callback: \(url.absoluteString)"))
        }
    }
}
