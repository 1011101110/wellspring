import SwiftUI

/// docs/05_UX_FLOWS.md §2 screen 5: workday window, days, cadence,
/// duration, tradition, translation, voice — all preloaded with defaults.
/// "Looks good" advances without requiring any edits.
struct PreferencesCaptureView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        Form {
            Section("Workday window") {
                Stepper(
                    "Starts at \(formattedHour(viewModel.preferences.workdayStartHour))",
                    value: $viewModel.preferences.workdayStartHour,
                    in: 0...23
                )
                .accessibilityIdentifier("preferencesCapture.startHour")

                Stepper(
                    "Ends at \(formattedHour(viewModel.preferences.workdayEndHour))",
                    value: $viewModel.preferences.workdayEndHour,
                    in: 0...23
                )
                .accessibilityIdentifier("preferencesCapture.endHour")
            }

            // K2 (#188). Sits above the day rows because it is the coarse
            // control most users will only ever touch: Daily and Weekdays
            // write the day set outright, and the rows below are the
            // Custom surface. `cadence` is a computed property over `days`
            // (OnboardingPreferences.cadence), so this picker and those
            // rows are two views of one value — toggling a day off flips
            // this to Custom with no extra wiring, and no state exists in
            // which the two disagree.
            //
            // Not a `.segmented` style, unlike Duration: "Custom" is a
            // *readout*, not something you pick, and a segmented control
            // invites tapping it. A menu picker shows the derived value
            // while offering only the two presets that mean something.
            Section("Cadence") {
                Picker("Cadence", selection: $viewModel.preferences.cadence) {
                    ForEach(Cadence.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
                .accessibilityIdentifier("preferencesCapture.cadence")
            }

            // K3 (#189). Seven stacked `Toggle` rows became one circle row:
            // this screen has eight sections to fit, and the days were
            // taking more vertical space than any two of the others
            // combined. Defaults to Mon–Fri via
            // `OnboardingPreferences.defaults`, matching the `{1,2,3,4,5}`
            // schema default, so "Looks good" stays a valid zero-edits
            // action.
            Section("Days") {
                WeekdayCircleRow(
                    days: $viewModel.preferences.days,
                    identifierPrefix: "preferencesCapture"
                )
            }

            Section("Duration") {
                Picker("Duration", selection: $viewModel.preferences.duration) {
                    ForEach(DurationPreference.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("preferencesCapture.duration")
            }

            Section("Tradition") {
                Picker("Tradition", selection: $viewModel.preferences.tradition) {
                    ForEach(Tradition.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
                .accessibilityIdentifier("preferencesCapture.tradition")
            }

            Section("Translation") {
                Picker("Translation", selection: $viewModel.preferences.translation) {
                    ForEach(TranslationChoice.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
                .accessibilityIdentifier("preferencesCapture.translation")
            }

            Section("Voice") {
                Picker("Voice", selection: $viewModel.preferences.voice) {
                    ForEach(VoiceChoice.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
                .accessibilityIdentifier("preferencesCapture.voice")
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
                .accessibilityIdentifier("preferencesCapture.stillness")
                Text("After the verse — and again after the prayer — the voice hands off to quiet, then gently returns.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button("Looks good") {
                    viewModel.confirmPreferences()
                }
                .accessibilityIdentifier("preferencesCapture.confirm")

                Button("Skip for now") {
                    viewModel.skipPreferences()
                }
                .accessibilityIdentifier("preferencesCapture.skip")
            }
        }
        .navigationTitle("Preferences")
    }

    private func formattedHour(_ hour: Int) -> String {
        let period = hour < 12 ? "AM" : "PM"
        let displayHour = hour % 12 == 0 ? 12 : hour % 12
        return "\(displayHour):00 \(period)"
    }
}

#Preview {
    NavigationStack {
        PreferencesCaptureView(viewModel: OnboardingViewModel(
            authService: FakeAuthService(),
            calendarService: FakeCalendarConnectService(),
            healthService: FakeHealthConnectService()
        ))
    }
}
