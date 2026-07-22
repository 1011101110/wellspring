import XCTest
@testable import Kairos

/// Tests for `HTTPGoogleConnectClient` (issue #124) — the HTTP mechanics
/// (method/URL/headers/status-code handling), mirroring
/// `HTTPPreferencesClientTests`'/`BandUploadClientTests`' `URLProtocol`-stub
/// pattern exactly.
final class GoogleConnectClientTests: XCTestCase {

    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(GoogleConnectStubbedURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(GoogleConnectStubbedURLProtocol.self)
        GoogleConnectStubbedURLProtocol.stubbedResponse = nil
        GoogleConnectStubbedURLProtocol.capturedRequest = nil
        super.tearDown()
    }

    func test_fetchAuthorizationURL_getsFromV1ConnectGoogleEndpoint() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.sampleAuthURLResponseJSON
        )
        let sut = makeSUT(idToken: "tok")
        _ = try await sut.fetchAuthorizationURL()

        let captured = try XCTUnwrap(GoogleConnectStubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "GET")
        XCTAssertTrue(captured.url?.path.hasSuffix("/v1/connect/google") == true)
    }

    func test_fetchAuthorizationURL_sendsAcceptJSONHeader() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.sampleAuthURLResponseJSON
        )
        let sut = makeSUT(idToken: "tok")
        _ = try await sut.fetchAuthorizationURL()

        let captured = try XCTUnwrap(GoogleConnectStubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func test_fetchAuthorizationURL_sendsAuthorizationBearerHeader() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.sampleAuthURLResponseJSON
        )
        let sut = makeSUT(idToken: "my-firebase-id-token")
        _ = try await sut.fetchAuthorizationURL()

        let captured = try XCTUnwrap(GoogleConnectStubbedURLProtocol.capturedRequest)
        XCTAssertEqual(
            captured.value(forHTTPHeaderField: "Authorization"),
            "Bearer my-firebase-id-token"
        )
    }

    func test_fetchAuthorizationURL_decodesAuthUrlFromResponse() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.sampleAuthURLResponseJSON
        )
        let sut = makeSUT(idToken: "tok")
        let url = try await sut.fetchAuthorizationURL()

        XCTAssertEqual(url.absoluteString, "https://accounts.google.com/o/oauth2/v2/auth?mock=1")
    }

    func test_fetchAuthorizationURL_tokenProviderThrows_throwsNotAuthenticated() async {
        let sut = makeFailingTokenSUT()

        do {
            _ = try await sut.fetchAuthorizationURL()
            XCTFail("Expected GoogleConnectClientError.notAuthenticated to be thrown")
        } catch let error as GoogleConnectClientError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_fetchAuthorizationURL_serverReturns500_throwsServerError() async {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 500,
            body: Data()
        )
        let sut = makeSUT(idToken: "tok")

        do {
            _ = try await sut.fetchAuthorizationURL()
            XCTFail("Expected GoogleConnectClientError.server to be thrown")
        } catch let error as GoogleConnectClientError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_fetchAuthorizationURL_malformedBody_throwsMalformedResponse() async {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Data(#"{"ok":true}"#.utf8) // missing authUrl
        )
        let sut = makeSUT(idToken: "tok")

        do {
            _ = try await sut.fetchAuthorizationURL()
            XCTFail("Expected GoogleConnectClientError.malformedResponse to be thrown")
        } catch let error as GoogleConnectClientError {
            XCTAssertEqual(error, .malformedResponse)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - disconnect (issue #213)

    /// The load-bearing assertion of #213. The defect was that no client
    /// anywhere issued this request — the route existed and worked, and
    /// "Disconnect calendar" simply never called it. Asserting the verb and
    /// the path is asserting that the revoke leaves the device at all.
    func test_disconnect_sendsDELETEToV1ConnectGoogleEndpoint() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.sampleDisconnectResponseJSON
        )
        let sut = makeSUT(idToken: "tok")
        try await sut.disconnect()

        let captured = try XCTUnwrap(GoogleConnectStubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "DELETE")
        XCTAssertTrue(captured.url?.path.hasSuffix("/v1/connect/google") == true)
    }

    /// `DELETE /v1/connect/google` is behind `requireAuth`; an unauthenticated
    /// request would 401 and revoke nothing.
    func test_disconnect_sendsAuthorizationBearerHeader() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Self.sampleDisconnectResponseJSON
        )
        let sut = makeSUT(idToken: "my-firebase-id-token")
        try await sut.disconnect()

        let captured = try XCTUnwrap(GoogleConnectStubbedURLProtocol.capturedRequest)
        XCTAssertEqual(
            captured.value(forHTTPHeaderField: "Authorization"),
            "Bearer my-firebase-id-token"
        )
    }

    func test_disconnect_serverReturns500_throwsServerError() async {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 500,
            body: Data()
        )
        let sut = makeSUT(idToken: "tok")

        do {
            try await sut.disconnect()
            XCTFail("Expected GoogleConnectClientError.server to be thrown")
        } catch let error as GoogleConnectClientError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    /// A 401 must throw rather than resolve — otherwise the view model
    /// would report a successful revoke for a request the server rejected.
    func test_disconnect_serverReturns401_throwsServerError() async {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 401,
            body: Data()
        )
        let sut = makeSUT(idToken: "tok")

        do {
            try await sut.disconnect()
            XCTFail("Expected GoogleConnectClientError.server to be thrown")
        } catch let error as GoogleConnectClientError {
            XCTAssertEqual(error, .server(statusCode: 401))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_disconnect_tokenProviderThrows_throwsNotAuthenticated_andSendsNoRequest() async {
        let sut = makeFailingTokenSUT()

        do {
            try await sut.disconnect()
            XCTFail("Expected GoogleConnectClientError.notAuthenticated to be thrown")
        } catch let error as GoogleConnectClientError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
        XCTAssertNil(
            GoogleConnectStubbedURLProtocol.capturedRequest,
            "A revoke with no bearer token must not be attempted at all"
        )
    }

    /// Documents the deliberate decision not to decode the response body:
    /// a 2xx is the entire success signal, so an unexpected body shape must
    /// not turn a revoke the server genuinely performed into a client-side
    /// failure the user is told to retry.
    func test_disconnect_ignoresResponseBodyShape_onSuccess() async throws {
        GoogleConnectStubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Data("not json at all".utf8)
        )
        let sut = makeSUT(idToken: "tok")

        try await sut.disconnect()
    }

    // MARK: - Helpers

    private func makeSUT(idToken: String) -> HTTPGoogleConnectClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GoogleConnectStubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPGoogleConnectClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { idToken }
        )
    }

    private func makeFailingTokenSUT() -> HTTPGoogleConnectClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GoogleConnectStubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPGoogleConnectClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { throw URLError(.userAuthenticationRequired) }
        )
    }

    private static let sampleAuthURLResponseJSON = Data(
        """
        {
          "ok": true,
          "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?mock=1"
        }
        """.utf8
    )

    /// Exactly what `DELETE /v1/connect/google` replies with
    /// (`apps/api/src/routes/connect.ts`: `reply.send({ ok: true })`).
    private static let sampleDisconnectResponseJSON = Data(#"{"ok":true}"#.utf8)
}

// MARK: - URLProtocol stub

private final class GoogleConnectStubbedURLProtocol: URLProtocol {
    enum StubbedResponseType {
        case successWithBody(statusCode: Int, body: Data)
    }

    static var stubbedResponse: StubbedResponseType?
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        GoogleConnectStubbedURLProtocol.capturedRequest = request

        guard let responseType = GoogleConnectStubbedURLProtocol.stubbedResponse else {
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
