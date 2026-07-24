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
                        .font(WSTheme.ui(size: 15))
                        .foregroundStyle(WSTheme.mutedInk)
                        .lineSpacing(4)
                    generateNowButton(title: "Make one now")
                }
            case .loaded(let content):
                VStack(alignment: .leading, spacing: 12) {
                    if let season = viewModel.season { CardHint(season.line) }
                    if content.provenance == .recent {
                        CardHint("From the last devotional Wellspring wrote for you.")
                    }
                    // §05 verse block: the theme is the eyebrow over the
                    // quote. `.textCase` only changes the rendering — the
                    // accessibility identifier the UI tests query is
                    // untouched.
                    Text(content.devotional.theme)
                        .wsEyebrow()
                        .accessibilityIdentifier("home.today.theme")
                    Text(content.devotional.cardSummary)
                        .font(WSTheme.ui(size: 15))
                        .foregroundStyle(WSTheme.mutedInk)
                        .lineSpacing(4)
                    if let verse = content.verse { VerseBlock(verse: verse) }
                    // Opens the native in-app reader (#3), not a web session.
                    // The screen's one focal point (§08) — the pill CTA.
                    NavigationLink {
                        DevotionalReaderScreen(devotionalID: content.devotional.id, viewModel: viewModel)
                    } label: {
                        Text(content.provenance == .today ? "Open today's devotional" : "Read your last devotional")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(WSPillButtonStyle())
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
        .buttonStyle(WSPillButtonStyle())
        .disabled(viewModel.generateNowBusy)
        // Distinct from the loaded state's "home.today.openButton" (S4 #345
        // — the two used to share an identifier; they can never coexist, but
        // a duplicate id makes any future empty-state UI test ambiguous).
        // KairosUITests only reference "home.today.openButton", checked.
        .accessibilityIdentifier("home.today.generateButton")
    }
}

/// The featured passage — text + mandatory "reference — attribution"
/// (Foundation §4.3: YouVersion attribution is byte-exact and always shown).
struct VerseBlock: View {
    let verse: Verse
    var body: some View {
        // §05 signature verse block: Spectral 300 quote on the soft dawn
        // gradient, Hanken 500 reference line. Text is byte-exact
        // (Foundation §4.3) — only the dress changes here.
        VStack(alignment: .leading, spacing: 10) {
            Text(verse.fetchedText)
                .font(WSTheme.scripture(size: 24))
                .foregroundStyle(WSTheme.ink)
                .lineSpacing(8)
            Text("\(verse.reference) — \(verse.attribution)")
                .font(WSTheme.reference())
                .foregroundStyle(WSTheme.mutedInk)
                .accessibilityIdentifier("home.today.attribution")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: WSTheme.radiusInset, style: .continuous)
                .fill(WSTheme.verseGradient)
        )
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
            // §05 "Held for you" line: the 6px terracotta dot marks the
            // moment; time in Hanken 500.
            HStack(spacing: 8) {
                Circle()
                    .fill(WSTheme.terracotta)
                    .frame(width: 6, height: 6)
                Text(DashboardDate.dayLabel(event.gapStartAt))
                    .font(WSTheme.ui(.semibold, size: 15))
                    .foregroundStyle(WSTheme.ink)
            }
            Text("\(DashboardDate.timeLabel(event.gapStartAt))–\(DashboardDate.timeLabel(event.gapEndAt))")
                .font(WSTheme.reference())
                .foregroundStyle(WSTheme.mutedInk)
            if let devo = event.devotional {
                Text(devo.theme)
                    .font(WSTheme.ui(.medium, size: 15))
                    .foregroundStyle(WSTheme.ink)
                Text(devo.cardSummary)
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
            } else {
                Text("Wellspring will write this one closer to the time.")
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
            }
            if event.rescheduleCount > 0 {
                CardHint("Moved to fit your day.")
            }
            if let meet = event.meetUri, let url = URL(string: meet) {
                Button("Join the meeting") { openURL(url) }
                    .font(WSTheme.ui(.semibold, size: 15))
                    .foregroundStyle(WSTheme.clayDeep)
                    .frame(minHeight: 44)
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
                        .font(WSTheme.ui(size: 15))
                        .foregroundStyle(WSTheme.mutedInk)
                        .lineSpacing(4)
                    if case .active(let since) = state, let since, let date = DashboardDate.parse(since) {
                        CardHint("Connected since \(date.formatted(date: .abbreviated, time: .omitted)).")
                    }
                    if let label = state.actionLabel {
                        // In-card connect/reconnect (#7) — runs the same Google
                        // OAuth as onboarding via the view model. A quiet pill:
                        // the Today CTA keeps the screen's one focal point.
                        Button {
                            Task { await viewModel.connectCalendar() }
                        } label: {
                            HStack {
                                if viewModel.isConnectingCalendar { ProgressView() }
                                Text(viewModel.isConnectingCalendar ? "Connecting…" : label)
                            }
                        }
                        .buttonStyle(WSQuietPillButtonStyle())
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
                        .font(WSTheme.ui(size: 15))
                        .foregroundStyle(WSTheme.mutedInk)
                        .lineSpacing(4)
                    Text(address)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(WSTheme.ink)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: CardLayout.insetCornerRadius, style: .continuous).fill(WSTheme.mist))
                    Button(copied ? "Copied" : "Copy address") {
                        UIPasteboard.general.string = address
                        copied = true
                    }
                    .font(WSTheme.ui(.semibold, size: 15))
                    .foregroundStyle(WSTheme.clayDeep)
                    .frame(minHeight: 44)
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
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
                    .lineSpacing(3)

