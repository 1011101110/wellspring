import SwiftUI

/// docs/05_UX_FLOWS.md §3.1 "Data & Privacy" row — one of the most
/// important screens in the app given how central privacy-by-minimization
/// is to Kairos (docs/04_DATA_PRIVACY_SECURITY.md §1). Shows:
///   1. Per-category granular toggles (calendar / recovery / sleep /
///      activity), each independently revocable, matching
///      docs/04 §3's consent table exactly.
///   2. A plain-language data ledger — what was sent for today's
///      devotional, as gentle phrases (never raw band values).
///   3. "Disconnect calendar."
///   4. "Delete account & all data" — two-step confirm, immediate.
struct DataPrivacyView: View {
    // `@StateObject` (not `@ObservedObject`) is load-bearing here: this
    // view is reached via a `NavigationLink { DataPrivacyView(...) }`
    // trailing-closure destination in `PreferencesView`, and SwiftUI can
    // re-evaluate that closure on every one of the parent's body passes
    // (e.g. `PreferencesViewModel.didJustSave` flipping). If the view model
    // were constructed with `@ObservedObject` from a value passed in at
    // init time, each re-evaluation would call the factory again and swap
    // in a brand-new `DataPrivacyViewModel` — silently discarding whatever
    // the user had just toggled. `@StateObject(wrappedValue:)` guarantees
    // the autoclosure factory only actually runs once, on this view's
    // first appearance, no matter how many times `body` (or the
    // NavigationLink destination closure that created this view) reruns.
    @StateObject private var viewModel: DataPrivacyViewModel
    @State private var showDeleteConfirmation1 = false
    @State private var showDeleteConfirmation2 = false
    @State private var isPresentingDeletionResult = false

    init(makeViewModel: @autoclosure @escaping () -> DataPrivacyViewModel) {
        _viewModel = StateObject(wrappedValue: makeViewModel())
    }

    var body: some View {
        // No nested `NavigationStack` here — this view is always reached as
        // a pushed destination of `PreferencesView`'s own `NavigationStack`
        // (via `NavigationLink`), and wrapping a second, independent
        // `NavigationStack` around a pushed destination is a SwiftUI
        // anti-pattern: it creates a second navigation context nested
        // inside the first, which was observed (via a failing XCUITest
        // that tapped a `Toggle` and never saw the resulting state change
        // reflected) to interfere with normal state propagation on this
        // screen. Inheriting the parent's navigation context by using
        // `Form` directly — exactly like `PreferencesView` itself does at
        // the top of the stack — avoids that.
        Form {
            consentSection
            ledgerSection
            calendarSection
            meetingDeliverySection
            inviteKairosSection
            deleteAccountSection
        }
        .navigationTitle("Data & Privacy")
        .task { viewModel.refresh() }
        .onAppear { viewModel.refresh() }
        .alert("Delete account & all data?", isPresented: $showDeleteConfirmation1) {
            Button("Cancel", role: .cancel) {}
            Button("Continue", role: .destructive) {
                showDeleteConfirmation2 = true
            }
        } message: {
            Text("This permanently deletes your account, preferences, devotional history, and any connected calendar tokens. This cannot be undone.")
        }
        .alert("Are you absolutely sure?", isPresented: $showDeleteConfirmation2) {
            Button("Cancel", role: .cancel) {}
            Button("Delete everything", role: .destructive) {
                Task {
                    await viewModel.confirmDeleteAccount()
                    isPresentingDeletionResult = true
                }
            }
        } message: {
            Text("There is no second confirmation after this. Your data is removed immediately.")
        }
        .alert(
            viewModel.didCompleteDeletion ? "Account deleted" : "Couldn't delete account",
            isPresented: $isPresentingDeletionResult
        ) {
            Button("OK") {}
        } message: {
            if viewModel.didCompleteDeletion {
                Text("Your account and all data have been deleted.")
            } else {
                Text(viewModel.deletionError ?? "Something went wrong. Please try again.")
            }
        }
    }

