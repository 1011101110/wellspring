import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 1.
struct WelcomeView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            Image(systemName: "calendar.badge.clock")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            Text("Wellspring finds the open moment in your workday and books a short meeting with God.")
                .font(.title2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .accessibilityIdentifier("welcome.headline")

            Spacer()

            Button("Get started") {
                viewModel.advanceFromWelcome()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("welcome.getStarted")
            .padding(.bottom, 40)
        }
        .padding()
    }
}

#Preview {
    WelcomeView(viewModel: OnboardingViewModel(
        authService: FakeAuthService(),
        calendarService: FakeCalendarConnectService()
    ))
}
