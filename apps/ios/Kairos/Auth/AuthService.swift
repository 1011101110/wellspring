import Foundation

/// Errors an `AuthService` conformance can surface to the UI layer.
public enum AuthError: Error, Equatable, LocalizedError {
    case cancelled
    case notConfigured(String)
    case network(String)
    case invalidCredential
    case unknown(String)

    public var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Sign-in was cancelled."
        case .notConfigured(let detail):
            return "Sign-in isn't configured yet: \(detail)"
        case .network(let detail):
            return "Network problem: \(detail)"
        case .invalidCredential:
            return "That email or password didn't work."
        case .unknown(let detail):
            return detail
        }
    }
}

/// Abstraction over "how the app authenticates a person."
///
/// docs/00_FOUNDATION.md §3 assigns "account sign-in" to the iOS app.
/// docs/01_PRD.md F1 requires Sign in with Apple (primary) + email/password
/// fallback via Firebase Auth. Kept as a protocol so:
///   - `FirebaseAuthService` can be wired against real Firebase once a
///     project + GoogleService-Info.plist exist (currently TODO, see that
///     file) without touching call sites.
///   - `FakeAuthService` gives previews, unit tests, and Demo Mode
///     (docs/05_UX_FLOWS.md §3.1 "Demo mode") a fully working, in-memory
///     stand-in with zero network/Firebase dependency.
public protocol AuthService: AnyObject, Sendable {
    /// The currently signed-in user, or nil if signed out.
    /// Implementations should be observable (see `AuthServiceObserving`)
    /// so SwiftUI views can react to sign-in/sign-out.
    var currentUser: KairosUser? { get }

    @discardableResult
    func signInWithApple() async throws -> KairosUser

    @discardableResult
    func signInWithEmail(email: String, password: String) async throws -> KairosUser

    /// Creates a brand-new account with email + password (issue #71 /
    /// docs/14_IMPROVEMENT_REVIEW.md §1.9: "no email createUser path exists
    /// (sign-up impossible)"). Distinct from `signInWithEmail`, which only
    /// authenticates an *existing* account — Firebase's
    /// `Auth.auth().signIn(withEmail:password:)` throws `.userNotFound` for
    /// an email with no account yet, so a real sign-up flow needs this
    /// separate entry point rather than reusing sign-in.
    @discardableResult
    func signUpWithEmail(email: String, password: String) async throws -> KairosUser

    func signOut() throws

    /// Confirms/updates the invite-email destination (docs/05_UX_FLOWS.md §2
    /// screen 2). Distinct from the auth identity email because Apple relay
    /// addresses are not useful as invite destinations.
    @discardableResult
    func setInviteEmail(_ email: String) async throws -> KairosUser

    /// A fresh Firebase Auth ID token (JWT) for the `Authorization: Bearer`
    /// header on authenticated backend calls (docs/03_API_INTEGRATION_SPEC.md
    /// §8.1). Throws `AuthError.unknown` if no user is signed in.
    func idToken() async throws -> String
}

/// Marker for the `@Published`-style observation the app's view models rely
/// on. `FirebaseAuthService` and `FakeAuthService` both implement this via
/// `ObservableObject` so `@StateObject`/`@ObservedObject` works directly.
public protocol AuthServiceObserving: ObservableObject {
    var currentUser: KairosUser? { get }
}
