import Foundation

/// One card's fetch lifecycle. Mirrors the web dashboard's per-card model:
/// every card owns its own load and degrades independently — one endpoint
/// failing never takes the whole screen down (Dashboard.tsx docstring).
public enum CardState<Value: Equatable>: Equatable {
    case loading
    case loaded(Value)
    case empty
    case failed(String)
}

public enum TodayProvenance: Equatable, Sendable {
    case today   // the most recent devotional is dated today
    case recent  // the last one Wellspring wrote, from an earlier day
}

public struct TodayContent: Equatable, Sendable {
    public let devotional: DevotionalCard
    public let verse: Verse?
    public let provenance: TodayProvenance
}

/// Backs the signed-in Home (issue #252) — the iOS counterpart to the web
/// dashboard. Assembled from AppEnvironment via `makeHomeViewModel()`.
@MainActor
public final class HomeViewModel: ObservableObject {
    // Per-card state (independent, like the web's useCardData).
    @Published public private(set) var today: CardState<TodayContent> = .loading
    @Published public private(set) var season: LiturgicalSeason?
    @Published public private(set) var upcoming: CardState<[UpcomingCalendarEvent]> = .loading
    @Published public private(set) var connection: CardState<ConnectionState> = .loading
    @Published public private(set) var history: CardState<[DevotionalCard]> = .loading
    @Published public private(set) var historyNextCursor: String?
    @Published public private(set) var isLoadingMoreHistory = false
    @Published public private(set) var journal: CardState<[JournalEntry]> = .loading
    @Published public private(set) var recap: CardState<MonthlyRecap> = .loading
    @Published public private(set) var inviteAddress: String?
    @Published public private(set) var searchAvailable = false
    @Published public private(set) var searchResults: [DevotionalCard]?

    // Transient action state.
    @Published public var generateNowBusy = false
    @Published public var actionError: String?
    @Published public var journalDraft: String = ""
    @Published public var isSavingJournal = false

    private let devotionals: any DevotionalsProviding
    private let upcomingClient: any UpcomingEventsProviding
    private let connectionsClient: any ConnectionsProviding
    private let recapClient: any RecapProviding
    private let journalClient: any JournalProviding
    private let liturgyClient: any LiturgyProviding
    private let generateNowClient: any GenerateNowRequesting
    private let accountInfo: any AccountInfoProviding
    private let now: () -> Date

    public init(
        devotionals: any DevotionalsProviding,
        upcomingClient: any UpcomingEventsProviding,
        connectionsClient: any ConnectionsProviding,
        recapClient: any RecapProviding,
        journalClient: any JournalProviding,
        liturgyClient: any LiturgyProviding,
        generateNowClient: any GenerateNowRequesting,
        accountInfo: any AccountInfoProviding,
        now: @escaping () -> Date = { Date() }
    ) {
        self.devotionals = devotionals
        self.upcomingClient = upcomingClient
        self.connectionsClient = connectionsClient
        self.recapClient = recapClient
        self.journalClient = journalClient
        self.liturgyClient = liturgyClient
        self.generateNowClient = generateNowClient
        self.accountInfo = accountInfo
        self.now = now
    }

    // MARK: - Loading

    /// Kick off every card concurrently.
    public func loadAll() async {
        async let a: Void = loadToday()
        async let b: Void = loadUpcoming()
        async let c: Void = loadConnection()
        async let d: Void = loadHistory()
        async let e: Void = loadJournal()
        async let f: Void = loadRecap()
        async let g: Void = loadSeason()
        async let h: Void = loadInviteAddress()
        async let i: Void = probeSearch()
        _ = await (a, b, c, d, e, f, g, h, i)
    }

    private func message(for error: Error) -> String {
        (error as? DashboardError)?.errorDescription ?? "Something went wrong."
    }

    public func loadToday() async {
        today = .loading
        do {
            let page = try await devotionals.list(cursor: nil)
            guard let latest = page.devotionals.first else { today = .empty; return }
            let detail = try? await devotionals.detail(id: latest.id)
            let provenance: TodayProvenance = isToday(latest.date) ? .today : .recent
            today = .loaded(TodayContent(devotional: latest, verse: detail?.primaryVerse, provenance: provenance))
        } catch {
            today = .failed(message(for: error))
        }
    }

