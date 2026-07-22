import Foundation
import SwiftUI

/// Drives the Data & Privacy screen (issue #39; docs/05_UX_FLOWS.md §3.1
/// "Data & Privacy" row; docs/04_DATA_PRIVACY_SECURITY.md §1 "privacy
/// philosophy" + §3 consent table). This is one of the most important
/// screens in the app given how central privacy-by-minimization is to the
/// product — every toggle here writes through to `ConsentStore`
/// immediately (no separate Save step, matching `PreferencesViewModel`'s
/// established pattern), so the on-screen state and the persisted
/// consent state can never drift.
@MainActor
public final class DataPrivacyViewModel: ObservableObject {
    /// Per-category on/off state, published so `Toggle` bindings redraw
    /// immediately. Kept as a separate `@Published` dictionary (rather than
    /// reading through to `consentStore` on every view render) so SwiftUI
    /// observes changes the normal way; every mutator below writes to
    /// `consentStore` in the same call, so this is never allowed to drift
    /// from the persisted value.
    @Published public private(set) var consentStates: [ConsentCategory: Bool]

    @Published public private(set) var calendarStatus: CalendarConnectStatus

    @Published public private(set) var ledgerEntry: DataLedgerEntry?

    /// Deletion flow state — two-step confirm per the UX doc. `nil` means
    /// no deletion in progress; the view drives its confirmation
    /// alert/sheet off this.
    @Published public private(set) var isDeletingAccount = false
    @Published public private(set) var deletionError: String?
    @Published public private(set) var didCompleteDeletion = false

    /// Calendar-disconnect flow state (issue #213), shaped exactly like the
    /// deletion trio above because it has the same requirement: a network
    /// call whose *failure must be visible*. `disconnectError` non-nil is
    /// the view's cue that the calendar is still connected.
    @Published public private(set) var isDisconnectingCalendar = false
    @Published public private(set) var disconnectError: String?
    @Published public private(set) var didCompleteDisconnect = false

    private let consentStore: any ConsentStore
    private let calendarService: any CalendarConnectService
    private let ledgerProvider: any DataLedgerProviding
    private let deletionClient: any AccountDeletionClient
    private let authService: any AuthService
    private let googleConnectClient: any GoogleConnecting
    /// Write-through to the server consent columns (issue #225). Optional
    /// because Demo Mode and previews have no backend — see
    /// `AppEnvironment.preferencesSyncCoordinator`. A `nil` here degrades to
    /// exactly the pre-#225 behavior: the device-local toggle still takes
    /// effect immediately and still gates collection.
    private let syncCoordinator: PreferencesSyncCoordinator?

    public init(
        consentStore: any ConsentStore,
        calendarService: any CalendarConnectService,
        ledgerProvider: any DataLedgerProviding,
        deletionClient: any AccountDeletionClient,
        authService: any AuthService,
        googleConnectClient: any GoogleConnecting,
        syncCoordinator: PreferencesSyncCoordinator? = nil
    ) {
        self.syncCoordinator = syncCoordinator
        self.consentStore = consentStore
        self.calendarService = calendarService
        self.ledgerProvider = ledgerProvider
        self.deletionClient = deletionClient
        self.authService = authService
        self.googleConnectClient = googleConnectClient
        self.consentStates = consentStore.allStates()
        self.calendarStatus = calendarService.status
        self.ledgerEntry = ledgerProvider.todayEntry()
    }

    /// Reloads ledger + calendar status — called on view `.task`/`onAppear`
    /// so returning to this screen (e.g. after a background band refresh)
    /// shows fresh state.
    ///
    /// The `didCompleteDisconnect` guard is load-bearing (issue #213).
    /// `calendarService.status` is in-memory device state that knows
    /// nothing about the server's `connections` row, so it still reports
    /// `.connected` after a confirmed server-side revoke. Without the
    /// guard, `DataPrivacyView`'s own `.task`/`onAppear` — which fire again
    /// on the very next appearance — would overwrite the confirmed
    /// `.notConnected` back to `.connected` and re-introduce a lying
    /// status display from the opposite direction.
    ///
    /// KNOWN GAP (#213): this only holds for the lifetime of *this* view
    /// model. `AppEnvironment.makeDataPrivacyViewModel()` builds a fresh
    /// one on every navigation into the screen, so re-entering shows the
    /// local service's `.connected` again even though the backend
    /// connection is revoked. Closing that properly means sourcing this
    /// row from the server (`GET /v1/connections` already returns
    /// `status` per provider and is likewise called by no client yet)
    /// rather than from device memory — tracked separately, as it is a
    /// status-plumbing change rather than part of making the revoke real.
    public func refresh() {
        ledgerEntry = ledgerProvider.todayEntry()
        if !didCompleteDisconnect {
            calendarStatus = calendarService.status
        }
    }

    public func isEnabled(_ category: ConsentCategory) -> Bool {
        // `false` (opt-in posture, issue #70) rather than `true` — matches
        // `ConsentStore`'s own never-toggled default. In practice every
        // category is always present in `consentStates` (seeded from
        // `consentStore.allStates()` at init, which enumerates
        // `ConsentCategory.allCases`), so this fallback is a defensive
        // default rather than a path exercised in normal operation.
        consentStates[category] ?? false
    }

