import XCTest
@testable import Kairos

/// Tests for `GoogleCalendarConnectService` (issue #124) — the
/// orchestration (fetch authUrl -> present session -> parse callback ->
/// map to `CalendarConnectStatus`) against `FakeGoogleConnectClient` +
/// `FakeGoogleOAuthSessionRunner`, with zero live network/UI dependency.
/// Also covers `GoogleOAuthCallbackParser`'s pure URL-parsing directly.
final class GoogleCalendarConnectServiceTests: XCTestCase {

    func test_connect_happyPath_returnsConnectedGoogle() async throws {
        let connectClient = FakeGoogleConnectClient()
        let sessionRunner = FakeGoogleOAuthSessionRunner()
        sessionRunner.nextResult = .success(URL(string: "kairos://connect-callback?status=success")!)
        let sut = GoogleCalendarConnectService(connectClient: connectClient, sessionRunner: sessionRunner)

        let status = try await sut.connect(.google)

        XCTAssertEqual(status, .connected(.google))
        XCTAssertEqual(sut.status, .connected(.google))
    }

    func test_connect_passesFetchedAuthURLAndKairosSchemeToSessionRunner() async throws {
        let connectClient = FakeGoogleConnectClient()
        connectClient.nextURL = URL(string: "https://accounts.google.com/o/oauth2/v2/auth?state=abc")!
        let sessionRunner = FakeGoogleOAuthSessionRunner()
        sessionRunner.nextResult = .success(URL(string: "kairos://connect-callback?status=success")!)
        let sut = GoogleCalendarConnectService(connectClient: connectClient, sessionRunner: sessionRunner)

        _ = try await sut.connect(.google)

        XCTAssertEqual(
            sessionRunner.lastRequestedURL,
            URL(string: "https://accounts.google.com/o/oauth2/v2/auth?state=abc")
        )
        XCTAssertEqual(sessionRunner.lastCallbackScheme, "kairos")
    }

    func test_connect_userDenied_throwsPermissionDeniedAndSetsDeniedStatus() async {
        let connectClient = FakeGoogleConnectClient()
        let sessionRunner = FakeGoogleOAuthSessionRunner()
        sessionRunner.nextResult = .success(
            URL(string: "kairos://connect-callback?status=error&reason=denied")!
        )
        let sut = GoogleCalendarConnectService(connectClient: connectClient, sessionRunner: sessionRunner)

        do {
            _ = try await sut.connect(.google)
            XCTFail("Expected CalendarConnectError.permissionDenied")
        } catch let error as CalendarConnectError {
            XCTAssertEqual(error, .permissionDenied)
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
        XCTAssertEqual(sut.status, .denied(.google))
    }

    func test_connect_sessionCancelled_throwsCancelled() async {
        let connectClient = FakeGoogleConnectClient()
        let sessionRunner = FakeGoogleOAuthSessionRunner()
        sessionRunner.nextResult = .failure(GoogleOAuthSessionError.cancelled)
        let sut = GoogleCalendarConnectService(connectClient: connectClient, sessionRunner: sessionRunner)

        do {
            _ = try await sut.connect(.google)
            XCTFail("Expected CalendarConnectError.cancelled")
        } catch let error as CalendarConnectError {
            XCTAssertEqual(error, .cancelled)
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
        XCTAssertEqual(sut.status, .notConnected)
    }

    func test_connect_sessionPresentationFailed_throwsUnknownWithDetail() async {
        let connectClient = FakeGoogleConnectClient()
        let sessionRunner = FakeGoogleOAuthSessionRunner()
        sessionRunner.nextResult = .failure(GoogleOAuthSessionError.presentationFailed("no key window"))
        let sut = GoogleCalendarConnectService(connectClient: connectClient, sessionRunner: sessionRunner)

        do {
            _ = try await sut.connect(.google)
            XCTFail("Expected CalendarConnectError.unknown")
        } catch let error as CalendarConnectError {
            XCTAssertEqual(error, .unknown("no key window"))
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
        XCTAssertEqual(sut.status, .notConnected)
    }

    func test_connect_fetchAuthURLFails_throwsUnknownWithoutPresentingSession() async {
        let connectClient = FakeGoogleConnectClient()
        connectClient.nextError = .server(statusCode: 500)
        let sessionRunner = FakeGoogleOAuthSessionRunner()
        let sut = GoogleCalendarConnectService(connectClient: connectClient, sessionRunner: sessionRunner)

        do {
            _ = try await sut.connect(.google)
            XCTFail("Expected CalendarConnectError.unknown")
        } catch let error as CalendarConnectError {
            guard case .unknown = error else {
                XCTFail("Expected .unknown, got \(error)")
                return
            }
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
        XCTAssertNil(sessionRunner.lastRequestedURL, "Session must never be presented when fetching the auth URL fails")
    }

    func test_connect_nonGoogleKind_throwsNotImplemented() async {
        let sut = GoogleCalendarConnectService(
            connectClient: FakeGoogleConnectClient(),
            sessionRunner: FakeGoogleOAuthSessionRunner()
        )

        do {
            _ = try await sut.connect(.appleEventKit)
            XCTFail("Expected CalendarConnectError.notImplemented")
        } catch let error as CalendarConnectError {
            guard case .notImplemented = error else {
                XCTFail("Expected .notImplemented, got \(error)")
                return
            }
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }

    // MARK: - GoogleOAuthCallbackParser (pure logic)

    func test_parser_statusSuccess_returnsConnectedGoogle() {
        let result = GoogleOAuthCallbackParser.parse(
            URL(string: "kairos://connect-callback?status=success")!
        )
        switch result {
        case .success(let status):
            XCTAssertEqual(status, .connected(.google))
        case .failure(let error):
            XCTFail("Expected success, got \(error)")
        }
    }

    func test_parser_statusErrorReasonDenied_returnsPermissionDenied() {
        let result = GoogleOAuthCallbackParser.parse(
            URL(string: "kairos://connect-callback?status=error&reason=denied")!
        )
        switch result {
        case .success(let status):
            XCTFail("Expected failure, got \(status)")
        case .failure(let error):
            XCTAssertEqual(error, .permissionDenied)
        }
    }

    func test_parser_statusErrorOtherReason_returnsUnknownWithReason() {
        let result = GoogleOAuthCallbackParser.parse(
            URL(string: "kairos://connect-callback?status=error&reason=server_error")!
        )
        switch result {
        case .success(let status):
            XCTFail("Expected failure, got \(status)")
        case .failure(let error):
            XCTAssertEqual(error, .unknown("server_error"))
        }
    }

    func test_parser_missingStatus_returnsUnknown() {
        let result = GoogleOAuthCallbackParser.parse(URL(string: "kairos://connect-callback")!)
        switch result {
        case .success(let status):
            XCTFail("Expected failure, got \(status)")
        case .failure(let error):
            guard case .unknown = error else {
                XCTFail("Expected .unknown, got \(error)")
                return
            }
        }
    }
}
