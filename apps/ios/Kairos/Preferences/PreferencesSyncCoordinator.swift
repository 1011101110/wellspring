import Foundation

/// The outcome of one `refresh()`, returned so callers (and tests) can
/// distinguish the cases that matter instead of inferring them.
///
/// `failed` and `noServerState` are separate members for the same reason
/// `pull()` throws rather than returning `nil`: "we could not reach the
/// server" and "the server authoritatively has nothing" are different
/// facts, and the whole offline story rests on never confusing them.
public enum PreferencesSyncOutcome: Equatable, Sendable {
    /// Server state was fetched and applied to the local caches.
    case applied
    /// Fetched successfully, but the server has no stored row for this user
    /// yet (a brand-new account). Local state stands, unchanged.
    case noServerState
    /// Fetched successfully, but a local edit landed while the request was
    /// in flight, so the response was discarded rather than allowed to
    /// overwrite it. See `PreferencesStore.localWriteGeneration`.
    case discardedStaleResponse
    /// The pull failed (offline, timeout, 5xx, expired token). Local caches
    /// are untouched and remain fully usable.
    case failed
}

/// Pulls server-authoritative user state on sign-in and on foreground, and
/// applies it to the local caches (issue #225, epic #186).
///
/// Before this existed, `RemotePreferencesSyncing.pull()` was implemented
/// and called by nothing: preferences flowed phone → server and never back,
/// so a change made on web could not reach iOS by any path. This type is
/// the missing direction, and it is deliberately the *only* caller of
/// `pull()` — the reconciliation rules below are subtle enough that having
/// two places implement them is how they come to disagree.
///
/// # Conflict rule: server wins on pull
///
/// The local stores are caches; the server is where the two surfaces meet.
/// A pulled value overwrites the local one without merging, without
/// comparing timestamps, and without asking. Last-writer-wins at the field
/// level, arbitrated by whoever wrote to the server most recently.
///
/// The alternative — merging by per-field timestamp — was rejected because
/// it needs a per-field `updated_at` the schema does not have, and because
/// its failure mode is worse: a merge that picks the wrong side produces a
/// state neither surface ever displayed, which is unexplainable to a user.
/// Server-wins can show a stale value briefly, which is at least a state
/// someone chose.
///
/// **Two carve-outs**, both narrow and both load-bearing:
///
///  1. **A local edit made after the pull started wins.** "Server wins"
///     means the server beats a stale cache, not that it beats an edit the
///     user made and watched take effect while the network was busy. The
///     `localWriteGeneration` sample around the request is what enforces
///     this; see that property for the exact interleaving it prevents.
///  2. **Onboarding completion is a latch, not a value.** It only ever goes
///     false → true, from either side. See `OnboardingCompletionStore`.
///
/// Consent has its own asymmetry (revocations cross over, grants do not) —
/// see `ConsentSyncMapping`.
///
/// # Offline behavior: stale-cache-with-refresh, decided explicitly
///
/// Every local store keeps working with its last known values when the
/// network is unavailable. A failed pull is a **no-op**, not a reset: no
/// store is written, nothing is cleared, and the app behaves exactly as it
/// did before the attempt. The next sign-in or foreground tries again.
///
/// This is the decision, not the accident. The alternative postures were
/// considered and rejected:
///
///  - *Block the UI until the pull succeeds* — turns a working offline app
///    into a broken one, and Kairos is specifically a thing people open in
///    quiet, poorly-connected moments.
///  - *Treat a failed pull as empty state* — the failure mode this whole
///    design is built to exclude. A user opening the app on a plane must
///    not be shown onboarding again because a request timed out. That is
///    why `pull()` throws instead of returning `nil`, why
///    `applyServerCompletion(at:)` has no `else` branch, and why this
///    method's `catch` writes to nothing at all. Three independent layers,
///    because getting it wrong once is enough to produce the bug.
///
/// The cost is a bounded staleness window: a change made on web is invisible
/// on a phone that cannot reach the server, until it can. That is the
/// correct trade — the phone is showing the last state the user actually
/// chose, which is never wrong in a way they can't understand.
public final class PreferencesSyncCoordinator: @unchecked Sendable {
    private let remoteSync: any RemotePreferencesSyncing
    private let preferencesStore: any PreferencesStore
    private let consentStore: any ConsentStore
    private let onboardingCompletionStore: any OnboardingCompletionStore

