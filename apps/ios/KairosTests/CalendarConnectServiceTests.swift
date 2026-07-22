import XCTest
@testable import Kairos

final class CalendarConnectServiceTests: XCTestCase {

    func test_fakeService_initialStatus_notConnected() {
        let sut = FakeCalendarConnectService()
        XCTAssertEqual(sut.status, .notConnected)
    }

    func test_fakeService_connect_updatesStatus() async throws {
        let sut = FakeCalendarConnectService()
        let status = try await sut.connect(.appleEventKit)

        XCTAssertEqual(status, .connected(.appleEventKit))
        XCTAssertEqual(sut.status, .connected(.appleEventKit))
    }

    func test_fakeService_injectedError_isThrown() async {
        let sut = FakeCalendarConnectService()
        sut.nextError = .cancelled

        do {
            _ = try await sut.connect(.google)
            XCTFail("Expected CalendarConnectError.cancelled")
        } catch let error as CalendarConnectError {
            XCTAssertEqual(error, .cancelled)
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }

    /// `FakeCalendarConnectService` intentionally never wires a live Google
    /// collaborator (Demo Mode has no live network dependency at all,
    /// issue #124) — it must keep reporting `.notImplemented` for `.google`
    /// rather than silently pretending to succeed.
    func test_fakeService_googleConnect_alwaysThrowsNotImplemented() async {
        let sut = FakeCalendarConnectService()
        do {
            _ = try await sut.connect(.google)
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

    /// `EventKitCalendarConnectService` with no injected Google collaborator
    /// (its default) must preserve the pre-#124 "not implemented" behavior
    /// — this is the fallback that keeps any call site that hasn't been
    /// updated to inject a real Google service working exactly as before.
    func test_eventKitService_googleConnectWithNoInjectedCollaborator_throwsNotImplemented() async {
        let sut = EventKitCalendarConnectService()
        do {
            _ = try await sut.connect(.google)
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

    /// With a real Google collaborator injected (here, `GoogleCalendarConnectService`
    /// wired to fakes so no live network/UI is touched), `EventKitCalendarConnectService`
    /// delegates `.google` calls to it rather than throwing (issue #124).
    func test_eventKitService_googleConnectWithInjectedCollaborator_delegates() async throws {
        let fakeConnectClient = FakeGoogleConnectClient()
        let fakeSessionRunner = FakeGoogleOAuthSessionRunner()
        fakeSessionRunner.nextResult = .success(
            URL(string: "kairos://connect-callback?status=success")!
        )
        let googleService = GoogleCalendarConnectService(
            connectClient: fakeConnectClient,
            sessionRunner: fakeSessionRunner
        )
        let sut = EventKitCalendarConnectService(googleConnectService: googleService)

        let status = try await sut.connect(.google)

        XCTAssertEqual(status, .connected(.google))
        XCTAssertEqual(sut.status, .connected(.google))
    }

    func test_primingCopy_isProvidedForEveryKind() {
        let sut = FakeCalendarConnectService()
        for kind: CalendarConnectionKind in [.google, .appleEventKit, .emailOnly] {
            let copy = sut.primingCopy(for: kind)
            XCTAssertFalse(copy.whatWeSend.isEmpty)
            XCTAssertFalse(copy.whatNeverLeaves.isEmpty)
        }
    }
}
