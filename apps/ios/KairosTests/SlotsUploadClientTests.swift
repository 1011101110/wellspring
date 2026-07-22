import XCTest
@testable import Kairos

/// Tests for `SlotsUploadClient` (the HTTP client for `POST /v1/slots`).
///
/// Uses a `URLProtocol` stub to intercept real `URLSession` calls and
/// inspect the raw request body without making any live network calls.
///
/// Acceptance criteria for issue #27:
///   1. POST body contains `date` and `slots`.
///   2. Each slot contains only `startIso` and `endIso` — no title,
///      attendee, location, or any other privacy-sensitive field.
///   3. `Authorization: Bearer <token>` header is present.
///   4. `notAuthenticated` error is thrown if the token provider throws.
///   5. `server(statusCode:)` error is thrown on a non-2xx response.
@MainActor
final class SlotsUploadClientTests: XCTestCase {

    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(StubbedURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(StubbedURLProtocol.self)
        StubbedURLProtocol.stubbedResponse = nil
        StubbedURLProtocol.capturedRequest = nil
        StubbedURLProtocol.capturedBody = nil
        super.tearDown()
    }

    // MARK: - Privacy / payload shape (issue #27 acceptance criteria)

    /// The JSON body sent to the server must contain `date` and `slots`.
    /// Each slot must contain ONLY `startIso` and `endIso` — never any
    /// event titles, attendees, locations, or other calendar content.
    func test_uploadSlots_payloadContainsOnlyDateAndSlots_noTitleOrAttendeeFields() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)

        let sut = makeSUT(idToken: "test-token")
        let windows = [
            FreeWindow(startIso: "2026-07-04T09:00:00-05:00", endIso: "2026-07-04T09:30:00-05:00"),
            FreeWindow(startIso: "2026-07-04T10:00:00-05:00", endIso: "2026-07-04T10:45:00-05:00"),
        ]

        try await sut.uploadSlots(date: "2026-07-04", freeWindows: windows)

        let body = try XCTUnwrap(StubbedURLProtocol.capturedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])

        // Top-level keys must be exactly `date` and `slots`.
        XCTAssertEqual(json["date"] as? String, "2026-07-04")
        let slots = try XCTUnwrap(json["slots"] as? [[String: Any]])
        XCTAssertEqual(slots.count, 2)

        // Each slot must contain ONLY the two permitted keys.
        for (index, slot) in slots.enumerated() {
            XCTAssertNotNil(slot["startIso"], "Slot \(index) must have startIso")
            XCTAssertNotNil(slot["endIso"],   "Slot \(index) must have endIso")

            // Privacy assertions — none of these must be present.
            XCTAssertNil(slot["title"],       "Slot \(index) must never carry event title")
            XCTAssertNil(slot["attendees"],   "Slot \(index) must never carry attendees")
            XCTAssertNil(slot["location"],    "Slot \(index) must never carry location")
            XCTAssertNil(slot["notes"],       "Slot \(index) must never carry notes")
            XCTAssertNil(slot["description"], "Slot \(index) must never carry description")

            XCTAssertEqual(slot.count, 2, "Slot \(index) must have exactly 2 keys")
        }

        // The top-level object must also have exactly 2 keys.
        XCTAssertEqual(json.count, 2, "Top-level body must have exactly 2 keys: date and slots")
    }

    /// Correct `startIso`/`endIso` values are round-tripped to the server.
    func test_uploadSlots_slotValuesMatchInput() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)

        let sut = makeSUT(idToken: "test-token")
        let windows = [
            FreeWindow(startIso: "2026-07-04T09:00:00-05:00", endIso: "2026-07-04T09:30:00-05:00"),
        ]

        try await sut.uploadSlots(date: "2026-07-04", freeWindows: windows)

        let body   = try XCTUnwrap(StubbedURLProtocol.capturedBody)
        let json   = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let slots  = try XCTUnwrap(json["slots"] as? [[String: String]])
        let slot   = try XCTUnwrap(slots.first)

        XCTAssertEqual(slot["startIso"], "2026-07-04T09:00:00-05:00")
        XCTAssertEqual(slot["endIso"],   "2026-07-04T09:30:00-05:00")
    }

    // MARK: - Authorization header

    func test_uploadSlots_sendsAuthorizationBearerHeader() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "my-firebase-id-token")
        try await sut.uploadSlots(date: "2026-07-04", freeWindows: [])

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(
            captured.value(forHTTPHeaderField: "Authorization"),
            "Bearer my-firebase-id-token"
        )
    }

    // MARK: - HTTP method and URL

    func test_uploadSlots_postsToV1SlotsEndpoint() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "tok")
        try await sut.uploadSlots(date: "2026-07-04", freeWindows: [])

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertTrue(
            captured.url?.path.hasSuffix("/v1/slots") == true,
            "URL must end with /v1/slots, got \(captured.url?.absoluteString ?? "<nil>")"
        )
    }

    // MARK: - Error handling

    func test_uploadSlots_tokenProviderThrows_throwsNotAuthenticated() async {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeFailingTokenSUT()

        do {
            try await sut.uploadSlots(date: "2026-07-04", freeWindows: [])
            XCTFail("Expected SlotsUploadError.notAuthenticated to be thrown")
        } catch let error as SlotsUploadError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_uploadSlots_serverReturns500_throwsServerError() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 500)
        let sut = makeSUT(idToken: "tok")

        do {
            try await sut.uploadSlots(date: "2026-07-04", freeWindows: [])
            XCTFail("Expected SlotsUploadError.server to be thrown")
        } catch let error as SlotsUploadError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_uploadSlots_emptyFreeWindows_stillPostsValidBody() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "tok")
        try await sut.uploadSlots(date: "2026-07-04", freeWindows: [])

        let body = try XCTUnwrap(StubbedURLProtocol.capturedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["date"] as? String, "2026-07-04")
        let slots = json["slots"] as? [[String: Any]]
        XCTAssertEqual(slots?.count, 0, "Empty slots array must still be present in the body")
    }

    // MARK: - FakeSlotsUploadClient

    func test_fakeSlotsUploadClient_recordsUploadedCalls() async throws {
        let fake = FakeSlotsUploadClient()
        let windows = [FreeWindow(startIso: "2026-07-04T09:00:00Z", endIso: "2026-07-04T09:30:00Z")]
        try await fake.uploadSlots(date: "2026-07-04", freeWindows: windows)

        XCTAssertEqual(fake.uploadedCalls.count, 1)
        XCTAssertEqual(fake.uploadedCalls[0].date, "2026-07-04")
        XCTAssertEqual(fake.uploadedCalls[0].windows, windows)
    }

    func test_fakeSlotsUploadClient_nextErrorSet_throwsThatError() async {
        let fake = FakeSlotsUploadClient(nextError: .server(statusCode: 503))
        do {
            try await fake.uploadSlots(date: "2026-07-04", freeWindows: [])
            XCTFail("Expected error to be thrown")
        } catch let error as SlotsUploadError {
            XCTAssertEqual(error, .server(statusCode: 503))
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }

    // MARK: - Helpers

    private func makeSUT(idToken: String) -> SlotsUploadClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return SlotsUploadClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            getIdToken: { idToken }
        )
    }

    private func makeFailingTokenSUT() -> SlotsUploadClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return SlotsUploadClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            getIdToken: { throw URLError(.userAuthenticationRequired) }
        )
    }
}

// MARK: - URLProtocol stub

private final class StubbedURLProtocol: URLProtocol {
    enum StubbedResponseType {
        case success(statusCode: Int)
    }

    static var stubbedResponse: StubbedResponseType?
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Capture the request and body for assertions.
        StubbedURLProtocol.capturedRequest = request
        // URLSession moves the httpBody into the httpBodyStream once set;
        // read it back from the stream if needed.
        if let body = request.httpBody {
            StubbedURLProtocol.capturedBody = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(buffer, maxLength: 4096)
                if n > 0 { data.append(buffer, count: n) }
            }
            buffer.deallocate()
            stream.close()
            StubbedURLProtocol.capturedBody = data
        }

        guard let responseType = StubbedURLProtocol.stubbedResponse else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        switch responseType {
        case .success(let statusCode):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            // Return minimal valid JSON body.
            let body = Data(#"{"ok":true,"data":{"date":"2026-07-04","count":0}}"#.utf8)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