                TextEditor(text: $viewModel.journalDraft)
                    .font(WSTheme.ui(size: 15))
                    .foregroundStyle(WSTheme.ink)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 80)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: CardLayout.insetCornerRadius, style: .continuous).fill(WSTheme.mist))
                    .accessibilityIdentifier("home.journal.field")

                Button {
                    Task { await viewModel.addJournalEntry() }
                } label: {
                    Text(viewModel.isSavingJournal ? "Keeping…" : "Keep this")
                }
                .buttonStyle(WSQuietPillButtonStyle())
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
                .font(WSTheme.reference())
                .foregroundStyle(WSTheme.mutedInk)
            Text(entry.text)
                .font(WSTheme.ui(size: 15))
                .foregroundStyle(WSTheme.ink)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            if pendingDeleteID == entry.id {
                HStack(spacing: 12) {
                    Button("Delete", role: .destructive) {
                        pendingDeleteID = nil
                        Task { await viewModel.deleteJournalEntry(id: entry.id) }
                    }
                    Button("Cancel") { pendingDeleteID = nil }
                }
                .font(WSTheme.ui(.medium, size: 13))
            } else {
                Button("Delete") { pendingDeleteID = entry.id }
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
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
                                .font(WSTheme.ui(.medium, size: 15))
                                .foregroundStyle(WSTheme.clayDeep)
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

    /// Row markup + pagination live in the shared `DevotionalCardList`
    /// (S4 #345) — this card only wires in its `HomeViewModel` plumbing.
    private func devotionalList(_ cards: [DevotionalCard], showMore: Bool) -> some View {
        DevotionalCardList(
            cards: cards,
            showMore: showMore,
            isLoadingMore: viewModel.isLoadingMoreHistory,
            loadMore: { Task { await viewModel.loadMoreHistory() } },
            makeReader: { DevotionalReaderScreen(devotionalID: $0.id, viewModel: viewModel) }
        )
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
                    Text(recap.narrative)
                        .font(WSTheme.ui(size: 15))
                        .foregroundStyle(WSTheme.ink)
                        .lineSpacing(4)
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
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
                ForEach(items, id: \.title) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(WSTheme.ui(.medium, size: 15))
                            .foregroundStyle(WSTheme.ink)
                        Text(item.body)
                            .font(WSTheme.ui(size: 13))
                            .foregroundStyle(WSTheme.mutedInk)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
