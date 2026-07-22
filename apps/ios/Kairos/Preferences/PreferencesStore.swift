import Foundation

/// Abstraction over "where preferences (F7 / docs/01_PRD.md) are
/// persisted." `save` always validates (`OnboardingPreferences.validated()`)
/// before writing and returns the validated value, so callers never need to
/// separately clamp before persisting and can trust whatever they get back.
///
/// - `UserDefaultsPreferencesStore` is the real, local-only implementation
///   used today: on-device persistence with zero backend dependency, so
///   preferences survive app relaunch immediately.
/// - `RemotePreferencesSyncing` (below) is the seam for pushing/pulling
///   preferences to the backend once that endpoint exists
///   (docs/03_API_INTEGRATION_SPEC.md doesn't yet define one) — kept as a
///   separate protocol rather than baked into `PreferencesStore` so the
///   on-device store stays simple and fully functional with no backend at
///   all, matching this task's "clear seam for syncing to the backend
///   later" instruction.
/// - `InMemoryPreferencesStore` backs previews/tests/Demo Mode.
public protocol PreferencesStore: AnyObject, Sendable {
    /// Loads the persisted preferences, or `.defaults` if nothing has been
    /// saved yet (first launch, or a fresh install).
    func load() -> OnboardingPreferences

    /// Validates and persists `preferences`, returning the validated value
    /// actually written (see `OnboardingPreferences.validated()`).
    @discardableResult
    func save(_ preferences: OnboardingPreferences) -> OnboardingPreferences

    /// Counts local writes, monotonically, for the lifetime of this store
    /// instance. Incremented by every `save`, never by applying a pulled
    /// server value.
    ///
    /// This exists to close a real race introduced by issue #225's "server
    /// wins on pull" rule. A pull is not instantaneous — it is a network
    /// round trip of unbounded duration — and the user is free to change a
    /// setting while one is in flight. Without a guard, this sequence
    /// silently destroys a deliberate user action:
    ///
    ///   1. App foregrounds; `pull()` starts. Server holds voice = calm.
    ///   2. User opens Preferences and picks voice = bright. Saved locally,
    ///      push starts.
    ///   3. The pull (which left before the user touched anything) returns
    ///      voice = calm and, being "authoritative", overwrites the choice
    ///      the user just made and watched take effect.
    ///
    /// The user sees their setting revert by itself, which is exactly the
    /// class of failure #193 is about: a setting that appears to work and
    /// doesn't. Note that step 2's push does eventually reconcile the
    /// *server*, so the damage isn't permanent — but the local UI has
    /// already flipped back, and on a slow link it can stay flipped for a
    /// noticeable stretch.
    ///
    /// "Server wins" is therefore scoped to what it actually means: the
    /// server wins over a *stale local cache*, not over an edit the user
    /// made after the read began. `PreferencesSyncCoordinator` samples this
    /// counter before issuing the pull and discards the response if it
    /// moved, letting the in-flight push settle the disagreement instead.
    ///
    /// A counter rather than a timestamp deliberately: it needs to answer
    /// "did anything change since this exact moment", which is an ordering
    /// question, and it must not be fooled by clock adjustments or by two
    /// writes landing inside the same millisecond.
    var localWriteGeneration: UInt64 { get }
}