    public func loadUpcoming() async {
        upcoming = .loading
        do {
            let events = try await upcomingClient.upcoming()
            upcoming = events.isEmpty ? .empty : .loaded(events)
        } catch {
            upcoming = .failed(message(for: error))
        }
    }

    public func loadConnection() async {
        connection = .loading
        do {
            let state = ConnectionState.derive(from: try await connectionsClient.connections())
            connection = .loaded(state)
        } catch {
            connection = .failed(message(for: error))
        }
    }

    public func loadHistory() async {
        history = .loading
        do {
            let page = try await devotionals.list(cursor: nil)
            historyNextCursor = page.nextCursor
            history = page.devotionals.isEmpty ? .empty : .loaded(page.devotionals)
        } catch {
            history = .failed(message(for: error))
        }
    }

    public func loadMoreHistory() async {
        guard case .loaded(let current) = history, let cursor = historyNextCursor, !isLoadingMoreHistory else { return }
        isLoadingMoreHistory = true
        defer { isLoadingMoreHistory = false }
        do {
            let page = try await devotionals.list(cursor: cursor)
            historyNextCursor = page.nextCursor
            history = .loaded(current + page.devotionals)
        } catch {
            actionError = message(for: error)
        }
    }

    public func loadJournal() async {
        journal = .loading
        do {
            let page = try await journalClient.list(before: nil)
            journal = page.entries.isEmpty ? .empty : .loaded(page.entries)
        } catch {
            journal = .failed(message(for: error))
        }
    }

    public func loadRecap() async {
        recap = .loading
        let comps = Calendar.current.dateComponents([.year, .month], from: now())
        guard let year = comps.year, let month = comps.month else { recap = .empty; return }
        do {
            let r = try await recapClient.recap(year: year, month: month)
            recap = r.sessionsCount == 0 ? .empty : .loaded(r)
        } catch {
            // A recap simply not existing yet reads as empty, not an error.
            if case DashboardError.server(let code) = error, code == 404 { recap = .empty }
            else { recap = .failed(message(for: error)) }
        }
    }

    public func loadSeason() async {
        season = (try? await liturgyClient.currentSeason()) ?? nil
    }

    public func loadInviteAddress() async {
        inviteAddress = (try? await accountInfo.inviteAddress()) ?? nil
    }

    private func probeSearch() async {
        // Fail-closed: only offer search once we know the endpoint answers.
        searchAvailable = (try? await devotionals.search(query: "a")) != nil
    }

    // MARK: - Actions

    public func runSearch(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { searchResults = nil; return }
        do { searchResults = try await devotionals.search(query: trimmed) ?? [] }
        catch { actionError = message(for: error) }
    }

    public func clearSearch() { searchResults = nil }

    public func addJournalEntry() async {
        let text = journalDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSavingJournal else { return }
        isSavingJournal = true
        defer { isSavingJournal = false }
        do {
            _ = try await journalClient.create(text: text)
            journalDraft = ""
            await loadJournal()
        } catch {
            actionError = message(for: error)
        }
    }

    public func deleteJournalEntry(id: String) async {
        do {
            try await journalClient.delete(id: id)
            await loadJournal()
        } catch {
            actionError = message(for: error)
        }
    }

    /// Fires a routine "make one now" and returns the session URL to open.
    public func generateNow() async -> URL? {
        guard !generateNowBusy else { return nil }
        generateNowBusy = true
        defer { generateNowBusy = false }
        do {
            let outcome = try await generateNowClient.generateNow()
            // Refresh Today/history so the new (or existing) one shows.
            await loadToday()
            await loadHistory()
            return outcome.sessionUrl
        } catch {
            actionError = message(for: error)
            return nil
        }
    }

    // MARK: - Helpers

    private func isToday(_ ymd: String) -> Bool {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        let todayString = f.string(from: now())
        return ymd == todayString
    }

    /// TODAY headline copy, keyed on provenance (mirrors web TODAY_HEADLINES).
    public var todayHeadline: String {
        switch today {
        case .loaded(let content):
            return content.provenance == .today ? "Today's devotional is ready." : "Your last devotional"
        default:
            return "Today"
        }
    }
}
