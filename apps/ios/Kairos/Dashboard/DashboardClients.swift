import Foundation

// HTTP clients for the signed-in dashboard (issue #252). Each concern gets a
// protocol seam (so the view model + tests depend on the abstraction), an
// `HTTP…` implementation, and an in-memory `Fake…` twin for demo mode /
// previews / tests — the same shape as HTTPDistressCheckinClient et al.
//
// `baseURL` is always injected from AppEnvironment.apiBaseURL and auth is the
// Firebase-ID-token bearer; no client here carries a URL literal of its own.

// MARK: - Shared error + transport

public enum DashboardError: Error, Equatable, LocalizedError {
    case notAuthenticated
    case network(String)
    case server(statusCode: Int)

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Not signed in."
        case .network(let detail): return "Network problem: \(detail)"
        case .server(let statusCode): return "Server error (\(statusCode))."
        }
    }
}

/// The common token → request → status-check → decode flow, factored out so
/// each client stays a thin, declarative wrapper.
struct DashboardTransport: Sendable {
    let baseURL: URL
    let session: URLSession
    let idTokenProvider: @Sendable () async throws -> String

    private func makeRequest(path: String, query: [URLQueryItem], method: String, jsonBody: Data?) async throws -> URLRequest {
        let token: String
        do { token = try await idTokenProvider() }
        catch { throw DashboardError.notAuthenticated }

        var url = baseURL.appendingPathComponent(path)
        if !query.isEmpty, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = query
            if let u = comps.url { url = u }
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let jsonBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = jsonBody
        }
        return request
    }

    /// Returns the decoded body, or throws DashboardError. `notFoundReturnsNil`
    /// lets probe-style endpoints (search) treat 404 as "unavailable".
    func send<T: Decodable>(
        path: String,
        query: [URLQueryItem] = [],
        method: String = "GET",
        jsonBody: Data? = nil,
        as type: T.Type
    ) async throws -> T {
        let request = try await makeRequest(path: path, query: query, method: method, jsonBody: jsonBody)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw DashboardError.network(error.localizedDescription) }

        guard let http = response as? HTTPURLResponse else {
            throw DashboardError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw DashboardError.server(statusCode: http.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw DashboardError.network("Malformed response body.") }
    }

    /// For mutations that return only `{ ok: true }`.
    func sendNoContent(path: String, method: String, jsonBody: Data?) async throws {
        let request = try await makeRequest(path: path, query: [], method: method, jsonBody: jsonBody)
        let response: URLResponse
        do { (_, response) = try await session.data(for: request) }
        catch { throw DashboardError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else {
            throw DashboardError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw DashboardError.server(statusCode: http.statusCode)
        }
    }

    /// GET that maps a 404 to nil (search availability probe).
    func sendAllowing404<T: Decodable>(path: String, query: [URLQueryItem], as type: T.Type) async throws -> T? {
        let request = try await makeRequest(path: path, query: query, method: "GET", jsonBody: nil)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw DashboardError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw DashboardError.network("No HTTP response.") }
        if http.statusCode == 404 { return nil }
        guard (200..<300).contains(http.statusCode) else { throw DashboardError.server(statusCode: http.statusCode) }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw DashboardError.network("Malformed response body.") }
    }
}

// MARK: - Upcoming events

public protocol UpcomingEventsProviding: AnyObject, Sendable {
    func upcoming() async throws -> [UpcomingCalendarEvent]
}

private struct UpcomingResponseBody: Decodable { let data: [UpcomingCalendarEvent] }

public final class HTTPUpcomingEventsClient: UpcomingEventsProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func upcoming() async throws -> [UpcomingCalendarEvent] {
        try await transport.send(path: "v1/calendar-events/upcoming", as: UpcomingResponseBody.self).data
    }
}

public final class FakeUpcomingEventsClient: UpcomingEventsProviding, @unchecked Sendable {
    public var result: [UpcomingCalendarEvent]
    public var nextError: DashboardError?
    public init(result: [UpcomingCalendarEvent] = [], nextError: DashboardError? = nil) {
        self.result = result; self.nextError = nextError
    }
    public func upcoming() async throws -> [UpcomingCalendarEvent] {
        if let nextError { throw nextError }
        return result
    }
}