    /// Serializes refreshes so a foreground notification arriving during a
    /// sign-in refresh cannot interleave two applies over the same stores.
    private let refreshLock = NSLock()
    private var isRefreshing = false

    public init(
        remoteSync: any RemotePreferencesSyncing,
        preferencesStore: any PreferencesStore,
        consentStore: any ConsentStore,
        onboardingCompletionStore: any OnboardingCompletionStore
    ) {
        self.remoteSync = remoteSync
        self.preferencesStore = preferencesStore
        self.consentStore = consentStore
        self.onboardingCompletionStore = onboardingCompletionStore
    }

    /// Fetches server state and applies it. Safe to call on every sign-in
    /// and every foreground; never throws.
    ///
    /// Not throwing is deliberate. There is no caller who can do anything
    /// useful with a sync error — the app is fully functional without a
    /// successful refresh, by design (see the offline story above) — and an
    /// error escaping here would invite a call site to "handle" it by
    /// showing something, which is how a transient network blip turns into
    /// a user-visible failure in an app that had no problem.
    @discardableResult
    public func refresh() async -> PreferencesSyncOutcome {
        refreshLock.lock()
        if isRefreshing {
            refreshLock.unlock()
            // A refresh is already in flight over these same stores. The
            // in-flight one will apply whatever the server currently holds,
            // which is all this call could have achieved.
            return .discardedStaleResponse
        }
        isRefreshing = true
        refreshLock.unlock()

        defer {
            refreshLock.lock()
            isRefreshing = false
            refreshLock.unlock()
        }

        // Sampled BEFORE the request leaves, so any local save that happens
        // while it is in flight is detectable when it returns. Sampling
        // after would defeat the entire guard.
        let generationBeforePull = preferencesStore.localWriteGeneration

        let state: RemoteUserState?
        do {
            state = try await remoteSync.pull()
        } catch {
            // The offline path, and the single most important line in this
            // file: on failure we write to NOTHING. Not the preferences
            // cache, not consent, and above all not onboarding completion.
            // The user keeps the state they had.
            return .failed
        }

        guard let state else {
            // The server genuinely has no row yet — a brand-new account
            // whose first `PUT` hasn't happened. Distinct from an error, but
            // the local response is the same: keep what we have. Local
            // state will be pushed up by the next save.
            //
            // Backfill still runs: a device that onboarded offline, before
            // any row existed, is exactly the case that needs its
            // completion written up.
            await backfillOnboardingIfNeeded()
            return .noServerState
        }

        // The concurrent-edit carve-out. If the user saved a preference
        // while this request was in flight, that save is strictly newer
        // than the snapshot we are holding, and its own push is already on
        // its way to the server. Applying the snapshot now would revert a
        // change the user just watched take effect.
        //
        // Note this guards ALL three applies below, not only preferences:
        // the onboarding latch and consent revocations are both monotonic,
        // so re-applying them one refresh later is free, whereas splitting
        // the guard would mean this snapshot is partly trusted and partly
        // not — a state nobody can reason about later.
        guard preferencesStore.localWriteGeneration == generationBeforePull else {
            return .discardedStaleResponse
        }

        preferencesStore.save(Self.merging(state.preferences, into: preferencesStore.load()))
        ConsentSyncMapping.applyRevocations(state.consent, to: consentStore)
        onboardingCompletionStore.applyServerCompletion(at: state.onboardedAt)

        await backfillOnboardingIfNeeded()
        return .applied
    }

