import XCTest
@testable import Kairos

/// Wire-decoding tests for the dashboard HTTP clients (issue #252): the
/// hand-written `Decodable` structs must match the shared-contract shapes,
/// including the envelope keys (`connections`, `data`) and the snake_case
/// devotional-detail row. Uses a URLProtocol stub, like the other client tests.
final class DashboardClientsTests: XCTestCase {

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DashboardStubURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func stub(_ json: String, status: Int = 200) {
        DashboardStubURLProtocol.statusCode = status
        DashboardStubURLProtocol.responseData = Data(json.utf8)
        DashboardStubURLProtocol.lastRequest = nil
    }

    private let base = URL(string: "https://api.test")!
    private func token() -> @Sendable () async throws -> String { { "tok-123" } }

    func test_upcoming_decodesEnvelopeAndDevotional() async throws {
        stub(#"{"ok":true,"data":[{"id":"e1","gapStartAt":"2026-07-23T13:00:00Z","gapEndAt":"2026-07-23T14:00:00Z","meetUri":"https://meet","rescheduleCount":2,"devotional":{"id":"d1","theme":"Rest","cardSummary":"pause"}}]}"#)
        let client = HTTPUpcomingEventsClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let events = try await client.upcoming()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].devotional?.theme, "Rest")
        XCTAssertEqual(events[0].rescheduleCount, 2)
        // Auth header is attached.
        XCTAssertEqual(DashboardStubURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer tok-123")
    }

    func test_connections_usesConnectionsEnvelopeKey() async throws {
        stub(#"{"ok":true,"connections":[{"provider":"google_calendar","status":"active","connectedAt":"2026-06-01T00:00:00Z","scopes":["freebusy"]}]}"#)
        let client = HTTPConnectionsClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let conns = try await client.connections()
        XCTAssertEqual(conns.first?.status, "active")
        XCTAssertEqual(ConnectionState.derive(from: conns).canSchedule, true)
    }

    func test_devotionalDetail_decodesSnakeCase() async throws {
        stub(#"{"ok":true,"data":{"id":"d1","date":"2026-07-21","format":"text","theme":"Rest","verses":[{"usfm":"MAT.11.28","reference":"Matthew 11:28","fetchedText":"Come to me","attribution":"NIV"}],"devotional_body":"body","card_summary":"summary","prayer":"pray","journaling_prompt":"prompt","action_step":null,"audio_object":null,"created_at":"2026-07-21T08:00:00Z"}}"#)
        let client = HTTPDevotionalsClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let detail = try await client.detail(id: "d1")
        XCTAssertEqual(detail.devotionalBody, "body")
        XCTAssertEqual(detail.cardSummary, "summary")
        XCTAssertEqual(detail.journalingPrompt, "prompt")
        XCTAssertNil(detail.actionStep)
        XCTAssertEqual(detail.primaryVerse?.attribution, "NIV")
    }

    func test_devotionalList_carriesNextCursor() async throws {
        stub(#"{"ok":true,"data":[{"id":"d1","date":"2026-07-21","theme":"Rest","cardSummary":"s","format":"text","createdAt":"2026-07-21T08:00:00Z","completedAt":null}],"nextCursor":"CUR"}"#)
        let client = HTTPDevotionalsClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let page = try await client.list(cursor: nil)
        XCTAssertEqual(page.devotionals.count, 1)
        XCTAssertEqual(page.nextCursor, "CUR")
    }

    func test_liturgy_decodesNullSeason() async throws {
        stub(#"{"ok":true,"data":{"season":null}}"#)
        let client = HTTPLiturgyClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let season = try await client.currentSeason()
        XCTAssertNil(season)
    }

    func test_liturgy_decodesOrdinaryTimeRawValue() async throws {
        stub(#"{"ok":true,"data":{"season":"ordinary_time"}}"#)
        let client = HTTPLiturgyClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let season = try await client.currentSeason()
        XCTAssertEqual(season, .ordinaryTime)
    }

    func test_generateNow_postsModeNow_andReturnsOutcome() async throws {
        stub(#"{"ok":true,"sessionUrl":"https://wellspring.test/s/1","devotionalId":"d1","alreadyExisted":true,"data":{"sessionToken":"t","source":null,"audio":null,"devotional":null}}"#)
        let client = HTTPGenerateNowClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let outcome = try await client.generateNow()
        XCTAssertEqual(outcome.devotionalId, "d1")
        XCTAssertTrue(outcome.alreadyExisted)
        let body = DashboardStubURLProtocol.lastBody ?? Data()
        XCTAssertTrue(String(data: body, encoding: .utf8)?.contains("\"now\"") ?? false, "generate-now must post mode:now")
    }

    func test_search_returnsNilOn404() async throws {
        stub("{}", status: 404)
        let client = HTTPDevotionalsClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        let results = try await client.search(query: "q")
        XCTAssertNil(results, "A 404 from search means unavailable, surfaced as nil")
    }

    func test_serverError_throwsServer() async throws {
        stub("{}", status: 500)
        let client = HTTPUpcomingEventsClient(baseURL: base, session: makeSession(), idTokenProvider: token())
        do { _ = try await client.upcoming(); XCTFail("should throw") }
        catch let error as DashboardError {
            XCTAssertEqual(error, .server(statusCode: 500))
        }
    }
}

/// URLProtocol stub for the dashboard client tests — captures the outgoing
/// request and returns a canned response.
final class DashboardStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responseData = Data()
    nonisolated(unsafe) static var statusCode = 200
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        // URLProtocol moves httpBody into httpBodyStream; read whichever holds it.
        if let body = request.httpBody {
            Self.lastBody = body
        } else if let stream = request.httpBodyStream {
            Self.lastBody = Self.read(stream)
        } else {
            Self.lastBody = nil
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