    // MARK: - Granular toggles

    private var consentSection: some View {
        Section {
            ForEach(ConsentCategory.allCases) { category in
                consentRow(category)
            }
        } header: {
            Text("What Kairos can use")
        } footer: {
            Text("Each of these is independent — turning one off never turns off the others, and the app keeps working with reduced personalization.")
        }
    }

    private func consentRow(_ category: ConsentCategory) -> some View {
        let binding = Binding<Bool>(
            get: { viewModel.isEnabled(category) },
            set: { viewModel.setEnabled($0, for: category) }
        )
        return VStack(alignment: .leading, spacing: 4) {
            Toggle(category.displayName, isOn: binding)
                .accessibilityIdentifier("dataPrivacy.toggle.\(category.rawValue)")

            Text("We send: \(category.whatWeSend)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Never leaves your phone: \(category.whatNeverLeaves)")
                .font(.caption)
                .foregroundStyle(.secondary)

            if !binding.wrappedValue {
                Text(category.deniedBehaviorDescription)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("dataPrivacy.deniedNote.\(category.rawValue)")
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Data ledger

    private var ledgerSection: some View {
        Section {
            if let entry = viewModel.ledgerEntry {
                ForEach(entry.phraseLines, id: \.label) { line in
                    LabeledContent(line.label, value: line.phrase)
                }
                Text("Sent at \(formattedTime(entry.sentAt))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("dataPrivacy.ledger.timestamp")
            } else {
                Text("Nothing sent yet today.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("dataPrivacy.ledger.empty")
            }
        } header: {
            Text("What we sent today")
        } footer: {
            Text("This is a plain-language record of today's devotional signals — never the raw numbers themselves.")
        }
    }

    // MARK: - Calendar

    private var calendarSection: some View {
        Section {
            LabeledContent("Status", value: calendarStatusDescription)
            Button("Disconnect calendar", role: .destructive) {
                Task { await viewModel.disconnectCalendar() }
            }
            .accessibilityIdentifier("dataPrivacy.disconnectCalendar")
            // Disabled only while in flight — a second tap would fire a
            // second DELETE and, more importantly, could race the first
            // one's local writes (issue #213).
            .disabled(viewModel.isDisconnectingCalendar)

            if viewModel.isDisconnectingCalendar {
                ProgressView()
                    .accessibilityIdentifier("dataPrivacy.disconnectingSpinner")
            }

            // The failure surface. Rendered inline and persistently (rather
            // than as a transient alert) because the state it describes is
            // persistent: the calendar is *still connected*, and the Status
            // row above still says so. #213's whole failure mode was a
            // disconnect that looked like it worked, so an unsuccessful one
            // has to keep saying it didn't.
            if let disconnectError = viewModel.disconnectError {
                Text(disconnectError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("dataPrivacy.disconnectError")
                Text("Your calendar is still connected. Please try again.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Calendar")
        } footer: {
            // Copy revised for #213: the old text ("Disconnecting stops
            // Kairos from reading your free/busy time") described only the
            // half that used to not happen. It now names the server-side
            // revoke explicitly, and — per this issue's future-event
            // decision, see `revokeGoogleConnection.ts` — states plainly
            // that an already-scheduled devotional event stays on the
            // calendar, rather than letting the user discover it later and
            // reasonably conclude the disconnect didn't work.
            Text("Disconnecting revokes Kairos's access to your Google Calendar and stops it reading your free/busy time. Any devotional event already on your calendar stays there — you can delete it yourself. To also revoke calendar access at the system level, use Settings › Privacy › Calendars.")
        }
    }

    // Honest disclosure for the H1 Google Meet delivery path (docs/22 §3,
    // Foundation §8/§9). When a devotional is scheduled on a connected
    // Google Calendar, its event carries a real Google Meet link and a
    // Kairos bot joins at the appointed time to speak the devotional
    // aloud. This copy states plainly what we can and can't control —
    // including the one thing we genuinely can't (Google Meet's own
    // transcription can't be turned off for a bot participant), rather
    // than implying a guarantee we can't keep.
    private var meetingDeliverySection: some View {
        Section {
            Text("For devotionals scheduled on your Google Calendar, the event includes a Google Meet link, and a Kairos voice joins at that time to speak the devotional.")
            Text("Kairos never records, reads, stores, or uses anything from that meeting. The Kairos voice only speaks — it does not listen. Its session data is deleted immediately after it leaves.")
            Text("One thing we can't turn off: Google Meet runs its own live captions for any meeting, which we have no way to disable for a bot participant. Those captions are Google's, not Kairos's — we never receive or keep them. The meeting is only ever your own devotional time or a meeting you personally invited Kairos to.")
                .font(.caption)
        } header: {
            Text("How devotionals reach your meetings")
        } footer: {
            Text("A plain audio page is always available as an alternative to joining by video.")
        }
    }

    // Consent copy for the invite-Kairos flow (Epic I / I6, #66, docs/12
    // §1.2). This is the ONE place a user's own words are deliberately sent
    // to the AI provider (unlike the ambient calendar, which is never
    // sent), so the disclosure is explicit and blunt about it rather than
    // soft. The routing address itself is shown once the receiving domain
    // is finalized; the data-ledger entry for a processed invite is added
    // with the invite-generation path (I2) — until then this section is the
    // standing explanation of what the feature does.
    private var inviteKairosSection: some View {
        Section {
            Text("You can invite Kairos to a meeting you create — add your personal Kairos invite address as a guest, and Kairos will prepare a devotional for that time.")
            Text("When you do, the meeting's title and description are sent to our AI provider (Gloo) to shape that devotional — because you wrote them for Kairos, the same as a note to any other guest. Don't put anything in them you wouldn't want an AI system to read.")
            Text("Nothing else about that meeting is sent — not who else is invited, not where it is. And this only ever applies to a meeting you personally invited Kairos to; your other calendar events are never read this way.")
                .font(.caption)
        } header: {
            Text("Inviting Kairos to a meeting")
        }
    }

    private var calendarStatusDescription: String {
        switch viewModel.calendarStatus {
        case .notConnected:
            return "Not connected"
        case .connected(let kind):
            return "Connected (\(kind.rawValue))"
        case .denied:
            return "Denied"
        }
    }

    // MARK: - Delete account

    private var deleteAccountSection: some View {
        Section {
            Button("Delete account & all data", role: .destructive) {
                showDeleteConfirmation1 = true
            }
            .accessibilityIdentifier("dataPrivacy.deleteAccount")
            if viewModel.isDeletingAccount {
                ProgressView()
                    .accessibilityIdentifier("dataPrivacy.deletingSpinner")
            }
        } footer: {
            Text("This immediately and permanently deletes your account, preferences, devotional history, and connected calendar tokens. This cannot be undone.")
        }
    }

    private func formattedTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

#Preview {
    // The preview provides its own `NavigationStack` since (per the doc
    // comment on `body` above) `DataPrivacyView` itself intentionally does
    // not — in the real app it inherits `PreferencesView`'s stack instead.
    NavigationStack {
        DataPrivacyView(
            makeViewModel: DataPrivacyViewModel(
                consentStore: InMemoryConsentStore(),
                calendarService: FakeCalendarConnectService(status: .connected(.appleEventKit)),
                ledgerProvider: FakeDataLedgerProvider(
                    nextEntry: DataLedgerEntry(
                        sentAt: Date(),
                        recovery: .high,
                        sleepQuality: .fair,
                        activity: .moderate,
                        busyness: "heavy",
                        communicationLoad: nil
                    )
                ),
                deletionClient: FakeAccountDeletionClient(),
                authService: FakeAuthService(),
                googleConnectClient: FakeGoogleConnectClient()
            )
        )
    }
}