    /// Applies a pulled snapshot over the local one, **preserving the two
    /// fields `GET /v1/preferences` does not carry**.
    ///
    /// `tradition` and `translation` live in `OnboardingPreferences` but not
    /// in the `preferences` table — they are `users.tradition` and
    /// `users.translation_id`, and the preferences payload has never
    /// included them. `HTTPPreferencesClient.onboardingPreferences(from:)`
    /// therefore fills both with `OnboardingPreferences.defaults`, which was
    /// harmless for as long as `pull()` was called by nothing.
    ///
    /// The moment #225 started applying pulled state, it stopped being
    /// harmless: a plain `save(state.preferences)` would reset every user's
    /// tradition to `.general` and translation to `.bsb` on every
    /// foreground — silently changing which Bible they are read from, which
    /// is about as far from "a preference the server merely mirrors" as
    /// this app gets. "Server wins" cannot apply to a field the server did
    /// not send; absent is not the same as empty, exactly as it isn't for
    /// `onboardedAt`.
    ///
    /// TODO(#225 follow-up): the correct end state is for these two to
    /// round-trip like everything else, since they are just as
    /// cross-surface as the rest — a user who picks Anglican on web will
    /// still see General on iOS. That needs `tradition`/`translationId` on
    /// both the request and response schemas plus a `users` write path, so
    /// it is a contract change rather than part of wiring up the pull.
    /// Until then this guard is what keeps the pull from actively making
    /// the parity gap worse than the one it inherited.
    static func merging(
        _ remote: OnboardingPreferences,
        into local: OnboardingPreferences
    ) -> OnboardingPreferences {
        var merged = remote
        merged.tradition = local.tradition
        merged.translation = local.translation
        return merged
    }

    /// Writes this device's onboarding completion up when the server has no
    /// record of it — the reverse direction of the latch.
    ///
    /// This is what carries every pre-#225 user across: they have the local
    /// boolean and `users.onboarded_at IS NULL`, because migration
    /// 1721800000000 deliberately backfilled nothing (a blanket backfill
    /// would have asserted completion for users who abandoned onboarding
    /// mid-flow). Their first refresh after upgrading records the truth
    /// individually, and from then on any surface can see it.
    ///
    /// Best-effort: a failure here leaves the local latch intact and the
    /// next refresh retries. Unlike the route's own handling of this field,
    /// nothing is waiting on the result — the user is already past
    /// onboarding on this device either way.
    private func backfillOnboardingIfNeeded() async {
        guard onboardingCompletionStore.needsServerBackfill() else { return }
        try? await remoteSync.push(
            preferencesStore.load(),
            consent: nil,
            onboardingCompleted: true
        )
    }

    /// Pushes a consent change through to the server columns (issue #225).
    ///
    /// Called by the Data & Privacy screen after a toggle, in addition to
    /// the existing device-local write — never instead of it. The device
    /// store must stay authoritative for on-device derivation (a category
    /// toggled off must stop HealthKit being read at all, which no server
    /// flag can accomplish), so this is a write-*through*, not a move.
    ///
    /// Best-effort, like every other push: the local toggle has already
    /// taken effect and stopped collection, which is the half of consent
    /// that matters most and the half that must never wait on a network
    /// call. The server half converges on the next successful sync.
    public func pushConsent() async {
        try? await remoteSync.push(
            preferencesStore.load(),
            consent: ConsentSyncMapping.writePayload(from: consentStore),
            onboardingCompleted: false
        )
    }

    /// Records onboarding completion locally and on the server (issue #225).
    ///
    /// Local first, unconditionally, and the server push is best-effort —
    /// which is the correct order for exactly the reason the whole latch
    /// exists: a user who finishes onboarding in a tunnel is finished. The
    /// local mark carries them into the app immediately, and
    /// `needsServerBackfill` guarantees the server hears about it on the
    /// next successful refresh rather than the fact being lost.
    public func markOnboardingCompleted() async {
        onboardingCompletionStore.markCompleted()
        try? await remoteSync.push(
            preferencesStore.load(),
            consent: nil,
            onboardingCompleted: true
        )
    }
}
