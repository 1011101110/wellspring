import Foundation
import Combine

/// Type-erased `AuthService` that is also a concrete `ObservableObject`,
/// so SwiftUI's `@ObservedObject`/`@StateObject` (which need a concrete
/// type, not an existential) can observe `currentUser` changes regardless
/// of which underlying implementation (`FirebaseAuthService`,
/// `FakeAuthService`, ...) is actually wired at the composition root
/// (`AppEnvironment`). This is what lets Demo Mode / UI tests swap in
/// `FakeAuthService` without every view needing to be generic.
@MainActor
public final class AnyAuthService: ObservableObject, AuthService, AuthServiceObserving {
    @Published public private(set) var currentUser: KairosUser?

    private let base: any AuthService
    private var cancellable: AnyCancellable?

    public init<Base: AuthService & AuthServiceObserving>(_ base: Base) where Base.ObjectWillChangePublisher == ObservableObjectPublisher {
        self.base = base
        self.currentUser = base.currentUser
        cancellable = base.objectWillChange.sink { [weak self, weak base] _ in
            // objectWillChange fires before the property updates, so hop to
            // the next runloop turn to read the settled value.
            DispatchQueue.main.async {
                self?.currentUser = base?.currentUser
            }
        }
    }

    @discardableResult
    public func signInWithApple() async throws -> KairosUser {
        let user = try await base.signInWithApple()
        currentUser = base.currentUser
        return user
    }

    @discardableResult
    public func signInWithEmail(email: String, password: String) async throws -> KairosUser {
        let user = try await base.signInWithEmail(email: email, password: password)
        currentUser = base.currentUser
        return user
    }

    @discardableResult
    public func signUpWithEmail(email: String, password: String) async throws -> KairosUser {
        let user = try await base.signUpWithEmail(email: email, password: password)
        currentUser = base.currentUser
        return user
    }

    public func signOut() throws {
        try base.signOut()
        currentUser = base.currentUser
    }

    @discardableResult
    public func setInviteEmail(_ email: String) async throws -> KairosUser {
        let user = try await base.setInviteEmail(email)
        currentUser = base.currentUser
        return user
    }

    public func idToken() async throws -> String {
        try await base.idToken()
    }
}
