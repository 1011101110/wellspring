import Foundation

// Wire models for the signed-in dashboard (issue #252 — iOS parity with the
// web dashboard at apps/web/src/views/Dashboard.tsx). Each mirrors a
// shared-contracts response shape (packages/shared-contracts/src/api/*).
// Kept as hand-written `Decodable` structs — iOS does not consume the TS
// contracts package — matching that repo's existing per-client convention.

// MARK: - Upcoming calendar events (GET /v1/calendar-events/upcoming)

public struct UpcomingEventDevotional: Decodable, Equatable, Sendable {
    public let id: String
    public let theme: String
    public let cardSummary: String

    public init(id: String, theme: String, cardSummary: String) {
        self.id = id
        self.theme = theme
        self.cardSummary = cardSummary
    }
}

public struct UpcomingCalendarEvent: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    /// ISO-8601 start of the open gap the devotional is booked into.
    public let gapStartAt: String
    public let gapEndAt: String
    public let meetUri: String?
    public let rescheduleCount: Int
    /// Nil until Wellspring writes the devotional for this slot (it composes
    /// closer to the time — see the web UpcomingList "will write this one
    /// closer to the time" copy).
    public let devotional: UpcomingEventDevotional?

    public init(
        id: String,
        gapStartAt: String,
        gapEndAt: String,
        meetUri: String?,
        rescheduleCount: Int,
        devotional: UpcomingEventDevotional?
    ) {
        self.id = id
        self.gapStartAt = gapStartAt
        self.gapEndAt = gapEndAt
        self.meetUri = meetUri
        self.rescheduleCount = rescheduleCount
        self.devotional = devotional
    }
}

// MARK: - Connections (GET /v1/connections)

public struct Connection: Decodable, Equatable, Sendable {
    public let provider: String       // 'google_calendar'
    public let status: String         // 'active' | 'revoked' | 'error'
    public let connectedAt: String?
    public let scopes: [String]?

    public init(provider: String, status: String, connectedAt: String?, scopes: [String]?) {
        self.provider = provider
        self.status = status
        self.connectedAt = connectedAt
        self.scopes = scopes
    }
}

/// Derived, presentation-facing connection state — mirrors the web
/// `deriveConnectionState`: what the Calendar card should say and whether it
/// offers a connect action. Scheduling only works when `active`.
public enum ConnectionState: Equatable, Sendable {
    case active(connectedAt: String?)
    case needsAttention   // status 'error' — token/scope problem
    case disconnected     // no connection / revoked

    public static func derive(from connections: [Connection]) -> ConnectionState {
        guard let cal = connections.first(where: { $0.provider == "google_calendar" }) else {
            return .disconnected
        }
        switch cal.status {
        case "active": return .active(connectedAt: cal.connectedAt)
        case "error": return .needsAttention
        default: return .disconnected
        }
    }

    public var canSchedule: Bool {
        if case .active = self { return true }
        return false
    }

    public var title: String { "Calendar" }

    public var body: String {
        switch self {
        case .active:
            return "Connected. Wellspring reads only your free/busy time to find an open moment — never event titles, attendees, or notes."
        case .needsAttention:
            return "Wellspring lost access to your calendar. Reconnect so it can keep finding open moments."
        case .disconnected:
            return "Connect your calendar and Wellspring will book a short devotional into an open moment in your day."
        }
    }

    /// Nil when connected (no action needed) — matches the web hiding the
    /// button in the active state.
    public var actionLabel: String? {
        switch self {
        case .active: return nil
        case .needsAttention: return "Reconnect calendar"
        case .disconnected: return "Connect calendar"
        }
    }
}

// MARK: - Monthly recap (GET /v1/recap/:year/:month)

public struct MonthlyRecap: Decodable, Equatable, Sendable {
    public struct HeavyWeek: Decodable, Equatable, Sendable {
        public let label: String
        public init(label: String) { self.label = label }
    }

    public let year: Int
    public let month: Int          // 1-based
    public let sessionsCount: Int  // threshold only — never shown
    public let recurringPassages: [String]
    public let heavyWeek: HeavyWeek?
    public let narrative: String

    public init(year: Int, month: Int, sessionsCount: Int, recurringPassages: [String], heavyWeek: HeavyWeek?, narrative: String) {
        self.year = year
        self.month = month
        self.sessionsCount = sessionsCount
        self.recurringPassages = recurringPassages
        self.heavyWeek = heavyWeek
        self.narrative = narrative
    }

    /// "Your June recap" / "Your December 2025 recap" (current year drops the
    /// year, like the web `recapTitle`).
    public func title(now: Date = Date(), calendar: Calendar = .current) -> String {
        let months = ["", "January", "February", "March", "April", "May", "June",
                      "July", "August", "September", "October", "November", "December"]
        let name = (1...12).contains(month) ? months[month] : ""
        let thisYear = calendar.component(.year, from: now)
        return year == thisYear ? "Your \(name) recap" : "Your \(name) \(year) recap"
    }
}

