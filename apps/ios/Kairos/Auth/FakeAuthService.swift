import Foundation
import Combine

/// In-memory `AuthService` used for SwiftUI previews, unit tests, and
/// Demo Mode (docs/05_UX_FLOWS.md §3.1 "Demo mode" — fixture persona,
/// zero live network calls, per docs/00_FOUNDATION.md §11 "Fixture/demo
/// mode is mandatory").
///
/// Not thread-hostile: all mutation happens on the main actor since this
/// only ever backs UI state.
@MainActor
public final class FakeAuthService: ObservableObject, AuthService, AuthServiceObserving {
    @Published public private(set) var currentUser: KairosUser?

    /// When true, `signInWithApple`/`signInWithEmail` simulate the Apple
    /// private-relay case (docs/05_UX_FLOWS.md §2 screen 2) so the
    /// invite-email capture step can be previewed/tested deterministically.
    public var simulatesPrivateRelayEmail: Bool

    /// Optional injected failure for testing error paths.
    public var nextSignInError: AuthError?

    public init(
        initialUser: KairosUser? = nil,
        simulatesPrivateRelayEmail: Bool = false
    ) {
        self.currentUser = initialUser
        self.simulatesPrivateRelayEmail = simulatesPrivateRelayEmail
    }

    @discardableResult
    public func signInWithApple() async throws -> KairosUser {
        if let error = nextSignInError {
            nextSignInError = nil
            throw error
        }
        let email = simulatesPrivateRelayEmail
            ? "abc123.def456@privaterelay.appleid.com"
            : "demo.user@example.com"
        let user = KairosUser(
            id: "apple-\(UUID().uuidString.prefix(8))",
            displayName: "Demo User",
            email: email,
            isPrivateRelayEmail: KairosUser.isPrivateRelay(email)
        )
        currentUser = user
        return user
    }

    @discardableResult
    public func signInWithGoogle() async throws -> KairosUser {
        if let error = nextSignInError {
            nextSignInError = nil
            throw error
        }
        // Google accounts always expose a real address (no Apple-style
        // private relay), so this path never triggers the invite-email
        // relay explainer.
        let email = "demo.user@gmail.com"
        let user = KairosUser(
            id: "google-\(UUID().uuidString.prefix(8))",
            displayName: "Demo User",
            email: email,
            isPrivateRelayEmail: false
        )
        currentUser = user
        return user
    }

    @discardableResult
    public func signInWithEmail(email: String, password: String) async throws -> KairosUser {
        if let error = nextSignInError {
            nextSignInError = nil
            throw error
        }
        guard !email.isEmpty, password.count >= 6 else {
            throw AuthError.invalidCredential
        }
        let user = KairosUser(
            id: "email-\(UUID().uuidString.prefix(8))",
            displayName: nil,
            email: email,
            isPrivateRelayEmail: false
        )
        currentUser = user
        return user
    }

    @discardableResult
    public func signUpWithEmail(email: String, password: String) async throws -> KairosUser {
        if let error = nextSignInError {
            nextSignInError = nil
            throw error
        }
        guard !email.isEmpty, password.count >= 6 else {
            throw AuthError.invalidCredential
        }
        let user = KairosUser(
            id: "email-signup-\(UUID().uuidString.prefix(8))",
            displayName: nil,
            email: email,
            isPrivateRelayEmail: false
        )
        currentUser = user
        return user
    }

    public func signOut() throws {
        currentUser = nil
    }

    @discardableResult
    public func setInviteEmail(_ email: String) async throws -> KairosUser {
        guard var user = currentUser else {
            throw AuthError.unknown("No signed-in user to attach an invite email to.")
        }
        guard email.contains("@"), email.contains(".") else {
            throw AuthError.invalidCredential
        }
        user.inviteEmail = email
        user.isInviteEmailVerified = true // fake service treats confirmation as instant
        currentUser = user
        return user
    }

    /// Deterministic fake token — never a real JWT, never sent anywhere
    /// live (Demo Mode has no live network dependency, docs/00_FOUNDATION
    /// §11), but stable enough for tests to assert on.
    public func idToken() async throws -> String {
        guard let currentUser else {
            throw AuthError.unknown("No signed-in user to mint a token for.")
        }
        return "fake-id-token-\(currentUser.id)"
    }
}

public extension KairosUser {
    /// Fixture persona for previews/demo mode — David, per docs/01_PRD.md §5
    /// and docs/05_UX_FLOWS.md §8 (`low_poor_heavy` fallback key).
    static let demoDavid = KairosUser(
        id: "demo-david",
        displayName: "David",
        email: "david@example.com",
        isPrivateRelayEmail: false,
        inviteEmail: "david@example.com",
        isInviteEmailVerified: true
    )
}
