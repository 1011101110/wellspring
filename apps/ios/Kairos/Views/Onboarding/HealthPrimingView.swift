import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 4: optional HealthKit priming with
/// granular, independent toggles per docs/04_DATA_PRIVACY_SECURITY.md §3.
/// Only categories toggled on here are ever requested from HealthKit.
///
/// **Demoted from a setup step to an enhancement** by issue #196 / K10. The
/// screen previously opened "Want devotionals that match how you actually
/// are?" — which, read honestly, tells a user who declines that their
/// devotionals will NOT match how they actually are. Under the calendar-first
/// direction that is simply false: the calendar already carries the shape of
/// the day (PRD §2, Foundation §32), and a calendar-only user is a complete
/// user, not a degraded one (PRD §5, persona "Maya"). It is also unshippable
/// on web, which cannot read HealthKit at all — copy that treats health as
/// the thing that makes Kairos work would make the web surface permanently
/// second-class (#195).
///
/// So the framing here is strictly additive — "sharper", never "complete" —
/// and declining is written as a normal choice stated in the user's own
/// voice, with no reassurance-that-implies-loss ("...is fine") and no
/// "without" framing that names the decline by what it lacks.
struct HealthPrimingView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Optional: make it sharper")
                .font(.title2)
                .bold()
                .accessibilityIdentifier("healthPriming.headline")

            Text("Kairos already knows the shape of your day from your calendar. If you like, it can also notice how rested you are — a heavy day after a short night can call for something gentler.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("healthPriming.explainer")

            Text("Your health data never leaves your phone. We turn it into three simple words — like \u{2018}rested\u{2019} or \u{2018}tired\u{2019} — and send only those.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("healthPriming.privacyExplainer")

            VStack(spacing: 12) {
                ForEach(HealthCategory.allCases, id: \.self) { category in
                    toggleRow(for: category)
                }
            }

            if viewModel.isLoading {
                ProgressView()
                    .accessibilityIdentifier("healthPriming.loading")
            }

            if let message = viewModel.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("healthPriming.error")
            }

            Spacer()

            // Which action gets the prominent slot follows what the user has
            // actually chosen, rather than always pointing at health (#196).
            //
            // Before, the prominent button read "Continue without health data"
            // whenever nothing was toggled on: the loudest control on screen
            // named the user's choice by what it lacked, and the quiet
            // alternative below it offered reassurance ("...is fine") that only
            // makes sense if something were in fact wrong. Between the two, the
            // screen read as a setup step being declined.
            //
            // Now: toggling something on makes "Turn these on" the primary;
            // toggling nothing makes moving on the primary, phrased as a
            // statement of sufficiency in the user's own voice. Skipping stays
            // available as a single tap in both states — it is never buried
            // behind a confirmation, and never the only quiet thing on screen.
            if viewModel.hasAnyHealthCategoryToggledOn {
                Button("Turn these on") {
                    Task { await viewModel.requestHealthAuthorization() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("healthPriming.continue")

                Button("Not now") {
                    viewModel.skipHealthPriming()
                }
                .accessibilityIdentifier("healthPriming.skip")
                .frame(maxWidth: .infinity)
            } else {
                Button("My calendar is all Kairos needs") {
                    viewModel.skipHealthPriming()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("healthPriming.skip")
                .accessibilityHint("Continues without sharing health data. Kairos personalizes from your calendar.")
            }
        }
        .padding()
    }

    @ViewBuilder
    private func toggleRow(for category: HealthCategory) -> some View {
        let priming = viewModel.healthPrimingCopy(for: category)
        let isOn = Binding<Bool>(
            get: { viewModel.healthCategoryToggles[category] ?? false },
            set: { _ in viewModel.toggleHealthCategory(category) }
        )
        VStack(alignment: .leading, spacing: 6) {
            Toggle(title(for: category), isOn: isOn)
                .accessibilityIdentifier("healthPriming.toggle.\(category.rawValue)")
                .accessibilityHint("Double-tap to \(isOn.wrappedValue ? "stop sharing" : "share") \(title(for: category).lowercased()) as a single word")

            Text("What we send: \(priming.whatWeSend)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("What never leaves your phone: \(priming.whatNeverLeaves)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func title(for category: HealthCategory) -> String {
        switch category {
        case .recovery: return "Recovery"
        case .sleepQuality: return "Sleep"
        case .activity: return "Activity"
        }
    }
}

#Preview {
    HealthPrimingView(viewModel: OnboardingViewModel(
        authService: FakeAuthService(),
        calendarService: FakeCalendarConnectService(),
        healthService: FakeHealthConnectService()
    ))
}