/// Real, local persistence: JSON-encodes `OnboardingPreferences` into a
/// single `UserDefaults` key. No backend dependency, so this alone is
/// enough for preferences to survive an app relaunch (issue #38's
/// persistence requirement) even before any sync endpoint exists.
public final class UserDefaultsPreferencesStore: PreferencesStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let remoteSync: (any RemotePreferencesSyncing)?

    /// See `PreferencesStore.localWriteGeneration`. Guarded by `lock`
    /// because `save` is reachable from the main actor (a settings toggle)
    /// while `PreferencesSyncCoordinator` samples this from a background
    /// task — the exact concurrency this counter exists to reason about.
    private let lock = NSLock()
    private var writeGeneration: UInt64 = 0

    public var localWriteGeneration: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return writeGeneration
    }

    /// - Parameters:
    ///   - defaults: injectable for tests (a scratch `UserDefaults(suiteName:)`
    ///     rather than `.standard`, so test runs never leak state into each
    ///     other or into the real app's stored preferences).
    ///   - remoteSync: optional backend-sync seam (see type doc on
    ///     `RemotePreferencesSyncing`). `nil` today — no live backend
    ///     endpoint exists yet — but `save` already calls through it when
    ///     present, so wiring a real implementation later requires no
    ///     change at any call site.
    public init(
        defaults: UserDefaults = .standard,
        key: String = "com.kairos.preferences.v1",
        remoteSync: (any RemotePreferencesSyncing)? = nil
    ) {
        self.defaults = defaults
        self.key = key
        self.remoteSync = remoteSync
    }

    public func load() -> OnboardingPreferences {
        guard let data = defaults.data(forKey: key) else {
            return .defaults
        }
        guard let decoded = try? JSONDecoder().decode(OnboardingPreferences.self, from: data) else {
            // Corrupt/unreadable payload (e.g. a future app version wrote a
            // shape this build can't decode) — fall back to defaults rather
            // than crashing or surfacing an error the user can't act on.
            return .defaults
        }
        return decoded.validated()
    }

    @discardableResult
    public func save(_ preferences: OnboardingPreferences) -> OnboardingPreferences {
        let validated = preferences.validated()
        // Bumped before the write, not after, so a pull that samples the
        // counter concurrently with this call errs toward discarding its
        // own result rather than toward overwriting this one. Discarding a
        // pull costs one refresh cycle; overwriting a just-made user edit
        // is the bug described on `localWriteGeneration`.
        lock.lock()
        writeGeneration &+= 1
        lock.unlock()

        if let data = try? JSONEncoder().encode(validated) {
            defaults.set(data, forKey: key)
            // `UserDefaults` normally flushes to disk on its own schedule,
            // which is asynchronous relative to this call returning. A
            // preference change is a rare, deliberate user action (not a
            // hot path), and the whole point of this store is "survives
            // the app being killed a moment later" (issue #38) — so force
            // a synchronous flush here rather than trust the lazy default,
            // which has been observed to lose a just-written value when the
            // process is killed immediately after (e.g. `XCUIApplication.terminate()`
            // in tests, or the OS force-quitting a backgrounded app).
            defaults.synchronize()
        }
        // TODO(backend sync): once a `PUT /preferences`-shaped endpoint
        // exists, this fires a best-effort background push. Local save
        // above already succeeded and is the source of truth for this
        // device, so a remote failure here must never block or roll back
        // the local write.
        if let remoteSync {
            Task {
                try? await remoteSync.push(validated)
            }
        }
        return validated
    }
}

/// In-memory `PreferencesStore` for previews, unit tests, and Demo Mode —
/// no `UserDefaults`/disk dependency at all.
public final class InMemoryPreferencesStore: PreferencesStore, @unchecked Sendable {
    private let lock = NSLock()
    private var current: OnboardingPreferences
    private var writeGeneration: UInt64 = 0

    public init(initial: OnboardingPreferences = .defaults) {
        self.current = initial
    }

    /// Mirrors `UserDefaultsPreferencesStore`'s counter (see the protocol
    /// doc) so tests exercising the concurrent-edit guard can use this
    /// store and still be testing the real rule.
    public var localWriteGeneration: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return writeGeneration
    }

    public func load() -> OnboardingPreferences {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    @discardableResult
    public func save(_ preferences: OnboardingPreferences) -> OnboardingPreferences {
        let validated = preferences.validated()
        lock.lock()
        writeGeneration &+= 1
        current = validated
        lock.unlock()
        return validated
    }
}

/// The server-side consent trio (`preferences.calendar_enabled` /
/// `health_enabled` / `communication_enabled`), which #201 turned into real
/// read-time gates in the generation pipeline and #225 finally lets this
/// client write.
///
/// These are **coarser than** `ConsentCategory`, and the asymmetry is the
/// whole reason this is a separate type rather than a `[ConsentCategory: Bool]`:
/// the device tracks four categories (calendar, recovery, sleep, activity),
/// the server tracks three flags, and the three health categories collapse
/// into the single `healthEnabled`. See `ConsentSyncMapping` for the
/// translation and, more importantly, for why the collapse is lossless in
/// the direction that matters.
public struct RemoteConsentFlags: Equatable, Sendable {
    public let calendarEnabled: Bool
    public let healthEnabled: Bool
    /// No `ConsentCategory` corresponds to this one — communication load is
    /// derived server-side from `daily_bands`, not from anything this
    /// device collects. iOS therefore reads it (so a web-side revocation is
    /// not clobbered) and never writes it.
    public let communicationEnabled: Bool

    public init(calendarEnabled: Bool, healthEnabled: Bool, communicationEnabled: Bool) {
        self.calendarEnabled = calendarEnabled
        self.healthEnabled = healthEnabled
        self.communicationEnabled = communicationEnabled
    }
}

