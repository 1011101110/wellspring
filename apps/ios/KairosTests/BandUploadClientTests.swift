import XCTest
import BandDeriver
@testable import Kairos

/// Contract test for `HTTPBandUploadClient` (the HTTP client for `POST
/// /v1/bands`) — issue #83's iOS half of the contract-test layer between
/// iOS and backend (root cause of issue #72: iOS and backend each validated
/// their own side of the API against nothing shared).
///
/// Uses a `URLProtocol` stub to intercept real `URLSession` calls and
/// inspect the raw request body without making any live network calls,
/// mirroring `SlotsUploadClientTests`'s pattern exactly.
///
/// The JSON embedded below is a literal, by-hand copy of
/// `packages/shared-contracts/fixtures/api/bands.upload.json` — the
/// canonical fixture the backend validates against Zod schemas. Keep the
/// two in sync by hand if that file changes:
///
/// ```json
/// {
///   "request": { "date": "2026-07-04", "recovery": "low", "sleepQuality": "poor", "activity": "sedentary", "distressSignal": false },
///   "requestWithWithheldCategories": { "date": "2026-07-04", "distressSignal": false },
///   "response": { "ok": true, "data": { "date": "2026-07-04", "recovery": "low", "sleepQuality": "poor", "activity": "sedentary", "busyness": null, "communicationLoad": null, "distressSignal": false } }
/// }
/// ```
@MainActor
final class BandUploadClientTests: XCTestCase {

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

    // MARK: - Fixture: `request` (all three on-device bands present)

    /// Uploading a request built from the fixture's `request` object must
    /// produce a POST body whose JSON keys/values exactly match it.
    /// `busyness`/`communicationLoad` are left `nil` here (not part of the
    /// fixture's `request` object) and must be OMITTED from the encoded
    /// JSON entirely — `JSONEncoder`'s default behavior for `Encodable`
    /// optionals set to `nil` — never encoded as an explicit `null`.
    func test_upload_allBandsPresent_payloadMatchesFixtureRequest() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)

        let sut = makeSUT(idToken: "test-token")
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        let request = BandUploadRequest(date: "2026-07-04", bands: bands, distressSignal: false)

        try await sut.upload(request)

        let body = try XCTUnwrap(StubbedURLProtocol.capturedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])

        XCTAssertEqual(json["date"] as? String, "2026-07-04")
        XCTAssertEqual(json["recovery"] as? String, "low")
        XCTAssertEqual(json["sleepQuality"] as? String, "poor")
        XCTAssertEqual(json["activity"] as? String, "sedentary")
        XCTAssertEqual(json["distressSignal"] as? Bool, false)

        XCTAssertNil(json["busyness"], "busyness must be omitted, not derivable on-device")
        XCTAssertNil(json["communicationLoad"], "communicationLoad is an unshipped stretch signal")
    }

    // MARK: - Fixture: `requestWithWithheldCategories` (withheld-consent path)

    /// Issue #70: a category the user withheld consent for (or HealthKit had
    /// no evidence for) must be omitted from the wire payload entirely,
    /// never forced to carry a fabricated value. Building a `BandUploadRequest`
    /// from a `DerivedBands` with all three categories `nil` must produce a
    /// body matching the fixture's `requestWithWithheldCategories` object —
    /// only `date` and `distressSignal` present.
    func test_upload_allBandsWithheld_payloadMatchesFixtureWithheldRequest() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)

        let sut = makeSUT(idToken: "test-token")
        let derivedBands = DerivedBands(recovery: nil, sleepQuality: nil, activity: nil)
        let request = BandUploadRequest(date: "2026-07-04", derivedBands: derivedBands, distressSignal: false)

        try await sut.upload(request)

        let body = try XCTUnwrap(StubbedURLProtocol.capturedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])

        XCTAssertEqual(json["date"] as? String, "2026-07-04")
        XCTAssertEqual(json["distressSignal"] as? Bool, false)

        XCTAssertNil(json["recovery"])
        XCTAssertNil(json["sleepQuality"])
        XCTAssertNil(json["activity"])
        XCTAssertNil(json["busyness"])
        XCTAssertNil(json["communicationLoad"])

        XCTAssertEqual(json.count, 2, "Only date and distressSignal must be present when all bands are withheld")
    }

    // MARK: - Fixture: `response` (locks the shape the client would parse)

    /// The client only checks the HTTP status today and does not parse the
    /// response body — this test locks the fixture's exact `response` JSON
    /// shape so that if/when the client starts parsing responses, this test
    /// documents the contract it must decode against.
    func test_upload_stubbedFixtureResponse_completesWithoutThrowing() async throws {
        StubbedURLProtocol.stubbedResponse = .successWithBody(
            statusCode: 200,
            body: Data(#"""
            {"ok":true,"data":{"date":"2026-07-04","recovery":"low","sleepQuality":"poor","activity":"sedentary","busyness":null,"communicationLoad":null,"distressSignal":false}}
            """#.utf8)
        )

        let sut = makeSUT(idToken: "test-token")
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        let request = BandUploadRequest(date: "2026-07-04", bands: bands, distressSignal: false)

        try await sut.upload(request)
    }

    // MARK: - Authorization header

    func test_upload_sendsAuthorizationBearerHeader() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "my-firebase-id-token")
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        try await sut.upload(BandUploadRequest(date: "2026-07-04", bands: bands))

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(
            captured.value(forHTTPHeaderField: "Authorization"),
            "Bearer my-firebase-id-token"
        )
    }

    // MARK: - HTTP method and URL

    func test_upload_postsToV1BandsEndpoint() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeSUT(idToken: "tok")
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        try await sut.upload(BandUploadRequest(date: "2026-07-04", bands: bands))

        let captured = try XCTUnwrap(StubbedURLProtocol.capturedRequest)
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertTrue(
            captured.url?.path.hasSuffix("/v1/bands") == true,
            "URL must end with /v1/bands, got \(captured.url?.absoluteString ?? "<nil>")"
        )
    }

    // MARK: - Error handling

    func test_upload_tokenProviderThrows_throwsNotAuthenticated() async {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 200)
        let sut = makeFailingTokenSUT()
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)

        do {
            try await sut.upload(BandUploadRequest(date: "2026-07-04", bands: bands))
            XCTFail("Expected BandUploadError.notAuthenticated to be thrown")
        } catch let error as BandUploadError {
            XCTAssertEqual(error, .notAuthenticated)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test_upload_serverReturns500_throwsServerError() async throws {
        StubbedURLProtocol.stubbedResponse = .success(statusCode: 500)
        let sut = makeSUT(idToken: "tok")
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)

        do {
            try await sut.upload(BandUploadRequest(date: "2026-07-04", bands: bands))
            XCTFail("Expected BandUploadError.server to be thrown")
        } catch let error as BandUploadError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Helpers

    private func makeSUT(idToken: String) -> HTTPBandUploadClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPBandUploadClient(
            baseURL: URL(string: "https://kairos-api.test")!,
            session: session,
            idTokenProvider: { idToken }
        )
    }

    private func makeFailingTokenSUT() -> HTTPBandUploadClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubbedURLProtocol.self]
        let session = URLSession(configuration: config)
        return HTTPBandUploadClient(
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
            let body = Data(#"{"ok":true,"data":{"date":"2026-07-04","count":0}}"#.utf8)
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