// MARK: - Free/busy (day view)

public protocol FreeBusyProviding: AnyObject, Sendable {
    /// `from`/`to` are ISO-8601 instants bounding the queried range (this
    /// surface asks for today's local start..next-day start).
    func freeBusy(from: String, to: String) async throws -> FreeBusy
}

/// `{ ok: true, data: FreeBusy }`. Parsed into the discriminated union so a
/// caller physically cannot read `busy` on a degraded variant.
private struct FreeBusyResponseBody: Decodable { let data: FreeBusy }

public final class HTTPFreeBusyClient: FreeBusyProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func freeBusy(from: String, to: String) async throws -> FreeBusy {
        let query = [
            URLQueryItem(name: "from", value: from),
            URLQueryItem(name: "to", value: to),
        ]
        return try await transport.send(path: "v1/calendar/freebusy", query: query, as: FreeBusyResponseBody.self).data
    }
}

public final class FakeFreeBusyClient: FreeBusyProviding, @unchecked Sendable {
    public var result: FreeBusy
    public var nextError: DashboardError?
    public init(
        result: FreeBusy = .ok(range: FreeBusyRange(from: "", to: "", timeZone: TimeZone.current.identifier), busy: []),
        nextError: DashboardError? = nil
    ) {
        self.result = result; self.nextError = nextError
    }
    public func freeBusy(from: String, to: String) async throws -> FreeBusy {
        if let nextError { throw nextError }
        return result
    }
}

// MARK: - Connections

public protocol ConnectionsProviding: AnyObject, Sendable {
    func connections() async throws -> [Connection]
}

private struct ConnectionsResponseBody: Decodable { let connections: [Connection] }

public final class HTTPConnectionsClient: ConnectionsProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func connections() async throws -> [Connection] {
        try await transport.send(path: "v1/connections", as: ConnectionsResponseBody.self).connections
    }
}

public final class FakeConnectionsClient: ConnectionsProviding, @unchecked Sendable {
    public var result: [Connection]
    public var nextError: DashboardError?
    public init(result: [Connection] = [], nextError: DashboardError? = nil) {
        self.result = result; self.nextError = nextError
    }
    public func connections() async throws -> [Connection] {
        if let nextError { throw nextError }
        return result
    }
}

// MARK: - Devotionals (list + detail + search)

public struct DevotionalPage: Equatable, Sendable {
    public let devotionals: [DevotionalCard]
    public let nextCursor: String?
    public init(devotionals: [DevotionalCard], nextCursor: String?) {
        self.devotionals = devotionals; self.nextCursor = nextCursor
    }
}

public protocol DevotionalsProviding: AnyObject, Sendable {
    func list(cursor: String?) async throws -> DevotionalPage
    func detail(id: String) async throws -> DevotionalDetail
    /// Returns nil when search is unavailable (endpoint 404s).
    func search(query: String) async throws -> [DevotionalCard]?
}

private struct DevotionalListResponseBody: Decodable { let data: [DevotionalCard]; let nextCursor: String? }
private struct DevotionalDetailResponseBody: Decodable { let data: DevotionalDetail }

public final class HTTPDevotionalsClient: DevotionalsProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func list(cursor: String?) async throws -> DevotionalPage {
        var query = [URLQueryItem(name: "limit", value: "20")]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        let body = try await transport.send(path: "v1/devotionals", query: query, as: DevotionalListResponseBody.self)
        return DevotionalPage(devotionals: body.data, nextCursor: body.nextCursor)
    }
    public func detail(id: String) async throws -> DevotionalDetail {
        try await transport.send(path: "v1/devotionals/\(id)", as: DevotionalDetailResponseBody.self).data
    }
    public func search(query: String) async throws -> [DevotionalCard]? {
        let q = [URLQueryItem(name: "q", value: query)]
        let body = try await transport.sendAllowing404(path: "v1/devotionals/search", query: q, as: DevotionalListResponseBody.self)
        return body?.data
    }
}

