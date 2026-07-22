import Foundation

/// Abstraction over "has this device ever finished onboarding" — an
/// explicit, persisted flag written only when `OnboardingContainerView`'s
/// `onComplete` actually fires (the Done screen, docs/05_UX_FLOWS.md §2
/// screen 6).
///
/// Issue #71 (docs/14_IMPROVEMENT_REVIEW.md §1.9): `RootView` used to infer
/// "onboarding is complete" purely from "is a user signed in at launch"
/// (`hasCompletedOnboarding = appEnvironment.authService.currentUser != nil`
/// at `RootView.init`). Once `FirebaseAuthService` correctly restores a
/// session on launch (this same issue's session-restore fix), that
/// inference becomes wrong: a user who is signed in but was killed
/// mid-onboarding (e.g. force-quit right after the invite-email step, well
/// before reaching Done) would relaunch with `currentUser != nil` and be
/// routed straight to the tab shell, skipping the rest of onboarding
/// entirely — the two concerns (signed in vs. finished onboarding) are
/// independent facts and must be tracked independently.
///
/// Mirrors `ConsentStore`/`PreferencesStore`'s protocol-based-DI shape
/// exactly (real `UserDefaults`-backed implementation + in-memory fake for
/// previews/tests/Demo Mode) so this fits the rest of the app's established
/// pattern.
///
/// ## Issue #225: the boolean is now a cache, and a *latch*
///
/// The fact this records — "onboarding was finished" — stopped being a fact
/// about a device the moment a second surface existed. Truth now lives in
/// `users.onboarded_at` (migration 1721800000000), which both iOS and web
/// can see; this store is the local cache of it.
///
/// The reconciliation rule is deliberately **not** the "server wins" rule
/// that governs preferences. Completion is a latch: this device considers
/// onboarding done if *either* the server says so *or* its own cache does,
/// and it pushes its cache up when the server has no record. Three
/// independent reasons, any one of which would be sufficient:
///
///  1. **A failed pull must never mean "not onboarded."** Network
///     unavailability is not evidence about a user's history. If a missing
///     server answer could clear this flag, every user who opens the app on
///     a plane gets marched back through onboarding — losing nothing
///     permanent, but being told the app has forgotten them. That is the
///     single worst outcome available in this change, and a latch makes it
///     unreachable by construction rather than by remembering to write the
///     error branch correctly.
///  2. **`onboarded_at` is legitimately NULL for real, onboarded users.**
///     Everyone who onboarded before #225 shipped has a device flag and no
///     server timestamp (migration 1721800000000 deliberately backfills
///     nothing). Server-wins would re-onboard the entire existing user
///     base on upgrade.
///  3. **The transition it would enable does not exist.** A person who has
///     completed onboarding cannot subsequently un-complete it. There is no
///     true→false edge to model, so the store refuses to represent one —
///     the same reasoning that makes `UsersRepository.markOnboarded`
///     first-write-wins with no un-mark, and the reason the wire field is
///     `z.literal(true)`.
///
/// Convergence still happens, in the only direction that has information in
/// it: `applyServerCompletion` promotes false→true from the server, and
/// `needsServerBackfill` reports the reverse case so the coordinator can
/// write this device's `true` up to a server that has no record.
public protocol OnboardingCompletionStore: AnyObject, Sendable {
    /// `true` once onboarding is known to have been completed on *any*
    /// surface — either `markCompleted()` was called on this device, or a
    /// server pull reported an `onboarded_at` (see `applyServerCompletion`).
    /// `false` for a fresh install that has never synced — never inferred
    /// from sign-in state.
    func hasCompletedOnboarding() -> Bool

    /// Records that onboarding finished (the Done screen was reached and
    /// its "Continue"/finish action was tapped). Idempotent — safe to call
    /// more than once.
    func markCompleted()

