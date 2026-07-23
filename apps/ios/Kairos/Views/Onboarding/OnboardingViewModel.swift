import Foundation
import SwiftUI

/// The full docs/05_UX_FLOWS.md §2 screen sequence: 1-3 are the required
/// path to value ("a devotional is on your calendar tomorrow"), 4-5 are
/// optional/skippable enrichment, 6 is Done.
///
/// `calendarConnect` is the hero of this sequence (issue #196 / K10): it is
/// the last required step and the one that makes the product true, because
/// the calendar is the primary signal and is sufficient alone (PRD §2,
/// Foundation §32).
///
/// `healthPriming` is deliberately retained but demoted to an enhancement. It
/// is NOT removed — on-device health bands add real value for iPhone users
/// who want them — but it sits after the product already works, and the flow
/// is identical to the planned web sequence (#195) apart from this one step.
/// Web cannot read HealthKit at all, so keeping the surrounding order aligned
/// is what stops the two surfaces from drifting into different products.
public enum OnboardingStep: Int, CaseIterable, Equatable {
    case welcome
    case signIn
    case inviteEmail
    case calendarConnect
    case healthPriming
    case preferences
    case done
}

/// Drives the full docs/05_UX_FLOWS.md §2 flow: welcome, sign in, the
/// invite-email capture step, calendar connect, health priming with
/// granular per-category toggles, preferences capture, and Done. Generic
/// over any `AuthService`/`CalendarConnectService`/`HealthConnectService`
/// conformance so it can be driven by fakes in tests/previews and the real
/// services in the app.
@MainActor
public final class OnboardingViewModel: ObservableObject {
    @Published public private(set) var step: OnboardingStep = .welcome
    @Published public private(set) var user: KairosUser?
    @Published public var inviteEmailDraft: String = ""
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var calendarStatus: CalendarConnectStatus = .notConnected

    /// Screen 4 (docs/05_UX_FLOWS.md §2): each category is an independent
    /// toggle, off by default — only toggled-on categories are ever
    /// requested from HealthKit (docs/04_DATA_PRIVACY_SECURITY.md §3).
    @Published public var healthCategoryToggles: [HealthCategory: Bool] = Dictionary(
        uniqueKeysWithValues: HealthCategory.allCases.map { ($0, false) }
    )
    @Published public private(set) var healthAuthResult: [HealthCategory: HealthAuthState] = [:]

    /// Screen 5: preloaded with defaults (or whatever was previously saved,
    /// e.g. a user who backs out of onboarding and restarts it — see
    /// `preferencesStore`); "Looks good" advances without requiring any
    /// edits.
    @Published public var preferences: OnboardingPreferences

    private let authService: any AuthService
    private let calendarService: any CalendarConnectService
    private let healthService: any HealthConnectService
    private let preferencesStore: any PreferencesStore
    /// Seeded from this flow's own health-priming toggles + calendar-connect
    /// result on completion (issue #70 / docs/14_IMPROVEMENT_REVIEW.md
    /// §1.8) — previously `ConsentStore` was never written to from
    /// onboarding at all, so a user who deliberately left a category off
    /// during health priming would still show as consented (every category
    /// defaulted to `true`). `nil` is a valid, supported value: previews
    /// and any caller that doesn't need consent seeding (e.g. a future flow
    /// that isn't full onboarding) simply skip this step.
    private let consentStore: (any ConsentStore)?

    public init(
        authService: any AuthService,
        calendarService: any CalendarConnectService,
        healthService: any HealthConnectService = FakeHealthConnectService(),
        preferencesStore: any PreferencesStore = InMemoryPreferencesStore(),
        consentStore: (any ConsentStore)? = nil
    ) {
        self.authService = authService
        self.calendarService = calendarService
        self.healthService = healthService
        self.preferencesStore = preferencesStore
        self.consentStore = consentStore
        self.preferences = preferencesStore.load()
        self.user = authService.currentUser
        self.calendarStatus = calendarService.status
    }

    public func advanceFromWelcome() {
        step = .signIn
    }

    public func signInWithApple() async {
        await performSignIn { try await self.authService.signInWithApple() }
    }

