import SwiftUI

// The individual dashboard cards (issue #252), each mirroring a web component
// under apps/web/src/components/dashboard/. Each reads its slice of
// HomeViewModel and degrades independently.

// MARK: - Today

struct TodayCard: View {
    @ObservedObject var viewModel: HomeViewModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        CardFrame("Today") {
            switch viewModel.today {
            case .loading:
                CardLoading()
            case .failed(let message):
                CardError(message: message) { Task { await viewModel.loadToday() } }
            case .empty:
                VStack(alignment: .leading, spacing: 12) {
                    if let season = viewModel.season { CardHint(season.line) }
                    Text("Wellspring books devotionals into the open moments in your day. Your first one will appear here.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    generateNowButton(title: "Make one now")
                }
            case .loaded(let content):
                VStack(alignment: .leading, spacing: 12) {
                    if let season = viewModel.season { CardHint(season.line) }
                    if content.provenance == .recent {
                        CardHint("From the last devotional Wellspring wrote for you.")
                    }
                    Text(content.devotional.theme)
                        .font(.title3.weight(.semibold))
                        .accessibilityIdentifier("home.today.theme")
                    Text(content.devotional.cardSummary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let verse = content.verse { VerseBlock(verse: verse) }
                    // Opens the native in-app reader (#3), not a web session.
                    NavigationLink {
                        DevotionalReaderScreen(devotionalID: content.devotional.id, viewModel: viewModel)
                    } label: {
                        Text(content.provenance == .today ? "Open today's devotional" : "Read your last devotional")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("home.today.openButton")
                }
            }
        }
    }

    @ViewBuilder
    private func generateNowButton(title: String) -> some View {
        Button {
            Task { if let url = await viewModel.generateNow() { openURL(url) } }
        } label: {
            HStack {
                if viewModel.generateNowBusy { ProgressView().tint(.white) }
                Text(viewModel.generateNowBusy ? "Preparing…" : title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(viewModel.generateNowBusy)
        .accessibilityIdentifier("home.today.openButton")
    }
}

/// The featured passage — text + mandatory "reference — attribution"
/// (Foundation §4.3: YouVersion attribution is byte-exact and always shown).
struct VerseBlock: View {
    let verse: Verse
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verse.fetchedText)
                .font(.body)
                .italic()
            Text("\(verse.reference) — \(verse.attribution)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("home.today.attribution")
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Upcoming

struct UpcomingCard: View {
    @ObservedObject var viewModel: HomeViewModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        CardFrame("Coming up") {
            switch viewModel.upcoming {
            case .loading:
                CardLoading()
            case .failed(let message):
                CardError(message: message) { Task { await viewModel.loadUpcoming() } }
            case .empty:
                CardEmpty(message: "Nothing scheduled yet. When your calendar has an open moment, Wellspring will book one here.")
            case .loaded(let events):
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(events) { event in
                        upcomingRow(event)
                        if event.id != events.last?.id { Divider() }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func upcomingRow(_ event: UpcomingCalendarEvent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(DashboardDate.dayLabel(event.gapStartAt))
                .font(.subheadline.weight(.semibold))
            Text("\(DashboardDate.timeLabel(event.gapStartAt))–\(DashboardDate.timeLabel(event.gapEndAt))")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let devo = event.devotional {
                Text(devo.theme).font(.subheadline)
                Text(devo.cardSummary).font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("Wellspring will write this one closer to the time.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if event.rescheduleCount > 0 {
                CardHint("Moved to fit your day.")
            }
            if let meet = event.meetUri, let url = URL(string: meet) {
                Button("Join the meeting") { openURL(url) }
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Calendar connection status
//
// (The free/busy day view lives in Cards/CalendarDayCard.swift — issue #6.)

struct ConnectionCard: View {
    @ObservedObject var viewModel: HomeViewModel
    var body: some View {
        CardFrame("Calendar") {
            switch viewModel.connection {
            case .loading:
                CardLoading()
            case .failed(let message):
                CardError(message: message) { Task { await viewModel.loadConnection() } }
            case .empty:
                CardEmpty(message: "Connect your calendar to let Wellspring find open moments.")
            case .loaded(let state):
                VStack(alignment: .leading, spacing: 8) {
                    Text(state.body)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if case .active(let since) = state, let since, let date = DashboardDate.parse(since) {
                        CardHint("Connected since \(date.formatted(date: .abbreviated, time: .omitted)).")
                    }
                    if let label = state.actionLabel {
                        // In-card connect/reconnect (#7) — runs the same Google
                        // OAuth as onboarding via the view model.
                        Button {
                            Task { await viewModel.connectCalendar() }
                        } label: {
                            HStack {
                                if viewModel.isConnectingCalendar { ProgressView() }
                                Text(viewModel.isConnectingCalendar ? "Connecting…" : label)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(viewModel.isConnectingCalendar)
                        .accessibilityIdentifier("home.connection.connectButton")
                    }
                }
            }
        }
    }
}

// MARK: - Invite address

struct InviteAddressCard: View {
    @ObservedObject var viewModel: HomeViewModel
    @State private var copied = false

    var body: some View {
        if let address = viewModel.inviteAddress {
            CardFrame("Invite Wellspring") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Add this address as a guest on any calendar invite and Wellspring will bring a devotional to it.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(address)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color(.tertiarySystemGroupedBackground)))
                    Button(copied ? "Copied" : "Copy address") {
                        UIPasteboard.general.string = address
                        copied = true
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
        }
    }
}

// MARK: - Journal

struct JournalCard: View {
    @ObservedObject var viewModel: HomeViewModel
    @State private var pendingDeleteID: String?

    var body: some View {
        CardFrame("Your journal") {
            VStack(alignment: .leading, spacing: 12) {
                Text("A place for whatever you're carrying. Kept until you delete it, and never used to write your devotionals — it's just for you.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                TextEditor(text: $viewModel.journalDraft)
                    .frame(minHeight: 80)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(.tertiarySystemGroupedBackground)))
                    .accessibilityIdentifier("home.journal.field")

                Button {
                    Task { await viewModel.addJournalEntry() }
                } label: {
                    Text(viewModel.isSavingJournal ? "Keeping…" : "Keep this")
                }
                .font(.subheadline.weight(.semibold))
                .disabled(viewModel.isSavingJournal || viewModel.journalDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                switch viewModel.journal {
                case .loading:
                    CardLoading(label: "Opening your journal…")
                case .failed(let message):
                    CardError(message: message) { Task { await viewModel.loadJournal() } }
                case .empty:
                    CardEmpty(message: "Nothing here yet. What's on your mind today?")
                case .loaded(let entries):
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(entries) { entry in
                            journalRow(entry)
                            if entry.id != entries.last?.id { Divider() }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func journalRow(_ entry: JournalEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(DashboardDate.dayLabel(entry.createdAt))
                .font(.caption).foregroundStyle(.secondary)
            Text(entry.text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            if pendingDeleteID == entry.id {
                HStack(spacing: 12) {
                    Button("Delete", role: .destructive) {
                        pendingDeleteID = nil
                        Task { await viewModel.deleteJournalEntry(id: entry.id) }
                    }
                    Button("Cancel") { pendingDeleteID = nil }
                }
                .font(.caption)
            } else {
                Button("Delete") { pendingDeleteID = entry.id }
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - History

struct HistoryCard: View {
    @ObservedObject var viewModel: HomeViewModel
    @State private var searchText = ""

    var body: some View {
        CardFrame("Your devotionals") {
            VStack(alignment: .leading, spacing: 12) {
                if viewModel.searchAvailable {
                    HStack {
                        TextField("Search devotionals", text: $searchText)
                            .textFieldStyle(.roundedBorder)
                            .submitLabel(.search)
                            .onSubmit { Task { await viewModel.runSearch(searchText) } }
                            .accessibilityIdentifier("home.history.search")
                        if viewModel.searchResults != nil {
                            Button("Clear") { searchText = ""; viewModel.clearSearch() }
                                .font(.subheadline)
                        }
                    }
                }

                if let results = viewModel.searchResults {
                    if results.isEmpty {
                        CardEmpty(message: "No devotionals matched that.")
                    } else {
                        devotionalList(results, showMore: false)
                    }
                } else {
                    switch viewModel.history {
                    case .loading:
                        CardLoading()
                    case .failed(let message):
                        CardError(message: message) { Task { await viewModel.loadHistory() } }
                    case .empty:
                        CardEmpty(message: "Your devotionals will collect here as they happen, newest first.")
                    case .loaded(let cards):
                        devotionalList(cards, showMore: viewModel.historyNextCursor != nil)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func devotionalList(_ cards: [DevotionalCard], showMore: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(cards) { card in
                NavigationLink {
                    DevotionalReaderScreen(devotionalID: card.id, viewModel: viewModel)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(card.theme).font(.subheadline.weight(.semibold))
                        Text(DashboardDate.calendarDateLabel(card.date))
                            .font(.caption).foregroundStyle(.secondary)
                        Text(card.cardSummary).font(.footnote).foregroundStyle(.secondary)
                        if card.completedAt != nil {
                            CardHint("You sat with this one.")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if card.id != cards.last?.id { Divider() }
            }
            if showMore {
                Button {
                    Task { await viewModel.loadMoreHistory() }
                } label: {
                    Text(viewModel.isLoadingMoreHistory ? "Loading…" : "Show more")
                }
                .font(.subheadline.weight(.semibold))
                .disabled(viewModel.isLoadingMoreHistory)
            }
        }
    }
}

// MARK: - Recap

struct RecapCard: View {
    @ObservedObject var viewModel: HomeViewModel
    var body: some View {
        // Empty recap is silent (no card), matching the web's threshold gate.
        if case .loaded(let recap) = viewModel.recap {
            CardFrame(recap.title()) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(recap.narrative).font(.subheadline)
                    if !recap.recurringPassages.isEmpty {
                        CardHint("You kept returning to \(recap.recurringPassages.joined(separator: ", ")).")
                    }
                    if let heavy = recap.heavyWeek {
                        CardHint(heavy.label)
                    }
                }
            }
        }
    }
}

// MARK: - Coming soon

struct ComingSoonCard: View {
    private let items: [(title: String, body: String)] = [
        ("Spoken devotionals", "Join the calendar event and a voice reads it aloud."),
        ("Weekly rhythm", "A gentler cadence for the days you set aside."),
        ("Shared prayer", "Bring a friend into the same passage."),
    ]
    var body: some View {
        CardFrame("Coming to Wellspring") {
            VStack(alignment: .leading, spacing: 12) {
                Text("These are being built. Nothing here is switched on yet.")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(items, id: \.title) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.subheadline.weight(.semibold))
                        Text(item.body).font(.footnote).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
