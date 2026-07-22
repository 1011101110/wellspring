import SwiftUI

/// Switches between onboarding (docs/05_UX_FLOWS.md §2) and the signed-in
/// tab shell (§3).
///
/// Onboarding completion is tracked independently of sign-in state, via the
/// explicit, persisted `OnboardingCompletionStore` (issue #71 /
/// docs/14_IMPROVEMENT_REVIEW.md §1.9) — NOT inferred from "is a user
/// signed in at launch," which is the bug this fixes: once
/// `FirebaseAuthService` correctly restores a session (this same issue),
/// a user who was signed in but force-quit mid-onboarding (e.g. right after
/// the invite-email step, well before reaching Done) would relaunch with a
/// restored `currentUser` and be routed straight to the tab shell,
/// skipping the rest of onboarding entirely — a real, observable bug the
/// old sign-in-at-launch inference could not distinguish from "this user
/// genuinely finished onboarding in a previous session." Sign-in alone
/// still must NOT be sufficient on its own either way: `AuthService`
/// implementations publish `currentUser` as soon as sign-in succeeds, which
/// happens *before* the invite-email and calendar-connect steps run
/// (docs/05_UX_FLOWS.md §2 screens 2-3). Only
/// `OnboardingContainerView`'s own `onComplete` (fired from the Done
/// screen, screen 6) may mark onboarding complete.
/// ## Issue #225: onboarding completion now arrives from the server too
///
/// `hasCompletedOnboarding` is seeded from the local cache at `init` (so the
/// first frame is drawn without waiting on a network call — an app that
/// blocks its first screen on a request is an app that doesn't launch on a
/// plane), then refreshed from `PreferencesSyncCoordinator` on sign-in and
/// on foreground.
///
/// The refresh can only ever flip this **false → true**, because the
/// coordinator's latch can only ever flip the store that way. That is the
/// property that makes it safe to run this on every foreground: a user
/// already inside the tab shell can never be yanked back into onboarding by
/// a pull that failed, returned `nil`, or raced a local write. See
/// `OnboardingCompletionStore` for the three reasons the latch is not
/// "server wins".
struct RootView: View {
    @EnvironmentObject private var appEnvironment: AppEnvironment
    @ObservedObject private var authService: AnyAuthService
    @Environment(\.scenePhase) private var scenePhase
    @State private var hasCompletedOnboarding: Bool
    private let onboardingCompletionStore: any OnboardingCompletionStore
    private let syncCoordinator: PreferencesSyncCoordinator?

    init(appEnvironment: AppEnvironment) {
        self.authService = appEnvironment.authService
        self.onboardingCompletionStore = appEnvironment.onboardingCompletionStore
        self.syncCoordinator = appEnvironment.preferencesSyncCoordinator
        _hasCompletedOnboarding = State(initialValue: appEnvironment.onboardingCompletionStore.hasCompletedOnboarding())
    }

    var body: some View {
        Group {
            if authService.currentUser != nil, hasCompletedOnboarding {
                RootTabView()
            } else {
                OnboardingContainerView(
                    authService: appEnvironment.authService,
                    calendarService: appEnvironment.calendarService,
                    healthService: appEnvironment.healthService,
                    preferencesStore: appEnvironment.preferencesStore,
                    consentStore: appEnvironment.consentStore,
                    onComplete: {
                        // Local first, server second, and never the other
                        // way round: a user who finishes onboarding offline
                        // is finished. `markOnboardingCompleted` writes the
                        // local latch synchronously before awaiting the
                        // push, and `needsServerBackfill` guarantees the
                        // server hears about it on the next successful
                        // refresh if this push fails.
                        onboardingCompletionStore.markCompleted()
                        hasCompletedOnboarding = true
                        Task { await syncCoordinator?.markOnboardingCompleted() }
                    }
                )
            }
        }
        // Sign-in edge. `currentUser` publishes on session restore at launch
        // as well as on a fresh sign-in, so this covers both — and it is the
        // earliest moment a pull can succeed, since every call needs a token.
        .onChange(of: authService.currentUser?.id) { _, id in
            guard id != nil else { return }
            Task { await refreshFromServer() }
        }
        // Foreground edge. This is what makes "change it on web, pick up the
        // phone" work without a relaunch — the acceptance criterion in #225
        // says "after relaunch", and this delivers strictly better than that.
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active, authService.currentUser != nil else { return }
            Task { await refreshFromServer() }
        }
        .task {
            // Covers the launch case where a session was already restored
            // before this view appeared, so `onChange` never fires.
            guard authService.currentUser != nil else { return }
            await refreshFromServer()
        }
    }

    /// Re-reads the local flag after a refresh. Reads the *store*, not the
    /// refresh outcome: every outcome (`applied`, `failed`, `noServerState`,
    /// `discardedStaleResponse`) leaves the store holding the right answer,
    /// so there is deliberately no branching on the result here. Branching
    /// would mean writing an error path that decides what to show the user
    /// when a pull fails — and the correct decision is always "whatever we
    /// were already showing", which is what not branching produces.
    private func refreshFromServer() async {
        await syncCoordinator?.refresh()
        if onboardingCompletionStore.hasCompletedOnboarding() {
            hasCompletedOnboarding = true
        }
    }
}

#Preview {
    RootView(appEnvironment: AppEnvironment())
        .environmentObject(AppEnvironment())
}
