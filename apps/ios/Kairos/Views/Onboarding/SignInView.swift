import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 2 (sign-in half). Sign in with Apple is
/// primary; email/password is the fallback.
struct SignInView: View {
    @ObservedObject var viewModel: OnboardingViewModel
    @State private var email = ""
    @State private var password = ""
    @State private var showEmailFallback = false

    var body: some View {
        VStack(spacing: 24) {
            Text("Sign in")
                .font(.title)
                .bold()

            // Sign in with Google is the web app's MVP provider
            // (docs/01_PRD.md F1), so it leads here.
            Button {
                Task { await viewModel.signInWithGoogle() }
            } label: {
                Label("Sign in with Google", systemImage: "g.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("signIn.withGoogle")

            Button {
                Task { await viewModel.signInWithApple() }
            } label: {
                Label("Sign in with Apple", systemImage: "apple.logo")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityIdentifier("signIn.withApple")

            Button("Use email instead") {
                showEmailFallback.toggle()
            }
            .accessibilityIdentifier("signIn.showEmailFallback")

            if showEmailFallback {
                VStack(spacing: 12) {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("signIn.emailField")

                    SecureField("Password", text: $password)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("signIn.passwordField")

                    Button("Continue") {
                        Task { await viewModel.signInWithEmail(email: email, password: password) }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("signIn.emailContinue")

                    Button("Create account") {
                        Task { await viewModel.signUpWithEmail(email: email, password: password) }
                    }
                    .accessibilityIdentifier("signIn.emailCreateAccount")
                }
                .padding(.top, 8)
            }

            if viewModel.isLoading {
                ProgressView()
                    .accessibilityIdentifier("signIn.loading")
            }

            if let message = viewModel.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("signIn.error")
            }

            Spacer()
        }
        .padding()
    }
}

#Preview {
    SignInView(viewModel: OnboardingViewModel(
        authService: FakeAuthService(),
        calendarService: FakeCalendarConnectService()
    ))
}