public final class FakeDevotionalsClient: DevotionalsProviding, @unchecked Sendable {
    public var page: DevotionalPage
    public var detailByID: [String: DevotionalDetail]
    public var searchResult: [DevotionalCard]?
    public var nextError: DashboardError?
    public init(page: DevotionalPage = DevotionalPage(devotionals: [], nextCursor: nil),
                detailByID: [String: DevotionalDetail] = [:],
                searchResult: [DevotionalCard]? = [],
                nextError: DashboardError? = nil) {
        self.page = page; self.detailByID = detailByID; self.searchResult = searchResult; self.nextError = nextError
    }
    public func list(cursor: String?) async throws -> DevotionalPage {
        if let nextError { throw nextError }
        return page
    }
    public func detail(id: String) async throws -> DevotionalDetail {
        if let nextError { throw nextError }
        guard let d = detailByID[id] else { throw DashboardError.server(statusCode: 404) }
        return d
    }
    public func search(query: String) async throws -> [DevotionalCard]? {
        if let nextError { throw nextError }
        return searchResult
    }
}

// MARK: - Monthly recap

public protocol RecapProviding: AnyObject, Sendable {
    func recap(year: Int, month: Int) async throws -> MonthlyRecap
}

private struct RecapResponseBody: Decodable { let data: MonthlyRecap }

public final class HTTPRecapClient: RecapProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func recap(year: Int, month: Int) async throws -> MonthlyRecap {
        try await transport.send(path: "v1/recap/\(year)/\(month)", as: RecapResponseBody.self).data
    }
}

public final class FakeRecapClient: RecapProviding, @unchecked Sendable {
    public var result: MonthlyRecap?
    public var nextError: DashboardError?
    public init(result: MonthlyRecap? = nil, nextError: DashboardError? = nil) {
        self.result = result; self.nextError = nextError
    }
    public func recap(year: Int, month: Int) async throws -> MonthlyRecap {
        if let nextError { throw nextError }
        guard let result else { throw DashboardError.server(statusCode: 404) }
        return result
    }
}

// MARK: - Journal

public struct JournalPage: Equatable, Sendable {
    public let entries: [JournalEntry]
    public let nextCursor: String?
    public init(entries: [JournalEntry], nextCursor: String?) {
        self.entries = entries; self.nextCursor = nextCursor
    }
}

public protocol JournalProviding: AnyObject, Sendable {
    func list(before: String?) async throws -> JournalPage
    func create(text: String) async throws -> JournalEntry
    func delete(id: String) async throws
}

private struct JournalListResponseBody: Decodable { let data: [JournalEntry]; let nextCursor: String? }
private struct JournalCreateResponseBody: Decodable { let data: JournalEntry }

public final class HTTPJournalClient: JournalProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func list(before: String?) async throws -> JournalPage {
        var query: [URLQueryItem] = []
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        let body = try await transport.send(path: "v1/journal", query: query, as: JournalListResponseBody.self)
        return JournalPage(entries: body.data, nextCursor: body.nextCursor)
    }
    public func create(text: String) async throws -> JournalEntry {
        let payload = try JSONEncoder().encode(["text": text])
        return try await transport.send(path: "v1/journal", method: "POST", jsonBody: payload, as: JournalCreateResponseBody.self).data
    }
    public func delete(id: String) async throws {
        try await transport.sendNoContent(path: "v1/journal/\(id)", method: "DELETE", jsonBody: nil)
    }
}

public final class FakeJournalClient: JournalProviding, @unchecked Sendable {
    public var entries: [JournalEntry]
    public var nextError: DashboardError?
    private var counter = 0
    public init(entries: [JournalEntry] = [], nextError: DashboardError? = nil) {
        self.entries = entries; self.nextError = nextError
    }
    public func list(before: String?) async throws -> JournalPage {
        if let nextError { throw nextError }
        return JournalPage(entries: entries, nextCursor: nil)
    }
    public func create(text: String) async throws -> JournalEntry {
        if let nextError { throw nextError }
        counter += 1
        let entry = JournalEntry(id: "fake-\(counter)", text: text, createdAt: "2026-06-03T09:00:00.000Z")
        entries.insert(entry, at: 0)
        return entry
    }
    public func delete(id: String) async throws {
        if let nextError { throw nextError }
        entries.removeAll { $0.id == id }
    }
}

