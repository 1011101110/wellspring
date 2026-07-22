import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 3: three equally-weighted calendar-connect
/// paths, each with priming copy shown before the OS/OAuth prompt (P3).
///
/// **This is the hero step of onboarding** (issue #196 / K10). Under the
/// calendar-first direction (PRD §2, Foundation §32) the calendar is the
/// primary signal and is sufficient on its own, so this screen is where the
/// product is actually explained — not one permission request among several.
/// The headline and the `valueProposition` block below carry that job: a user
/// who connects here and skips everything downstream has a complete Kairos,
/// and the copy is written so they can tell.
struct CalendarConnectView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("This is how Wellspring works")
                .font(.title2)
                .bold()
                .accessibilityIdentifier("calendarConnect.headline")

            valueProposition

            connectOption(
                kind: .google,
                title: "Connect Google Calendar",
                systemImage: "calendar"
            )

            connectOption(
                kind: .appleEventKit,
                title: "I use Apple Calendar",
                systemImage: "apple.logo"
            )

            connectOption(
                kind: .emailOnly,
                title: "Just email me invites",
                systemImage: "envelope"
            )

            if viewModel.isLoading {
                ProgressView()
                    .accessibilityIdentifier("calendarConnect.loading")
            }

            if let message = viewModel.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("calendarConnect.error")
            }

            Spacer()

            Button("Skip for now") {
                viewModel.skipCalendarConnect()
            }
            .accessibilityIdentifier("calendarConnect.skip")
            .frame(maxWidth: .infinity)
        }
        .padding()
    }

    /// The product explanation, stated once, at the moment it becomes true.
    ///
    /// Deliberately placed on the calendar step rather than the welcome screen:
    /// this is the step where the user decides, and PRD §2's claim ("the
    /// calendar is the primary signal, and it is sufficient on its own") only
    /// means something if it is said where the trade-off is being made. The
    /// third line exists to pre-empt the question the *next* screen would
    /// otherwise raise — that connecting health is a second half of setup.
    ///
    /// Grouped into a single accessibility element so VoiceOver reads the
    /// proposition as one statement rather than three orphaned fragments,
    /// matching how the priming copy pairs are already read below.
    private var valueProposition: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Wellspring reads the shape of your day — how packed it is, where the real gaps are — and books one short devotional into an open slot, like any other meeting.")
            Text("It never reads meeting titles, attendees, or notes, and it never stores your calendar.")
            Text("Your calendar is all Wellspring needs. Everything after this step is optional.")
                .fontWeight(.medium)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("calendarConnect.valueProposition")
    }

    @ViewBuilder
    private func connectOption(kind: CalendarConnectionKind, title: String, systemImage: String) -> some View {
        let priming = viewModel.primingCopy(for: kind)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                Task { await viewModel.connectCalendar(kind) }
            } label: {
                Label(title, systemImage: systemImage)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("calendarConnect.\(kind.rawValue)")

            Text("What we send: \(priming.whatWeSend)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("What never leaves your phone: \(priming.whatNeverLeaves)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, 4)
    }
}

#Preview {
    CalendarConnectView(viewModel: OnboardingViewModel(
        authService: FakeAuthService(),
        calendarService: FakeCalendarConnectService()
    ))
}
