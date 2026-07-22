import Foundation
import Combine
import AuthenticationServices
import CryptoKit
#if canImport(FirebaseCore)
import FirebaseCore
#endif
#if canImport(FirebaseAuth)
import FirebaseAuth
#endif

/// Real `AuthService` backed by Firebase Auth (Sign in with Apple + email
/// fallback), per docs/00_FOUNDATION.md §3 and docs/01_PRD.md F1.
///
/// `FirebaseApp.configure()` is only called if a config plist is actually
/// present in the bundle, so the app never crashes on launch without live
/// credentials — it leaves `isConfigured == false` and every method throws
/// `.notConfigured` in that case. As of docs/10_CREDENTIALS_ACCESS.md item
/// 6, a real Firebase project is now provisioned (Email/Password provider
/// enabled) and `apps/ios/Kairos/GoogleService-Info.plist` is committed
/// (public-safe config, not a secret), so `isConfigured == true` and email
/// sign-in is live in this build. This guard is kept regardless — it's
/// what lets the app still build/run/test cleanly in any environment that
/// doesn't have the plist (e.g. a fork, or CI before secrets are wired).
///
/// TODO(live-auth): Sign in with Apple specifically still needs an Apple
/// Developer Program membership (Team ID/Services ID/.p8 key) — nothing
/// GCP-side substitutes for that, so the Apple path remains untested
/// end-to-end until that credential exists (docs/10_CREDENTIALS_ACCESS.md
/// item 5). The email/password path's Firebase calls are the right shape
/// already (`Auth.auth().createUser`/`signIn`).
@MainActor
public final class FirebaseAuthService: NSObject, ObservableObject, AuthService, AuthServiceObserving {
    @Published public private(set) var currentUser: KairosUser?

    /// True only if Firebase was actually able to configure itself (i.e. a
    /// GoogleService-Info.plist was present in the bundle). UI can use this
    /// to decide whether to even offer live sign-in vs. falling back to
    /// demo mode.
    public private(set) var isConfigured: Bool = false

    private var appleSignInContinuation: CheckedContinuation<KairosUser, Error>?
    private var currentAppleNonce: String?

    #if canImport(FirebaseAuth)
    /// Handle for `Auth.auth().removeStateDidChangeListener(_:)`, kept for
    /// the (currently untriggered, since this service lives for the app's
    /// whole process lifetime) case of tearing this listener down.
    private var authStateListenerHandle: AuthStateDidChangeListenerHandle?
    #endif

    public override init() {
        super.init()
        configureFirebaseIfPossible()
    }