// MARK: - Liturgical season

public protocol LiturgyProviding: AnyObject, Sendable {
    func currentSeason() async throws -> LiturgicalSeason?
}

private struct LiturgyResponseBody: Decodable {
    struct Inner: Decodable { let season: LiturgicalSeason? }
    let data: Inner
}

public final class HTTPLiturgyClient: LiturgyProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func currentSeason() async throws -> LiturgicalSeason? {
        try await transport.send(path: "v1/liturgical-season", as: LiturgyResponseBody.self).data.season
    }
}

public final class FakeLiturgyClient: LiturgyProviding, @unchecked Sendable {
    public var result: LiturgicalSeason?
    public var nextError: DashboardError?
    public init(result: LiturgicalSeason? = nil, nextError: DashboardError? = nil) {
        self.result = result; self.nextError = nextError
    }
    public func currentSeason() async throws -> LiturgicalSeason? {
        if let nextError { throw nextError }
        return result
    }
}

// MARK: - Generate now ("+" on Today)

public protocol GenerateNowRequesting: AnyObject, Sendable {
    func generateNow() async throws -> GenerateNowOutcome
}

private struct GenerateNowResponseBody: Decodable {
    let sessionUrl: String
    let devotionalId: String
    let alreadyExisted: Bool
}

public final class HTTPGenerateNowClient: GenerateNowRequesting, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func generateNow() async throws -> GenerateNowOutcome {
        // `mode: 'now'` — a routine "make one now" tap, distinct from the
        // distress front door (which posts an empty body).
        let payload = try JSONEncoder().encode(["mode": "now"])
        let body = try await transport.send(path: "v1/devotional/generate-now", method: "POST", jsonBody: payload, as: GenerateNowResponseBody.self)
        guard let url = URL(string: body.sessionUrl) else { throw DashboardError.network("Malformed sessionUrl.") }
        return GenerateNowOutcome(sessionUrl: url, devotionalId: body.devotionalId, alreadyExisted: body.alreadyExisted)
    }
}

public final class FakeGenerateNowClient: GenerateNowRequesting, @unchecked Sendable {
    public var result: GenerateNowOutcome
    public var nextError: DashboardError?
    public private(set) var callCount = 0
    public init(result: GenerateNowOutcome = GenerateNowOutcome(sessionUrl: URL(string: "https://wellspring.test/session/fake")!, devotionalId: "fake-devo", alreadyExisted: false),
                nextError: DashboardError? = nil) {
        self.result = result; self.nextError = nextError
    }
    public func generateNow() async throws -> GenerateNowOutcome {
        callCount += 1
        if let nextError { throw nextError }
        return result
    }
}

// MARK: - Account info (invite address)

/// The invite address lives on `GET /v1/preferences` (`data.inviteAddress`),
/// which the existing preferences client decodes but drops. Rather than
/// reshape that plumbing, this fetches just the one field the Invite card
/// needs. Nil means the account has no invite address yet — the card hides,
/// never breaks (matching the web).
public protocol AccountInfoProviding: AnyObject, Sendable {
    func inviteAddress() async throws -> String?
}

private struct PreferencesInviteResponseBody: Decodable {
    struct Inner: Decodable { let inviteAddress: String? }
    let data: Inner
}

public final class HTTPAccountInfoClient: AccountInfoProviding, @unchecked Sendable {
    private let transport: DashboardTransport
    public init(baseURL: URL, session: URLSession = .shared, idTokenProvider: @escaping @Sendable () async throws -> String) {
        transport = DashboardTransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }
    public func inviteAddress() async throws -> String? {
        try await transport.send(path: "v1/preferences", as: PreferencesInviteResponseBody.self).data.inviteAddress
    }
}

public final class FakeAccountInfoClient: AccountInfoProviding, @unchecked Sendable {
    public var result: String?
    public var nextError: DashboardError?
    public init(result: String? = nil, nextError: DashboardError? = nil) {
        self.result = result; self.nextError = nextError
    }
    public func inviteAddress() async throws -> String? {
        if let nextError { throw nextError }
        return result
    }
}