    /// Sign in with Google — the web app's MVP provider (docs/01_PRD.md F1).
    /// Shares `performSignIn`'s exact loading/success/error handling with the
    /// Apple path; only the invoked `AuthService` method differs.
    public func signInWithGoogle() async {
        await performSignIn { try await self.authService.signInWithGoogle() }
    }

    public func signInWithEmail(email: String, password: String) async {
        await performSignIn { try await self.authService.signInWithEmail(email: email, password: password) }
    }

    /// Sign-up path for a brand-new email/password account (issue #71 /
    /// docs/14_IMPROVEMENT_REVIEW.md §1.9: "no email createUser path
    /// exists (sign-up impossible)"). Shares `performSignIn`'s exact
    /// success/error handling as `signInWithEmail` — the only difference is
    /// which `AuthService` method is invoked.
    public func signUpWithEmail(email: String, password: String) async {
        await performSignIn { try await self.authService.signUpWithEmail(email: email, password: password) }
    }

    private func performSignIn(_ action: @escaping () async throws -> KairosUser) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let signedInUser = try await action()
            user = signedInUser
            inviteEmailDraft = signedInUser.isPrivateRelayEmail ? "" : (signedInUser.email ?? "")
            step = .inviteEmail
        } catch let error as AuthError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// True when the invite-email step must show the Apple-relay explainer
    /// copy from docs/05_UX_FLOWS.md §2 screen 2.
    public var needsRelayExplainer: Bool {
        user?.isPrivateRelayEmail ?? false
    }

    public func confirmInviteEmail() async {
        guard !inviteEmailDraft.isEmpty else {
            errorMessage = "Enter an email address for calendar invites."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let updated = try await authService.setInviteEmail(inviteEmailDraft)
            user = updated
            step = .calendarConnect
        } catch let error as AuthError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func connectCalendar(_ kind: CalendarConnectionKind) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            calendarStatus = try await calendarService.connect(kind)
            step = .healthPriming
        } catch let error as CalendarConnectError {
            errorMessage = error.errorDescription
            calendarStatus = calendarService.status
            // docs/05_UX_FLOWS.md §3.1 "Denied permission" / P4: a denied
            // or unavailable connect path (e.g. EventKit access refused)
            // must not strand the user on this screen — it degrades to
            // email-invites-only mode and the flow continues.
            if error == .permissionDenied {
                calendarStatus = .connected(.emailOnly)
                step = .healthPriming
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// docs/05_UX_FLOWS.md §1 P4 — every step past sign-in is skippable.
    public func skipCalendarConnect() {
        step = .healthPriming
    }

    /// Priming copy shown before each calendar-connect option
    /// (docs/05_UX_FLOWS.md §1 P3), sourced from the injected
    /// `CalendarConnectService` so there is exactly one copy of this copy.
    public func primingCopy(for kind: CalendarConnectionKind) -> (whatWeSend: String, whatNeverLeaves: String) {
        calendarService.primingCopy(for: kind)
    }

    // MARK: - Screen 4: health priming + granular toggles

    /// Priming copy shown before HealthKit is ever touched for a given
    /// category (docs/05_UX_FLOWS.md §1 P3 / §2 screen 4).
    public func healthPrimingCopy(for category: HealthCategory) -> (whatWeSend: String, whatNeverLeaves: String) {
        healthService.primingCopy(for: category)
    }

    public func toggleHealthCategory(_ category: HealthCategory) {
        healthCategoryToggles[category, default: false].toggle()
    }

    public var hasAnyHealthCategoryToggledOn: Bool {
        healthCategoryToggles.values.contains(true)
    }

    /// Requests HealthKit authorization for exactly the toggled-on
    /// categories, then advances regardless of outcome — a denial degrades
    /// personalization (band omitted) but never blocks the flow (P4).
    public func requestHealthAuthorization() async {
        let requested = Set(healthCategoryToggles.filter { $0.value }.map(\.key))
        guard !requested.isEmpty else {
            step = .preferences
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            healthAuthResult = try await healthService.requestAuthorization(for: requested)
        } catch {
            // A hard failure (e.g. HealthKit unavailable on this device)
            // still must not block onboarding — proceed with no bands.
            healthAuthResult = Dictionary(uniqueKeysWithValues: requested.map { ($0, .denied) })
        }
        step = .preferences
    }

    /// docs/05_UX_FLOWS.md §1 P4 — skipping health is a first-class path, not
    /// a detour: one tap, no confirmation, no consequence beyond narrower
    /// personalization.
    ///
    /// Behaviorally identical to `requestHealthAuthorization()` with nothing
    /// toggled on, and that equivalence is the point (issue #196 / K10): there
    /// is no "declined" state to recover from, because declining is not a
    /// failure. A user who arrives here and taps straight through is a
    /// complete user whose devotionals personalize from calendar busyness —
    /// the server records their health bands as unobserved rather than
    /// substituting neutral defaults and speaking them as observations (see
    /// `SignalProvenance` in the API's instructionsBuilder).
    public func skipHealthPriming() {
        step = .preferences
    }

    // MARK: - Screen 5: preferences

    /// "Looks good" advances — defaults are valid as-is. Persists whatever
    /// is currently on screen (edited or not) so it survives past this
    /// onboarding session.
    public func confirmPreferences() {
        preferences = preferencesStore.save(preferences)
        seedConsentFromOnboardingChoices()
        step = .done
    }

    /// Unlike `confirmPreferences`, skipping deliberately does NOT write to
    /// the store: `preferences` here is whatever `preferencesStore.load()`
    /// already returned at `init` (defaults on a true first run, or
    /// whatever was previously saved on a later pass through onboarding —
    /// e.g. a user who signs out and back in, or this same screen
    /// appearing again for any reason). "Skip" means "leave my existing
    /// preferences alone," not "explicitly overwrite them with whatever
    /// happens to be in memory right now" — the latter would silently
    /// clobber a real prior save with a stale/default in-memory copy if
    /// this view model instance's own load ever raced the previous
    /// process's write (docs/05_UX_FLOWS.md §1 P4 "skipping degrades
    /// gracefully... never blocks" describes not being forced to edit
    /// fields, not a mandate to persist on every visit to this screen).
    /// Consent, unlike preferences, is NOT skipped here — this is the only
    /// place in the flow that writes health-priming's real toggle choices
    /// to `ConsentStore`, and "skip preferences" must not also silently
    /// skip seeding consent for a user who otherwise completed onboarding
    /// normally. Both paths to `.done` seed consent identically.
    public func skipPreferences() {
        seedConsentFromOnboardingChoices()
        step = .done
    }

    /// Writes this onboarding session's actual health-priming toggle
    /// choices + calendar-connect result into `ConsentStore` (issue #70 /
    /// docs/14_IMPROVEMENT_REVIEW.md §1.8: "onboarding opt-outs are never
    /// written to `ConsentStore`"). Consent reflects what the user *asked
    /// for* here — `healthCategoryToggles`, not `healthAuthResult` — since
    /// a category the user wanted but the OS denied is still a category the
    /// user consented to sharing; the separate "no HealthKit evidence" path
    /// (`BandDeriver.deriveDerivedBands`/`DerivedBands`) independently
    /// handles omitting a band that was consented-to but never actually
    /// measured, so consent and OS-grant-success are correctly kept as two
    /// distinct concerns here, exactly as `ConsentStore`'s own doc comment
    /// describes ("independent of the underlying OS permission grant").
    /// No-op when `consentStore` is `nil` (not every caller needs this).
    private func seedConsentFromOnboardingChoices() {
        guard let consentStore else { return }
        consentStore.setEnabled(healthCategoryToggles[.recovery] ?? false, for: .recovery)
        consentStore.setEnabled(healthCategoryToggles[.sleepQuality] ?? false, for: .sleep)
        consentStore.setEnabled(healthCategoryToggles[.activity] ?? false, for: .activity)
        switch calendarStatus {
        case .connected:
            consentStore.setEnabled(true, for: .calendar)
        case .notConnected, .denied:
            consentStore.setEnabled(false, for: .calendar)
        }
    }
}
