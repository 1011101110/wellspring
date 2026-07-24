import SwiftUI

/// docs/05_UX_FLOWS.md §3.1 "Preferences" (F7): "Everything from onboarding
/// screen 5, editable any time; changes apply to the *next* scheduled run."
/// Also carries account state (sign out) and the hidden demo-mode toggle
/// (§3.1 "Demo mode").
struct PreferencesView: View {
    @EnvironmentObject private var appEnvironment: AppEnvironment
    @ObservedObject var authService: AnyAuthService
    @StateObject private var viewModel: PreferencesViewModel
    @State private var versionTapCount = 0
    @State private var showDemoModeRow = false

    init(authService: AnyAuthService, preferencesStore: any PreferencesStore) {
        self.authService = authService
        _viewModel = StateObject(wrappedValue: PreferencesViewModel(store: preferencesStore))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Workday window") {
                    Stepper(
                        "Starts at \(formattedHour(viewModel.preferences.workdayStartHour))",
                        value: $viewModel.preferences.workdayStartHour,
                        in: 0...23
                    )
                    .accessibilityIdentifier("preferences.startHour")

                    Stepper(
                        "Ends at \(formattedHour(viewModel.preferences.workdayEndHour))",
                        value: $viewModel.preferences.workdayEndHour,
                        in: 0...23
                    )
                    .accessibilityIdentifier("preferences.endHour")
                }

                // K2 (#188) — same control and same rationale as
                // `PreferencesCaptureView`; see the comment there. Bound
                // straight through `$viewModel.preferences`, matching
                // Duration/Tradition/Voice below, so it picks up the
                // view model's existing save-and-sync path unchanged.
                //
                // docs/05 §3.1: "changes apply to the *next* scheduled
                // run" — which since #188 is literally true of this
                // control rather than aspirationally true. It is the
                // first version of this screen where changing when your
                // devotionals arrive changes when your devotionals
                // arrive.
                Section("Cadence") {
                    Picker("Cadence", selection: $viewModel.preferences.cadence) {
                        ForEach(Cadence.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .accessibilityIdentifier("preferences.cadence")
                }

                // K3 (#189) — the same control as the onboarding capture
                // screen, per docs/05 §3.1 ("Everything from onboarding
                // screen 5, editable any time"): the settings screen should
                // not be a second, differently-shaped way to express the
                // same preference.
                //
                // Bound through `$viewModel.preferences.days`, so each tap
                // trips the `preferences` `didSet` and takes the existing
                // write-through save path unchanged — same as Duration and
                // Tradition, no bespoke persistence for this control.
                Section("Days") {
                    WeekdayCircleRow(
                        days: $viewModel.preferences.days,
                        identifierPrefix: "preferences"
                    )
                }

                Section("Duration") {
                    Picker("Duration", selection: $viewModel.preferences.duration) {
                        ForEach(DurationPreference.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("preferences.duration")
                }

                Section("Tradition") {
                    Picker("Tradition", selection: $viewModel.preferences.tradition) {
                        ForEach(Tradition.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .accessibilityIdentifier("preferences.tradition")
                }

                Section("Translation") {
                    Picker("Translation", selection: $viewModel.preferences.translation) {
                        ForEach(TranslationChoice.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .accessibilityIdentifier("preferences.translation")
                }

                Section("Voice") {
                    Picker("Voice", selection: $viewModel.preferences.voice) {
                        ForEach(VoiceChoice.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .accessibilityIdentifier("preferences.voice")
                    Text("Tap a voice to hear a 3-second preview.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Stillness") {
                    Picker("Stillness", selection: $viewModel.preferences.stillness) {
                        ForEach(StillnessPreference.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .accessibilityIdentifier("preferences.stillness")
                    Text("After the verse — and again after the prayer — the voice hands off to quiet, then gently returns.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Evening examen") {
                    Toggle("Evening examen", isOn: $viewModel.preferences.examenEnabled)
                        .accessibilityIdentifier("preferences.examenEnabled")
                    Text("Adds a short reflection at the end of the day: what gave life today, what drained it, and a moment to bring it to God.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if viewModel.didJustSave {
                    Section {
                        Label("Saved locally — will sync", systemImage: "checkmark.circle")
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("preferences.savedConfirmation")
                    }
                }

                Section("Account") {
                    if let user = authService.currentUser {
                        LabeledContent("Signed in as", value: user.displayName ?? user.email ?? user.id)
                        if let inviteEmail = user.inviteEmail {
                            LabeledContent("Invite email", value: inviteEmail)
                        }
                    } else {
                        Text("Not signed in")
                            .foregroundStyle(.secondary)
                    }

                    Button("Sign out", role: .destructive) {
                        try? authService.signOut()
                    }
                    .accessibilityIdentifier("preferences.signOut")
                }

                Section {
                    NavigationLink {
                        DataPrivacyView(makeViewModel: appEnvironment.makeDataPrivacyViewModel())
                    } label: {
                        Label("Data & Privacy", systemImage: "hand.raised")
                    }
                    .accessibilityIdentifier("preferences.dataPrivacyLink")
                }

                Section {
                    Text("Wellspring")
                        .onTapGesture {
                            versionTapCount += 1
                            if versionTapCount >= 5 {
                                showDemoModeRow = true
                            }
                        }
                    // docs/05_UX_FLOWS.md §3.1 "Demo mode": hidden dev menu,
                    // revealed by 5 taps on the version number (also always
                    // visible under #if DEBUG for easier local testing).
                    if showDemoModeRow || isDebugBuild {
                        Toggle("Demo mode", isOn: .constant(appEnvironment.isDemoMode))
                            .disabled(true)
                            .accessibilityIdentifier("preferences.demoMode")
                    }
                } header: {
                    Text("About")
                }
            }
            // Wellspring Design System (T5 #352): the form keeps its native
            // controls (a settings screen is chrome), but sits on the warm
            // canvas; the global terracotta tint styles its controls.
            .scrollContentBackground(.hidden)
            .background(WSTheme.canvas)
            .navigationTitle("Preferences")
        }
    }

    private func formattedHour(_ hour: Int) -> String {
        let period = hour < 12 ? "AM" : "PM"
        let displayHour = hour % 12 == 0 ? 12 : hour % 12
        return "\(displayHour):00 \(period)"
    }

    private var isDebugBuild: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }
}

#Preview {
    PreferencesView(authService: AnyAuthService(FakeAuthService()), preferencesStore: InMemoryPreferencesStore())
        .environmentObject(AppEnvironment())
}