    /// Applies the server's `onboarded_at` from a pull.
    ///
    /// Latches: a non-`nil` date marks completion, `nil` does nothing at
    /// all. `nil` is not "the server says they haven't onboarded" — it is
    /// "the server has no record", which is also what a pre-#225 user and
    /// an offline-onboarded user look like. Callers do not need to
    /// special-case a failed pull, because the only safe response to `nil`
    /// and the only safe response to an error are the same response:
    /// leave the cache alone.
    func applyServerCompletion(at onboardedAt: Date?)

    /// `true` when this device believes onboarding is done but the last
    /// pull found no server record — i.e. this cache holds a fact the
    /// server is missing, and should write it up.
    ///
    /// Distinct from `!hasCompletedOnboarding()`: a device that has never
    /// onboarded has nothing to backfill, and must not assert completion
    /// on the server merely because the server agrees it hasn't happened.
    func needsServerBackfill() -> Bool
}

/// Real, local persistence: a single boolean `UserDefaults` key, plus a
/// second key caching the server's timestamp (issue #225).
///
/// The two keys answer different questions and are stored separately for
/// that reason. The boolean is "this device saw onboarding finish"; the
/// timestamp is "the server has a record, as of the last successful pull".
/// Collapsing them would lose the `needsServerBackfill` case — a device
/// that has the boolean and no server record is exactly the pre-#225 user
/// whose completion needs writing up, and a single key cannot distinguish
/// that from a user the server already knows about.
public final class UserDefaultsOnboardingCompletionStore: OnboardingCompletionStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let serverTimestampKey: String

    public init(defaults: UserDefaults = .standard, key: String = "com.kairos.onboarding.completed.v1") {
        self.defaults = defaults
        self.key = key
        self.serverTimestampKey = key + ".serverOnboardedAt"
    }

    public func hasCompletedOnboarding() -> Bool {
        // The local boolean alone is sufficient — `applyServerCompletion`
        // sets it whenever the server reports a timestamp, so this single
        // read already reflects "completed on any surface". Reading the
        // cached server timestamp here as well would be redundant, and
        // would make the answer depend on two keys agreeing.
        defaults.bool(forKey: key)
    }

    public func markCompleted() {
        defaults.set(true, forKey: key)
        // Same rationale as `UserDefaultsConsentStore`/`UserDefaultsPreferencesStore`:
        // this is a rare, one-time, meaningful write — force a synchronous
        // flush so it's never lost to a process kill immediately after
        // (including `XCUIApplication.terminate()` in tests).
        defaults.synchronize()
    }

    public func applyServerCompletion(at onboardedAt: Date?) {
        // Latch (see the protocol doc): `nil` is not evidence of anything,
        // so there is deliberately no `else` clearing either key. This
        // method has exactly one effect and it is monotonic.
        guard let onboardedAt else { return }
        defaults.set(onboardedAt, forKey: serverTimestampKey)
        markCompleted()
    }

    public func needsServerBackfill() -> Bool {
        hasCompletedOnboarding() && defaults.object(forKey: serverTimestampKey) == nil
    }
}

/// In-memory `OnboardingCompletionStore` for previews, unit tests, and Demo
/// Mode — no `UserDefaults`/disk dependency at all.
public final class InMemoryOnboardingCompletionStore: OnboardingCompletionStore, @unchecked Sendable {
    private var completed: Bool
    private var serverOnboardedAt: Date?

    public init(initial: Bool = false, serverOnboardedAt: Date? = nil) {
        self.completed = initial
        self.serverOnboardedAt = serverOnboardedAt
    }

    public func hasCompletedOnboarding() -> Bool {
        completed
    }

    public func markCompleted() {
        completed = true
    }

    /// Same latch as the `UserDefaults` implementation — see the protocol
    /// doc. Duplicated rather than shared via a protocol extension so that
    /// the "there is no `else` branch" property is visible at both real
    /// call sites, which is the property the whole design rests on.
    public func applyServerCompletion(at onboardedAt: Date?) {
        guard let onboardedAt else { return }
        serverOnboardedAt = onboardedAt
        completed = true
    }

    public func needsServerBackfill() -> Bool {
        completed && serverOnboardedAt == nil
    }
}
