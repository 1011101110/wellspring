import XCTest
@testable import Kairos

/// HomeViewModel card-state logic (issue #252), driven through the in-memory
/// Fake dashboard clients — the same VM-against-fakes pattern as
/// DataPrivacyViewModelTests.
@MainActor
final class HomeViewModelTests: XCTestCase {

    private func makeSUT(
        devotionals: FakeDevotionalsClient = FakeDevotionalsClient(),
        upcoming: FakeUpcomingEventsClient = FakeUpcomingEventsClient(),
        connections: FakeConnectionsClient = FakeConnectionsClient(),
        recap: FakeRecapClient = FakeRecapClient(),
        journal: FakeJournalClient = FakeJournalClient(),
        liturgy: FakeLiturgyClient = FakeLiturgyClient(),
        generateNow: FakeGenerateNowClient = FakeGenerateNowClient(),
        accountInfo: FakeAccountInfoClient = FakeAccountInfoClient()
    ) -> HomeViewModel {
        HomeViewModel(
            devotionals: devotionals, upcomingClient: upcoming, connectionsClient: connections,
            recapClient: recap, journalClient: journal, liturgyClient: liturgy,
            generateNowClient: generateNow, accountInfo: accountInfo,
            now: { Date(timeIntervalSince1970: 1_784_000_000) }
        )
    }

    private func card(_ theme: String, date: String, completed: String? = nil) -> DevotionalCard {
        DevotionalCard(id: theme, date: date, theme: theme, cardSummary: "s", format: "text",
                       createdAt: "2026-07-21T08:00:00Z", completedAt: completed)
    }

    func test_loadAll_populatesEveryCard() async {
        let sut = makeSUT(
            devotionals: FakeDevotionalsClient(
                page: DevotionalPage(devotionals: [card("A", date: "2026-07-21")], nextCursor: "cur"),
                searchResult: []),
            upcoming: FakeUpcomingEventsClient(result: [
                UpcomingCalendarEvent(id: "e", gapStartAt: "2026-07-23T13:00:00Z", gapEndAt: "2026-07-23T14:00:00Z",
                                      meetUri: nil, rescheduleCount: 0, devotional: nil)]),
            connections: FakeConnectionsClient(result: [
                Connection(provider: "google_calendar", status: "active", connectedAt: nil, scopes: nil)]),
            recap: FakeRecapClient(result: MonthlyRecap(year: 2026, month: 7, sessionsCount: 3,
                                     recurringPassages: ["Psalm 23"], heavyWeek: nil, narrative: "n")),
            journal: FakeJournalClient(entries: [JournalEntry(id: "j", text: "t", createdAt: "2026-07-20T08:00:00Z")]),
            liturgy: FakeLiturgyClient(result: .lent),
            accountInfo: FakeAccountInfoClient(result: "me@invite.test")
        )

        await sut.loadAll()

        if case .loaded = sut.today {} else { XCTFail("today not loaded: \(sut.today)") }
        if case .loaded(let events) = sut.upcoming { XCTAssertEqual(events.count, 1) } else { XCTFail("upcoming") }
        if case .loaded(let state) = sut.connection { XCTAssertTrue(state.canSchedule) } else { XCTFail("connection") }
        if case .loaded = sut.history {} else { XCTFail("history") }
        XCTAssertEqual(sut.historyNextCursor, "cur")
        if case .loaded = sut.journal {} else { XCTFail("journal") }
        if case .loaded = sut.recap {} else { XCTFail("recap") }
        XCTAssertEqual(sut.season, .lent)
        XCTAssertEqual(sut.inviteAddress, "me@invite.test")
        XCTAssertTrue(sut.searchAvailable)
    }

    func test_emptyCollections_becomeEmptyStates_notErrors() async {
        let sut = makeSUT()  // all fakes default to empty
        await sut.loadAll()
        XCTAssertEqual(sut.upcoming, .empty)
        XCTAssertEqual(sut.today, .empty)
        XCTAssertEqual(sut.journal, .empty)
        XCTAssertEqual(sut.history, .empty)
        // No connection row → disconnected, but still a loaded state.
        if case .loaded(let s) = sut.connection { XCTAssertFalse(s.canSchedule) } else { XCTFail() }
    }

    func test_recapWithZeroSessions_isEmpty_evenIfReturned() async {
        let sut = makeSUT(recap: FakeRecapClient(result: MonthlyRecap(
            year: 2026, month: 7, sessionsCount: 0, recurringPassages: [], heavyWeek: nil, narrative: "n")))
        await sut.loadRecap()
        XCTAssertEqual(sut.recap, .empty, "A zero-session recap is a threshold miss, shown as empty not populated")
    }

    func test_upcomingError_surfacesAsFailed_withoutTakingDownOtherCards() async {
        let sut = makeSUT(upcoming: FakeUpcomingEventsClient(nextError: .server(statusCode: 500)))
        await sut.loadAll()
        if case .failed = sut.upcoming {} else { XCTFail("upcoming should be .failed") }
        // Another card still loaded independently.
        if case .loaded(let s) = sut.connection { _ = s } else { XCTFail("connection should still load") }
    }

    func test_generateNow_returnsSessionURL_andRefreshes() async {
        let gen = FakeGenerateNowClient(result: GenerateNowOutcome(
            sessionUrl: URL(string: "https://wellspring.test/s/1")!, devotionalId: "d", alreadyExisted: true))
        let sut = makeSUT(generateNow: gen)
        let url = await sut.generateNow()
        XCTAssertEqual(url, URL(string: "https://wellspring.test/s/1"))
        XCTAssertEqual(gen.callCount, 1)
    }

    func test_addAndDeleteJournalEntry() async {
        let journal = FakeJournalClient(entries: [])
        let sut = makeSUT(journal: journal)
        sut.journalDraft = "a new thought"
        await sut.addJournalEntry()
        XCTAssertEqual(sut.journalDraft, "", "Draft clears after saving")
        if case .loaded(let entries) = sut.journal {
            XCTAssertEqual(entries.first?.text, "a new thought")
            await sut.deleteJournalEntry(id: entries.first!.id)
        } else { XCTFail("journal should be loaded with the new entry") }
        XCTAssertEqual(sut.journal, .empty, "Deleting the only entry returns the card to empty")
    }

    func test_todayProvenance_isRecent_whenLatestIsNotToday() async {
        let sut = makeSUT(devotionals: FakeDevotionalsClient(
            page: DevotionalPage(devotionals: [card("Old", date: "2020-01-01")], nextCursor: nil)))
        await sut.loadToday()
        if case .loaded(let content) = sut.today {
            XCTAssertEqual(content.provenance, .recent)
        } else { XCTFail("today should load") }
    }
}
