import XCTest
@testable import Kairos

/// Wiring for the reader's "Amen — mark complete" button (#3): the tap must
/// reach the client's `complete(id:)`, which posts to
/// POST /v1/devotionals/:id/complete (the server writes the YouVersion
/// highlight). Same VM-against-fakes pattern as HomeViewModelTests, plus a
/// URLProtocol-stub check that the HTTP client hits the right route.
@MainActor
final class DevotionalCompleteTests: XCTestCase {

    private func makeHomeVM(devotionals: FakeDevotionalsClient) -> HomeViewModel {
        HomeViewModel(
            devotionals: devotionals,
            upcomingClient: FakeUpcomingEventsClient(),
            connectionsClient: FakeConnectionsClient(),
            recapClient: FakeRecapClient(),
            journalClient: FakeJournalClient(),
            liturgyClient: FakeLiturgyClient(),
            generateNowClient: FakeGenerateNowClient(),
            accountInfo: FakeAccountInfoClient()
        )
    }

    func test_homeViewModel_completeDevotional_callsClient() async throws {
        let client = FakeDevotionalsClient()
        let sut = makeHomeVM(devotionals: client)

        try await sut.completeDevotional(id: "devo-42")

        XCTAssertEqual(client.completedIDs, ["devo-42"])
    }

    func test_historyViewModel_completeDevotional_callsClient() async throws {
        let client = FakeDevotionalsClient()
        let sut = HistoryViewModel(devotionals: client)

        try await sut.completeDevotional(id: "devo-7")

        XCTAssertEqual(client.completedIDs, ["devo-7"])
    }

    func test_completeDevotional_propagatesClientError() async {
        let client = FakeDevotionalsClient(nextError: .server(statusCode: 500))
        let sut = HistoryViewModel(devotionals: client)

        do {
            try await sut.completeDevotional(id: "devo-x")
            XCTFail("expected the client error to propagate")
        } catch let error as DashboardError {
            XCTAssertEqual(error, .server(statusCode: 500))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(client.completedIDs.isEmpty, "a failed post records no completion")
    }

    func test_httpClient_complete_postsToCompleteRoute() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DashboardStubURLProtocol.self]
        DashboardStubURLProtocol.statusCode = 200
        DashboardStubURLProtocol.responseData = Data(#"{"ok":true,"completedAt":"2026-07-24T09:00:00.000Z"}"#.utf8)
        DashboardStubURLProtocol.lastRequest = nil

        let client = HTTPDevotionalsClient(
            baseURL: URL(string: "https://api.test")!,
            session: URLSession(configuration: config),
            idTokenProvider: { "tok-123" }
        )

        try await client.complete(id: "d1")

        XCTAssertEqual(DashboardStubURLProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(DashboardStubURLProtocol.lastRequest?.url?.path, "/v1/devotionals/d1/complete")
    }
}
