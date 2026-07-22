import Foundation

/// Representative demo content for the dashboard in demo mode (fake services,
/// no live network — docs/00_FOUNDATION.md §11). Lets the signed-in Home be
/// exercised in previews / UI tests / the demo build with believable data,
/// the same role `DemoFixtureSnapshot` played for the old Home.
enum DashboardDemoData {
    private static func todayYMD() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: Date())
    }

    private static func isoInHours(_ hours: Int) -> String {
        let date = Calendar.current.date(byAdding: .hour, value: hours, to: Date()) ?? Date()
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: date)
    }

    static let restVerse = Verse(
        usfm: "MAT.11.28-MAT.11.30",
        reference: "Matthew 11:28–30",
        fetchedText: "Come to me, all you who are weary and burdened, and I will give you rest. Take my yoke upon you and learn from me, for I am gentle and humble in heart, and you will find rest for your souls.",
        attribution: "New International Version (NIV)"
    )

    static func devotionals() -> FakeDevotionalsClient {
        let today = todayYMD()
        let cards = [
            DevotionalCard(id: "devo-today", date: today, theme: "Rest for the weary",
                           cardSummary: "A short pause to breathe and remember you are carried, not carrying.",
                           format: "text", createdAt: isoInHours(-2), completedAt: nil),
            DevotionalCard(id: "devo-2", date: "2026-07-20", theme: "The gift of enough",
                           cardSummary: "On a full day, a reminder that today's grace is sufficient for today.",
                           format: "text", createdAt: "2026-07-20T08:00:00Z", completedAt: "2026-07-20T08:12:00Z"),
            DevotionalCard(id: "devo-3", date: "2026-07-18", theme: "Still waters",
                           cardSummary: "A few quiet lines for the middle of a loud week.",
                           format: "text", createdAt: "2026-07-18T08:00:00Z", completedAt: nil),
        ]
        let detail = DevotionalDetail(
            id: "devo-today", date: today, format: "text", theme: "Rest for the weary",
            verses: [restVerse],
            devotionalBody: "You have carried a great deal today. Set it down for a moment.",
            cardSummary: "A short pause to breathe and remember you are carried, not carrying.",
            prayer: "Lord, teach me the unforced rhythms of grace.",
            journalingPrompt: "What are you carrying that you could hand over right now?",
            actionStep: nil, audioObject: nil, createdAt: isoInHours(-2)
        )
        return FakeDevotionalsClient(
            page: DevotionalPage(devotionals: cards, nextCursor: nil),
            detailByID: ["devo-today": detail],
            searchResult: []
        )
    }

    static func upcoming() -> FakeUpcomingEventsClient {
        FakeUpcomingEventsClient(result: [
            UpcomingCalendarEvent(
                id: "evt-1", gapStartAt: isoInHours(20), gapEndAt: isoInHours(21),
                meetUri: "https://meet.google.com/demo-abc-defg", rescheduleCount: 0,
                devotional: UpcomingEventDevotional(id: "devo-next", theme: "Morning quiet",
                    cardSummary: "A gentle start before the day fills up.")
            ),
            UpcomingCalendarEvent(
                id: "evt-2", gapStartAt: isoInHours(44), gapEndAt: isoInHours(45),
                meetUri: nil, rescheduleCount: 1, devotional: nil
            ),
        ])
    }

    static func connections() -> FakeConnectionsClient {
        FakeConnectionsClient(result: [
            Connection(provider: "google_calendar", status: "active",
                       connectedAt: "2026-06-01T09:00:00Z", scopes: ["calendar.freebusy"])
        ])
    }

    static func recap() -> FakeRecapClient {
        let comps = Calendar.current.dateComponents([.year, .month], from: Date())
        return FakeRecapClient(result: MonthlyRecap(
            year: comps.year ?? 2026, month: comps.month ?? 7, sessionsCount: 9,
            recurringPassages: ["Psalm 23", "Matthew 11"],
            heavyWeek: MonthlyRecap.HeavyWeek(label: "Your busiest week, Wellspring met you four mornings."),
            narrative: "This month you kept showing up in the small gaps — a few minutes here and there added up to a steady thread of rest."
        ))
    }

    static func journal() -> FakeJournalClient {
        FakeJournalClient(entries: [
            JournalEntry(id: "j1", text: "Grateful for a slower morning today.", createdAt: "2026-07-21T07:30:00Z"),
            JournalEntry(id: "j2", text: "Carrying the meeting at 3. Trying to hand it over.", createdAt: "2026-07-19T21:10:00Z"),
        ])
    }

    static func liturgy() -> FakeLiturgyClient { FakeLiturgyClient(result: .ordinaryTime) }

    static func accountInfo() -> FakeAccountInfoClient {
        FakeAccountInfoClient(result: "you.devotional@invite.wellspring.app")
    }

    static func generateNow() -> FakeGenerateNowClient {
        FakeGenerateNowClient(result: GenerateNowOutcome(
            sessionUrl: URL(string: "https://wellspring.example/session/demo")!,
            devotionalId: "devo-today", alreadyExisted: true))
    }
}
