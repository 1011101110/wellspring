import XCTest
@testable import Kairos

/// Contract test for `HTTPAccountDeletionClient` (the HTTP client for
/// `DELETE /v1/account`) — issue #83's iOS half of the contract-test layer
/// between iOS and backend (root cause of issue #72: iOS and backend each
/// validated their own side of the API against nothing shared).
///
/// Uses a `URLProtocol` stub to intercept real `URLSession` calls and
/// inspect the raw request without making any live network calls, mirroring
/// `SlotsUploadClientTests`'s pattern exactly.
///
/// The JSON embedded below is a literal, by-hand copy of
/// `packages/shared-contracts/fixtures/api/account.delete.json` — the
/// canonical fixture the backend validates against Zod schemas. Keep the
/// two in sync by hand if that file changes:
///
/// ```json
/// { "response": { "ok": true } }
/// ```
@MainActor
final class AccountDeletionClientTests: XCTestCase {

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

    // MARK: - HTTP method and URL

    func test_deleteAccount_deletesToV1AccountEndpoint() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "tok")
        try await sut.deleteAccount()

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "DELETE")
        XCTAssertTrue(
            captured.url?.path.hasSuffix("/v1/account") == true,
            "URL must end with /v1/account, got \(captured.url?.absoluteString ?? "<nil>")"
        )
    }

    // MARK: - No request body

    /// The verified bearer token *is* the account identifier (userId from
    /// the verified token, never from the request body,
    /// 04_DATA_PRIVACY_SECURITY §5.1) — `DELETE /v1/account` takes no
    /// payload.
    func test_deleteAccount_sendsNoRequestBody() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "tok")
        try await sut.deleteAccount()

        XCTAssertTrue(
            StubbedURLProtocol.capturedBody == nil || StubbedURLProtocol.capturedBody?.isEmpty == true,
            "DELETE /v1/account must not send a request body"
        )
    }

    // MARK: - Authorization header

    func test_deleteAccount_sendsAuthorizationBearerHeader() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "my-firebase-id-token")
        try await sut.deleteAccount()

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(
            captured.value(forHTTPHeaderField: "Authorization"),
            "Bearer my-firebase-id-token"
        )
    }

    // MARK: - Fixture: `response` (locks the shape the client would parse)

    /// The client only checks the HTTP status today and does not parse the
    /// response body — this test locks the fixture's exact `response` JSON
    /// shape (`{"ok":true}`) so that if/when the client starts parsing
    /// responses, this test documents the contract it must decode against.
    func test_deleteAccount_stubbedFixtureResponse_completesWithoutThrowing() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Data(#"{"ok":true}"#.utf8)
        )
        let sut = makeSUT(idToken: "tok")
        try await sut.deleteAccount()
    }

    // MARK: - Error handling

    func test_deleteAccount_tokenProviderThrows_throwsNotAuthenticated() async {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeFailingTokenSUT()

        do {
            try await sut.deleteAccount()
            XCTFail("Expected AccountDeletionError.notAuthenticated to be thrown")
        } catch let error as AccountDeletionError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_deleteAccount_serverReturns500_throwsServerError() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 500)
        let sut = makeSUT(idToken: "tok")

        do {
            try await sut.deleteAccount()
            XCTFail("Expected AccountDeletionError.server to be thrown")
        } catch let error as AccountDeletionError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Helpers

    private func makeSUT(idToken: String) -> HTTPAccountDeletionClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPAccountDeletionClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { idToken }
        )
    }

    private func makeFailingTokenSUT() -> HTTPAccountDeletionClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPAccountDeletionClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { throw URLError(.userAuthenticationRequired) }
        )
    }
}

// MARK: - URLProtocol stub

private final class StubbedURLProtocol: URLProtocol {
    enum StubbedResponseType {
        case success(statusCode: Int)
        case successWithBody(statusCode: Int, body: Data)
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
            let body = Data(#"{"ok":true}"#.utf8)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
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
