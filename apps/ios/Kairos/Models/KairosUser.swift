import Foundation

/// Minimal authenticated-user shape the app needs.
///
/// Privacy note (docs/00_FOUNDATION.md §8): display name/email are never
/// forwarded to Gloo or YouVersion — this type exists purely for iOS-side
/// account state (sign-in status, invite-email capture, Firebase UID).
public struct KairosUser: Identifiable, Equatable, Sendable {
    public let id: String
    public var displayName: String?
    public var email: String?
    /// True when the email on the account is an Apple private-relay address
    /// (`@privaterelay.appleid.com`) — triggers the explicit invite-email
    /// capture step per docs/05_UX_FLOWS.md §2 screen 2.
    public var isPrivateRelayEmail: Bool
    /// The address the user has confirmed calendar invites should go to.
    /// Distinct from `email` (the auth-provider identity) because Apple
    /// relay emails are not useful as invite destinations.
    public var inviteEmail: String?
    /// True once the invite email has been tap-to-confirm verified.
    public var isInviteEmailVerified: Bool

    public init(
        id: String,
        displayName: String? = nil,
        email: String? = nil,
        isPrivateRelayEmail: Bool = false,
        inviteEmail: String? = nil,
        isInviteEmailVerified: Bool = false
    ) {
        self.id = id
        self.displayName = displayName
        self.email = email
        self.isPrivateRelayEmail = isPrivateRelayEmail
        self.inviteEmail = inviteEmail
        self.isInviteEmailVerified = isInviteEmailVerified
    }

    /// Apple relay emails look like `abc123@privaterelay.appleid.com`.
    public static func isPrivateRelay(_ email: String?) -> Bool {
        guard let email else { return false }
        return email.lowercased().hasSuffix("@privaterelay.appleid.com")
    }
}