// MARK: - Journal (GET/POST/DELETE /v1/journal)

public struct JournalEntry: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let text: String
    public let createdAt: String

    public init(id: String, text: String, createdAt: String) {
        self.id = id
        self.text = text
        self.createdAt = createdAt
    }
}

// MARK: - Liturgical season (GET /v1/liturgical-season)

public enum LiturgicalSeason: String, Decodable, Equatable, Sendable, CaseIterable {
    case advent
    case christmastide
    case lent
    case eastertide
    case ordinaryTime = "ordinary_time"

    /// The one-line hint shown above Today — mirrors the web `SEASON_LINES`.
    public var line: String {
        switch self {
        case .advent:        return "Advent — a season of waiting and hope."
        case .christmastide: return "Christmastide — the Word made flesh."
        case .lent:          return "Lent — a season of returning."
        case .eastertide:    return "Eastertide — the season of resurrection."
        case .ordinaryTime:  return "Ordinary Time — the long, faithful middle."
        }
    }
}

// MARK: - Devotionals (GET /v1/devotionals, /v1/devotionals/:id)

public struct DevotionalCard: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let date: String
    public let theme: String
    public let cardSummary: String
    public let format: String
    public let createdAt: String
    public let completedAt: String?

    public init(id: String, date: String, theme: String, cardSummary: String, format: String, createdAt: String, completedAt: String?) {
        self.id = id
        self.date = date
        self.theme = theme
        self.cardSummary = cardSummary
        self.format = format
        self.createdAt = createdAt
        self.completedAt = completedAt
    }
}

public struct Verse: Decodable, Equatable, Sendable {
    public let usfm: String
    public let reference: String
    public let fetchedText: String
    public let attribution: String

    public init(usfm: String, reference: String, fetchedText: String, attribution: String) {
        self.usfm = usfm
        self.reference = reference
        self.fetchedText = fetchedText
        self.attribution = attribution
    }
}

/// The `/v1/devotionals/:id` detail row is returned unmapped, so the wire is
/// snake_case (see the shared-contract note on DevotionalDetailSchema).
public struct DevotionalDetail: Decodable, Equatable, Sendable {
    public let id: String
    public let date: String
    public let format: String
    public let theme: String
    public let verses: [Verse]
    public let devotionalBody: String
    public let cardSummary: String
    public let prayer: String
    public let journalingPrompt: String?
    public let actionStep: String?
    public let audioObject: String?
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, date, format, theme, verses, prayer
        case devotionalBody = "devotional_body"
        case cardSummary = "card_summary"
        case journalingPrompt = "journaling_prompt"
        case actionStep = "action_step"
        case audioObject = "audio_object"
        case createdAt = "created_at"
    }

    /// The verse to feature on Today — the first, matching the web
    /// `primaryVerse`.
    public var primaryVerse: Verse? { verses.first }
}

// MARK: - Generate-now ("+" on Today, POST /v1/devotional/generate-now)

public struct GenerateNowOutcome: Equatable, Sendable {
    public let sessionUrl: URL
    public let devotionalId: String
    /// True when today's devotional already existed — a success, not an error
    /// (the web treats `alreadyExisted` as "open it").
    public let alreadyExisted: Bool

    public init(sessionUrl: URL, devotionalId: String, alreadyExisted: Bool) {
        self.sessionUrl = sessionUrl
        self.devotionalId = devotionalId
        self.alreadyExisted = alreadyExisted
    }
}

// MARK: - Shared date formatting helpers

public enum DashboardDate {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parse(_ iso8601: String) -> Date? {
        iso.date(from: iso8601) ?? isoNoFraction.date(from: iso8601)
    }

    /// "Monday, June 3" style day label.
    public static func dayLabel(_ iso8601: String, timeZone: TimeZone = .current) -> String {
        guard let date = parse(iso8601) else { return iso8601 }
        let f = DateFormatter()
        f.timeZone = timeZone
        f.dateFormat = "EEEE, MMMM d"
        return f.string(from: date)
    }

    /// "8:30 AM" style time label.
    public static func timeLabel(_ iso8601: String, timeZone: TimeZone = .current) -> String {
        guard let date = parse(iso8601) else { return iso8601 }
        let f = DateFormatter()
        f.timeZone = timeZone
        f.timeStyle = .short
        f.dateStyle = .none
        return f.string(from: date)
    }

    /// Calendar-date label from a plain `YYYY-MM-DD` string (devotional.date).
    public static func calendarDateLabel(_ ymd: String) -> String {
        let inF = DateFormatter()
        inF.dateFormat = "yyyy-MM-dd"
        inF.timeZone = TimeZone(identifier: "UTC")
        guard let date = inF.date(from: ymd) else { return ymd }
        let outF = DateFormatter()
        outF.dateFormat = "MMMM d, yyyy"
        return outF.string(from: date)
    }
}