/// The consent subset iOS is entitled to *write* — deliberately a different,
/// smaller type than `RemoteConsentFlags` (which is what iOS reads).
///
/// The asymmetry is the point. `communication_enabled` has no device-side
/// consent surface: communication load is derived server-side from
/// `daily_bands`, and no iOS toggle governs it. If this type carried the
/// field, every consent write from this client would restate a value it
/// merely echoed back from an earlier read — and a stale echo would
/// silently undo a revocation the user performed on web. Omitting the field
/// from the request body entirely leaves the server's COALESCE to preserve
/// whatever the other surface stored, which is the only correct behavior
/// for a value this client has no opinion about.
///
/// Encoding "I have no opinion" in the type, rather than in a comment on a
/// nullable field, is what keeps a future call site from filling it in.
public struct RemoteConsentWrite: Equatable, Sendable {
    public let calendarEnabled: Bool
    public let healthEnabled: Bool

    public init(calendarEnabled: Bool, healthEnabled: Bool) {
        self.calendarEnabled = calendarEnabled
        self.healthEnabled = healthEnabled
    }
}

/// Everything a single `GET /v1/preferences` tells this client about the
/// user — the full server-authoritative snapshot, not just preferences
/// (issue #225).
///
/// It is one struct from one request on purpose. The alternative — separate
/// calls for preferences, onboarding, and consent — creates partial-success
/// states in which some of the user's state applied and some didn't, and
/// the most dangerous of those states is "the onboarding read is the one
/// that failed", which is the failure #225 exists to make impossible.
public struct RemoteUserState: Equatable, Sendable {
    public let preferences: OnboardingPreferences

    /// When the user finished onboarding on *any* surface, or `nil` if the
    /// server has no record.
    ///
    /// `nil` must never be read as "show onboarding" on its own — see
    /// `OnboardingCompletionStore`'s latch. It legitimately occurs for a
    /// user who onboarded on this device before #225 shipped, and for one
    /// who onboarded while offline and hasn't synced yet.
    public let onboardedAt: Date?

    public let consent: RemoteConsentFlags

    public init(preferences: OnboardingPreferences, onboardedAt: Date?, consent: RemoteConsentFlags) {
        self.preferences = preferences
        self.onboardedAt = onboardedAt
        self.consent = consent
    }
}

/// Seam for syncing user state to the backend — live since issue #225,
/// against `GET`/`PUT /v1/preferences` (docs/03 §8.1).
///
/// The store still owns local persistence and works with no backend at all
/// (`remoteSync` is `nil` in Demo Mode); this protocol is what makes the
/// same account coherent across iOS and web. `PreferencesSyncCoordinator`
/// is the only thing that calls `pull`, and it is where the conflict and
/// offline rules live — see that type for both.
public protocol RemotePreferencesSyncing: Sendable {
    /// Pushes preferences and, optionally, the two pieces of cross-surface
    /// state that don't live in `OnboardingPreferences`.
    ///
    /// Best-effort from the caller's perspective:
    /// `UserDefaultsPreferencesStore.save` already committed locally before
    /// this is invoked and does not roll back on failure.
    ///
    /// - Parameters:
    ///   - consent: `nil` omits the consent flags from the request body
    ///     entirely, leaving whatever the other surface stored untouched
    ///     (the server COALESCEs absent fields). An ordinary preferences
    ///     save passes `nil`; only a genuine consent change passes values,
    ///     so a routine sync can never restate — and thereby resurrect — a
    ///     consent decision made on web.
    ///   - onboardingCompleted: `true` only when this client is asserting
    ///     completion (the Done screen, or the latch backfilling a server
    ///     that has no record). The server is first-write-wins, so a
    ///     redundant `true` cannot move the stored instant.
    func push(
        _ preferences: OnboardingPreferences,
        consent: RemoteConsentWrite?,
        onboardingCompleted: Bool
    ) async throws

    /// Pulls the server's snapshot of this user. `nil` if the server has no
    /// stored row yet.
    ///
    /// **Throws on failure — it does not return `nil`.** The distinction is
    /// load-bearing: `nil` means "the server authoritatively has nothing",
    /// while a thrown error means "we don't know", and collapsing the two
    /// is precisely how a user on a plane would end up being shown
    /// onboarding a second time. Callers must handle the two differently;
    /// `PreferencesSyncCoordinator` does.
    func pull() async throws -> RemoteUserState?
}

public extension RemotePreferencesSyncing {
    /// Convenience for the overwhelmingly common case — a plain
    /// preferences save, asserting nothing about consent or onboarding.
    /// Keeps `UserDefaultsPreferencesStore.save` (and every existing call
    /// site) unaware of the two side-car fields.
    func push(_ preferences: OnboardingPreferences) async throws {
        try await push(preferences, consent: nil, onboardingCompleted: false)
    }
}
