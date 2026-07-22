import XCTest
@testable import Kairos

/// Tests for `HTTPDistressCheckinClient` (the "I could use a moment now"
/// front door, issue #77 / docs/14_IMPROVEMENT_REVIEW.md §5.8) — HTTP
/// mechanics (method/URL/headers/body/response decoding/error mapping),
/// mirroring `SlotsUploadClientTests`'/`HTTPPreferencesClientTests`'
/// `URLProtocol`-stub pattern.
@MainActor
final class DistressCheckinClientTests: XCTestCase {

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

    // MARK: - HTTP method, URL, headers

    func test_checkInNow_postsToGenerateNowEndpoint() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 200, body: Self.sampleSuccessJSON)
        let sut = makeSUT(idToken: "tok")
        _ = try await sut.checkInNow()

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertTrue(
            captured.url?.path.hasSuffix("/v1/devotional/generate-now") == true,
            "URL must end with /v1/devotional/generate-now, got \(captured.url?.absoluteString ?? "<nil>")"
        )
    }

    func test_checkInNow_sendsAuthorizationBearerHeader() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 200, body: Self.sampleSuccessJSON)
        let sut = makeSUT(idToken: "my-firebase-id-token")
        _ = try await sut.checkInNow()

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Authorization"), "Bearer my-firebase-id-token")
    }

    /// This route always means "I need comfort now" — the body carries no
    /// configuration at all (the backend forces every override itself).
    func test_checkInNow_sendsEmptyJSONBody() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 200, body: Self.sampleSuccessJSON)
        let sut = makeSUT(idToken: "tok")
        _ = try await sut.checkInNow()

        let body = try XCTUnwrap(StubbedURLProtocol.capturedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json.count, 0)
    }

    // MARK: - Response decoding

    func test_checkInNow_decodesSessionUrlFromResponse() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 200, body: Self.sampleSuccessJSON)
        let sut = makeSUT(idToken: "tok")

        let result = try await sut.checkInNow()
        XCTAssertEqual(result.sessionUrl, URL(string: "https://kairos-api.test/session/tok-distress")!)
    }

    // MARK: - Error handling

    func test_checkInNow_tokenProviderThrows_throwsNotAuthenticated() async {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 200, body: Self.sampleSuccessJSON)
        let sut = makeFailingTokenSUT()

        do {
            _ = try await sut.checkInNow()
            XCTFail("Expected DistressCheckinError.notAuthenticated to be thrown")
        } catch let error as DistressCheckinError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_checkInNow_serverReturns500_throwsServerError() async {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 500, body: Data())
        let sut = makeSUT(idToken: "tok")

        do {
            _ = try await sut.checkInNow()
            XCTFail("Expected DistressCheckinError.server to be thrown")
        } catch let error as DistressCheckinError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_checkInNow_malformedResponseBody_throwsNetworkError() async {
        StubbedURLProtocol.stubbedResponse = .successWithBody(statusCode: 200, body: Data("not json".utf8))
        let sut = makeSUT(idToken: "tok")

        do {
            _ = try await sut.checkInNow()
            XCTFail("Expected DistressCheckinError.network to be thrown")
        } catch let error as DistressCheckinError {
            guard case .network = error else {
                XCTFail("Expected .network, got \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - FakeDistressCheckinClient

    func test_fakeDistressCheckinClient_recordsCallCount() async throws {
        let fake = FakeDistressCheckinClient()
        _ = try await fake.checkInNow()
        _ = try await fake.checkInNow()

        XCTAssertEqual(fake.checkInCallCount, 2)
    }

    func test_fakeDistressCheckinClient_nextErrorSet_throwsThatError() async {
        let fake = FakeDistressCheckinClient(nextError: .server(statusCode: 503))
        do {
            _ = try await fake.checkInNow()
            XCTFail("Expected error to be thrown")
        } catch let error as DistressCheckinError {
            XCTAssertEqual(error, .server(statusCode: 503))
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }

    // MARK: - Helpers

    private static let sampleSuccessJSON = Data(
        #"{"ok":true,"sessionUrl":"https://kairos-api.test/session/tok-distress","devotionalId":"devo-1"}"#.utf8
    )

    private func makeSUT(idToken: String) -> HTTPDistressCheckinClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPDistressCheckinClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { idToken }
        )
    }

    private func makeFailingTokenSUT() -> HTTPDistressCheckinClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPDistressCheckinClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { throw URLError(.userAuthenticationRequired) }
        )
    }
}

// MARK: - URLProtocol stub

private final class StubbedURLProtocol: URLProtocol {
    enum StubbedResponseType {
        case successWithBody(statusCode: Int, body: Data)
    }

    static var stubbedResponse: StubbedResponseType?
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        StubbedURLProtocol.capturedRequest = request
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
        case .successWithBody(let statusCode, let body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
