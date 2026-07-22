import XCTest
@testable import Kairos

final class HealthConnectServiceTests: XCTestCase {

    func test_fakeService_requestAuthorization_reportsRequestedForToggledCategories() async throws {
        let sut = FakeHealthConnectService()
        let result = try await sut.requestAuthorization(for: [.recovery, .sleepQuality])

        XCTAssertEqual(result[.recovery], .requested)
        XCTAssertEqual(result[.sleepQuality], .requested)
        XCTAssertNil(result[.activity], "Only requested categories should appear in the result")
        XCTAssertEqual(sut.lastRequestedCategories, [.recovery, .sleepQuality])
    }

    func test_fakeService_simulatesDenial_reportsDeniedForAllRequested() async throws {
        let sut = FakeHealthConnectService(simulatesDenial: true)
        let result = try await sut.requestAuthorization(for: [.recovery, .activity])

        XCTAssertEqual(result[.recovery], .denied)
        XCTAssertEqual(result[.activity], .denied)
    }

    func test_fakeService_injectedError_isThrown() async {
        let sut = FakeHealthConnectService()
        sut.nextError = .unavailable

        do {
            _ = try await sut.requestAuthorization(for: [.recovery])
            XCTFail("Expected HealthConnectError.unavailable")
        } catch let error as HealthConnectError {
            XCTAssertEqual(error, .unavailable)
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }

    func test_primingCopy_isProvidedForEveryCategory() {
        let sut = FakeHealthConnectService()
        for category in HealthCategory.allCases {
            let copy = sut.primingCopy(for: category)
            XCTAssertFalse(copy.whatWeSend.isEmpty)
            XCTAssertFalse(copy.whatNeverLeaves.isEmpty)
        }
    }
}