    private func configureFirebaseIfPossible() {
        #if canImport(FirebaseCore)
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            // No live project yet — guard so we never crash without a plist.
            isConfigured = false
            return
        }
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        isConfigured = true
        #if canImport(FirebaseAuth)
        restoreSessionAndObserveAuthState()
        #endif
        #else
        isConfigured = false
        #endif
    }

    #if canImport(FirebaseAuth)
    /// Issue #71 (docs/14_IMPROVEMENT_REVIEW.md §1.9): this service used to
    /// never restore a session at all — `currentUser` started `nil` on
    /// every launch regardless of whether Firebase itself had a persisted
    /// session (`Auth.auth().currentUser` is restored from Keychain by the
    /// SDK automatically), so `RootView` always re-ran onboarding from
    /// scratch even for a genuinely still-signed-in user. Two mechanisms,
    /// deliberately both present:
    ///   1. Seed `currentUser` synchronously from `Auth.auth().currentUser`
    ///      right now, so a `RootView` that reads `authService.currentUser`
    ///      on its very first render (before any async work has a chance
    ///      to run) already sees the restored session, not a transient
    ///      `nil`.
    ///   2. `addStateDidChangeListener` for every *subsequent* change
    ///      (sign-in, sign-out, token refresh finishing, or Firebase
    ///      finishing its own async session-restore slightly after this
    ///      initializer returns) — this is the source of truth going
    ///      forward, not just a one-time seed. `@Published currentUser`'s
    ///      willSet fires `objectWillChange`, which `AnyAuthService`
    ///      already forwards (see that type's `init`), so this needs no
    ///      other wiring for the rest of the app to observe it.
    private func restoreSessionAndObserveAuthState() {
        currentUser = Auth.auth().currentUser.map(Self.map)
        authStateListenerHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            self?.currentUser = user.map(Self.map)
        }
    }
    #endif

    @discardableResult
    public func signInWithApple() async throws -> KairosUser {
        guard isConfigured else {
            throw AuthError.notConfigured("No Firebase project connected yet (missing GoogleService-Info.plist).")
        }
        #if canImport(FirebaseAuth)
        let nonce = Self.randomNonceString()
        currentAppleNonce = nonce

        return try await withCheckedThrowingContinuation { continuation in
            self.appleSignInContinuation = continuation
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            request.nonce = Self.sha256(nonce)

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
        #else
        throw AuthError.notConfigured("FirebaseAuth SDK not linked.")
        #endif
    }

    @discardableResult
    public func signInWithEmail(email: String, password: String) async throws -> KairosUser {
        guard isConfigured else {
            throw AuthError.notConfigured("No Firebase project connected yet (missing GoogleService-Info.plist).")
        }
        #if canImport(FirebaseAuth)
        do {
            let result = try await Auth.auth().signIn(withEmail: email, password: password)
            let user = Self.map(result.user)
            currentUser = user
            return user
        } catch {
            throw Self.mapAuthError(error)
        }
        #else
        throw AuthError.notConfigured("FirebaseAuth SDK not linked.")
        #endif
    }

    /// Creates a brand-new account (issue #71 /
    /// docs/14_IMPROVEMENT_REVIEW.md §1.9: "no email createUser path
    /// exists (sign-up impossible)"). `Auth.auth().createUser` both creates
    /// the account and signs the caller in on success, matching
    /// `signInWithEmail`'s "returns + sets `currentUser`" contract.
    @discardableResult
    public func signUpWithEmail(email: String, password: String) async throws -> KairosUser {
        guard isConfigured else {
            throw AuthError.notConfigured("No Firebase project connected yet (missing GoogleService-Info.plist).")
        }
        #if canImport(FirebaseAuth)
        do {
            let result = try await Auth.auth().createUser(withEmail: email, password: password)
            let user = Self.map(result.user)
            currentUser = user
            return user
        } catch {
            throw Self.mapAuthError(error)
        }
        #else
        throw AuthError.notConfigured("FirebaseAuth SDK not linked.")
        #endif
    }

    public func signOut() throws {
        #if canImport(FirebaseAuth)
        guard isConfigured else {
            currentUser = nil
            return
        }
        do {
            try Auth.auth().signOut()
        } catch {
            throw AuthError.unknown(error.localizedDescription)
        }
        #endif
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
        // TODO(live-auth): call backend verification-email endpoint here
        // (docs/05_UX_FLOWS.md §2: "we send a verification email (tap-to-
        // confirm) before .ics delivery is enabled"). Until the backend
        // contract for this exists, mark unverified locally.
        user.inviteEmail = email
        user.isInviteEmailVerified = false
        currentUser = user
        return user
    }

    public func idToken() async throws -> String {
        guard isConfigured else {
            throw AuthError.notConfigured("No Firebase project connected yet (missing GoogleService-Info.plist).")
        }
        #if canImport(FirebaseAuth)
        guard let user = Auth.auth().currentUser else {
            throw AuthError.unknown("No signed-in user to mint a token for.")
        }
        do {
            return try await user.getIDToken()
        } catch {
            throw AuthError.network(error.localizedDescription)
        }
        #else
        throw AuthError.notConfigured("FirebaseAuth SDK not linked.")
        #endif
    }

    #if canImport(FirebaseAuth)
    private static func map(_ user: FirebaseAuth.User) -> KairosUser {
        let email = user.email
        return KairosUser(
            id: user.uid,
            displayName: user.displayName,
            email: email,
            isPrivateRelayEmail: KairosUser.isPrivateRelay(email)
        )
    }

    /// Maps a thrown Firebase Auth error to this app's `AuthError` taxonomy
    /// (issue #71 / docs/14_IMPROVEMENT_REVIEW.md §1.9: "AuthError taxonomy
    /// maps everything to `.network`" — every sign-in/sign-up failure used
    /// to surface as a generic network error regardless of cause, so a
    /// wrong password and an actual offline device were indistinguishable
    /// to the user).
    ///
    /// Firebase Auth errors are `NSError`s in the `FIRAuthErrorDomain`
    /// domain whose `code` is one of `AuthErrorCode`'s raw `Int` values
    /// (`AuthErrorCode` itself conforms to `Error`, but the SDK's async
    /// APIs throw the underlying `NSError`, not a typed `AuthErrorCode`
    /// case directly — bridging via `NSError.code` is the standard,
    /// Firebase-documented pattern for recovering it).
    private static func mapAuthError(_ error: Error) -> AuthError {
        let nsError = error as NSError
        guard let code = AuthErrorCode(rawValue: nsError.code) else {
            return .network(error.localizedDescription)
        }
        switch code {
        case .wrongPassword, .userNotFound:
            // Per this task's explicit mapping: both "no account with this
            // email" and "wrong password for this account" surface as the
            // same `.invalidCredential` — mirroring Apple/Google's own
            // practice of not revealing *which* of the two is wrong (that
            // distinction is itself a minor account-enumeration signal).
            return .invalidCredential
        case .invalidCredential, .invalidEmail:
            return .invalidCredential
        case .emailAlreadyInUse:
            return .unknown("An account with this email already exists.")
        case .weakPassword:
            return .unknown("That password is too weak — try a longer one.")
        case .userDisabled:
            return .unknown("This account has been disabled.")
        case .tooManyRequests:
            return .unknown("Too many attempts — please wait a moment and try again.")
        case .networkError:
            return .network(error.localizedDescription)
        default:
            return .unknown(error.localizedDescription)
        }
    }
    #endif

    // MARK: - Apple nonce helpers (Firebase-recommended replay protection)

    private static func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remainingLength = length
        while remainingLength > 0 {
            var randoms = [UInt8](repeating: 0, count: 16)
            let status = SecRandomCopyBytes(kSecRandomDefault, randoms.count, &randoms)
            precondition(status == errSecSuccess)
            randoms.forEach { random in
                if remainingLength == 0 { return }
                if random < charset.count {
                    result.append(charset[Int(random)])
                    remainingLength -= 1
                }
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        let hashed = SHA256.hash(data: Data(input.utf8))
        return hashed.compactMap { String(format: "%02x", $0) }.joined()
    }
}

#if canImport(FirebaseAuth)
extension FirebaseAuthService: ASAuthorizationControllerDelegate {
    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard
            let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let nonce = currentAppleNonce,
            let identityTokenData = appleIDCredential.identityToken,
            let identityToken = String(data: identityTokenData, encoding: .utf8)
        else {
            appleSignInContinuation?.resume(throwing: AuthError.invalidCredential)
            appleSignInContinuation = nil
            return
        }

        let credential = OAuthProvider.appleCredential(
            withIDToken: identityToken,
            rawNonce: nonce,
            fullName: appleIDCredential.fullName
        )

        Task { @MainActor in
            do {
                let result = try await Auth.auth().signIn(with: credential)
                var user = Self.map(result.user)
                // Apple only shares fullName on first authorization; Firebase
                // doesn't always persist it onto the FirebaseAuth.User, so
                // fall back to the raw credential the first time through.
                if user.displayName == nil,
                   let given = appleIDCredential.fullName?.givenName {
                    user.displayName = given
                }
                self.currentUser = user
                self.appleSignInContinuation?.resume(returning: user)
            } catch {
                self.appleSignInContinuation?.resume(throwing: AuthError.network(error.localizedDescription))
            }
            self.appleSignInContinuation = nil
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            appleSignInContinuation?.resume(throwing: AuthError.cancelled)
        } else {
            appleSignInContinuation?.resume(throwing: AuthError.network(error.localizedDescription))
        }
        appleSignInContinuation = nil
    }
}

extension FirebaseAuthService: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
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

#if canImport(UIKit)
import UIKit
#endif
