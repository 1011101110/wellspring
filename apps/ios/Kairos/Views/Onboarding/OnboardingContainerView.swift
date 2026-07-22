import SwiftUI

/// Top-level coordinator for the full docs/05_UX_FLOWS.md §2 flow: screens
/// 1-3 (required path to value), 4-5 (optional/skippable enrichment), and
/// 6 (Done).
struct OnboardingContainerView: View {
    @StateObject private var viewModel: OnboardingViewModel
    var onComplete: () -> Void

    init(
        authService: any AuthService,
        calendarService: any CalendarConnectService,
        healthService: any HealthConnectService = FakeHealthConnectService(),
        preferencesStore: any PreferencesStore = InMemoryPreferencesStore(),
        consentStore: (any ConsentStore)? = nil,
        onComplete: @escaping () -> Void
    ) {
        _viewModel = StateObject(wrappedValue: OnboardingViewModel(
            authService: authService,
            calendarService: calendarService,
            healthService: healthService,
            preferencesStore: preferencesStore,
            consentStore: consentStore
        ))
        self.onComplete = onComplete
    }

    var body: some View {
        Group {
            switch viewModel.step {
            case .welcome:
                WelcomeView(viewModel: viewModel)
            case .signIn:
                SignInView(viewModel: viewModel)
            case .inviteEmail:
                InviteEmailView(viewModel: viewModel)
            case .calendarConnect:
                CalendarConnectView(viewModel: viewModel)
            case .healthPriming:
                HealthPrimingView(viewModel: viewModel)
            case .preferences:
                NavigationStack {
                    PreferencesCaptureView(viewModel: viewModel)
                }
            case .done:
                OnboardingDoneView(onFinish: onComplete)
            }
        }
        .animation(.default, value: viewModel.step)
    }
}

#Preview {
    OnboardingContainerView(
        authService: FakeAuthService(),
        calendarService: FakeCalendarConnectService(),
        healthService: FakeHealthConnectService(),
        onComplete: {}
    )
}
