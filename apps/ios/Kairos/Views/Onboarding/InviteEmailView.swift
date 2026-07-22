import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 2 (invite-email half): "Where should
/// calendar invites go?" Apple relay emails trigger explicit explainer
/// copy since a `@privaterelay.appleid.com` address is useless as a real
/// calendar-invite destination.
struct InviteEmailView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Where should calendar invites go?")
                .font(.title2)
                .bold()
                .accessibilityIdentifier("inviteEmail.headline")

            if viewModel.needsRelayExplainer {
                Text("Apple gave us a private relay address. Calendar invites work best at the email your calendar uses.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("inviteEmail.relayExplainer")
            }

            TextField("you@example.com", text: $viewModel.inviteEmailDraft)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("inviteEmail.field")

            Text("We'll send a quick verification email before invites start.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if viewModel.isLoading {
                ProgressView()
                    .accessibilityIdentifier("inviteEmail.loading")
            }

            if let message = viewModel.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("inviteEmail.error")
            }

            Spacer()

            Button("Confirm") {
                Task { await viewModel.confirmInviteEmail() }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("inviteEmail.confirm")
        }
        .padding()
    }
}

#Preview("Normal email") {
    let auth = FakeAuthService()
    let vm = OnboardingViewModel(authService: auth, calendarService: FakeCalendarConnectService())
    return InviteEmailView(viewModel: vm)
}

#Preview("Apple relay email") {
    let auth = FakeAuthService(simulatesPrivateRelayEmail: true)
    let vm = OnboardingViewModel(authService: auth, calendarService: FakeCalendarConnectService())
    return InviteEmailView(viewModel: vm)
}