    /// Toggles one category. Persists to `ConsentStore` *before* updating
    /// the published dictionary, so by the time SwiftUI redraws, the
    /// underlying store already reflects the new value — this is what
    /// makes "toggling a category off is reflected immediately (not just
    /// visually)" true, and is exactly what the unit tests below assert by
    /// reading a *second*, independent `ConsentStore` reference back.
    ///
    /// Does NOT retroactively rewrite `ledgerEntry` for a category that was
    /// already sent (or already withheld) as part of today's upload — the
    /// ledger snapshots the request actually sent at upload time (issue #70
    /// / docs/14_IMPROVEMENT_REVIEW.md §1.8's ledger-truthfulness fix,
    /// `BandUploadLedgerProvider`), which this toggle correctly has no
    /// effect on. The toggle's effect is on the *next* upload, not on
    /// history. `ledgerProvider.todayEntry()` is still re-read here (rather
    /// than left untouched) only so this view stays current if some other
    /// part of the app produced a fresh upload while this screen was
    /// already showing a stale/no entry — it is not how consent reaches the
    /// ledger.
    ///
    /// ISSUE #225: also writes through to the server's consent columns
    /// (`preferences.calendar_enabled` / `health_enabled`), which #201 made
    /// into real read-time gates in the generation pipeline. Until now
    /// nothing on this device ever wrote them, so there were two unrelated
    /// representations of one decision and the server's copy could only
    /// hold whatever the migration backfilled.
    ///
    /// The device write above happens first and is NOT conditional on the
    /// network one, deliberately. The local store is what stops HealthKit
    /// being read at all (`BandUploadService`, issue #70) — that is the
    /// half of consent that prevents collection rather than merely
    /// suppressing use, it is genuinely device-only, and it must never wait
    /// on a request that might not complete. The server half converges on
    /// this push or, failing that, on the next successful sync.
    public func setEnabled(_ enabled: Bool, for category: ConsentCategory) {
        consentStore.setEnabled(enabled, for: category)
        consentStates[category] = enabled
        ledgerEntry = ledgerProvider.todayEntry()
        Task { [syncCoordinator] in await syncCoordinator?.pushConsent() }
    }

    /// "Disconnect calendar" action (docs/05_UX_FLOWS.md §3.1), rewritten
    /// for issue #213.
    ///
    /// It used to be three local writes and no network call: it set the
    /// consent flag off, set `calendarStatus = .notConnected`, and the
    /// screen then read "Not connected" — while the backend's `connections`
    /// row stayed `active`, the KMS-encrypted refresh token was retained,
    /// and the daily run kept calling `freebusy.query` and inserting events
    /// indefinitely. That is not a control that fails silently; it is a
    /// control that *affirmatively reports success it never achieved*,
    /// against the one claim the product leans hardest on
    /// (docs/00_FOUNDATION.md §8's "independent, **revocable** opt-in";
    /// docs/04_DATA_PRIVACY_SECURITY.md §2/§3).
    ///
    /// So the server-side revoke now happens *first*, and local state is
    /// touched only after it succeeds. Ordering is the whole point: any
    /// local write that lands before the revoke is confirmed is a state the
    /// UI would render as "disconnected" while the token is still live.
    ///
    /// `DELETE /v1/connect/google` is called unconditionally, without first
    /// checking `calendarStatus`. `calendarStatus` reflects only this
    /// device's in-memory `CalendarConnectService`, which has no knowledge
    /// of the server's `connections` row — gating the revoke on it would
    /// let a stale or EventKit-flavored local status suppress a revoke that
    /// the backend genuinely still needs. The route is idempotent
    /// (`revokeGoogleConnection` returns early when there is no active
    /// `google_calendar` connection), so the redundant case costs one
    /// no-op request and the dangerous case is eliminated.
    ///
    /// EventKit is unchanged by this: it exposes no programmatic revoke for
    /// an already-granted permission, so the footer still points at
    /// Settings for the OS-level grant, and the Calendar consent toggle in
    /// the section above remains a purely local control that works offline.
    public func disconnectCalendar() async {
        isDisconnectingCalendar = true
        disconnectError = nil
        defer { isDisconnectingCalendar = false }

        do {
            try await googleConnectClient.disconnect()
        } catch {
            // Deliberately leave `consentStates`, `consentStore` and
            // `calendarStatus` exactly as they were. Showing "Not
            // connected" here would be the original #213 bug wearing a
            // different mask — the user would walk away believing they had
            // revoked access that is, in fact, still live.
            disconnectError = (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Please try again."
            return
        }

        consentStore.setEnabled(false, for: .calendar)
        consentStates[.calendar] = false
        calendarStatus = .notConnected
        didCompleteDisconnect = true
        // Mirror the revocation into `preferences.calendar_enabled` too
        // (issue #225). The `connections` row is already revoked at this
        // point, which stops the OAuth-backed calendar reads; this closes
        // the second, independent gate #201 added, so the state the *other*
        // surface reads agrees with what just happened here.
        await syncCoordinator?.pushConsent()
    }

    /// Deletion flow, step 2 of the two-step confirm (the view owns step 1,
    /// the "are you sure" alert). Calls the backend stub, then locally
    /// signs out on success — matching
    /// docs/04_DATA_PRIVACY_SECURITY.md §2's "hard-deletes all rows...
    /// within 24h and revokes Google tokens": the account is gone
    /// server-side, so the client must not continue presenting a
    /// signed-in session.
    public func confirmDeleteAccount() async {
        isDeletingAccount = true
        deletionError = nil
        defer { isDeletingAccount = false }

        do {
            try await deletionClient.deleteAccount()
            try? authService.signOut()
            didCompleteDeletion = true
        } catch {
            deletionError = (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Please try again."
        }
    }
}
