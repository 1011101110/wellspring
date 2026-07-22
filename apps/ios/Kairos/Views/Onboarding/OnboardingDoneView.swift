import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 6.
struct OnboardingDoneView: View {
    var onFinish: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            Text("You're set.")
                .font(.title)
                .bold()

            Text("Your first devotional will appear on your calendar tomorrow morning.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 32)

            Spacer()

            Button("Preview one now") {
                // Runs the demo devotional fixture path (F9) — hookup is
                // out of scope for this scaffold; placeholder action.
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("done.previewNow")

            Button("Continue") {
                onFinish()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("done.continue")
            .padding(.bottom, 40)
        }
        .padding()
    }
}

#Preview {
    OnboardingDoneView(onFinish: {})
}
