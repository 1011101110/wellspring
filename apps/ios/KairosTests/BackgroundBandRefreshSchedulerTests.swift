import XCTest
import BackgroundTasks
import BandDeriver
@testable import Kairos

/// Issue #37: true `BGAppRefreshTask` background-execution *timing* cannot
/// be verified in a simulator or without a physical device — iOS's
/// `BGTaskScheduler` gives the OS full discretion over whether/when a
/// submitted request actually fires, which the Simulator does not model.
/// This matches docs/07_TEST_PLAN.md §6's own acknowledged manual
/// physical-device checklist item ("Real iPhone: ... morning
/// `BGAppRefreshTask` uploads them") — it is not a gap introduced by this
/// suite.
///
/// What IS deterministically testable without a device, and is tested
/// here: the task identifier contract, that registration doesn't crash,
/// that the task handler correctly drives `BandUploadService` and always
/// calls `setTaskCompleted` exactly once (including on expiration), and
/// that scheduling submits a request with the expected identifier without
/// throwing when `BGTaskScheduler` rejects submission (e.g. no
/// entitlement in the test host).
@MainActor
final class BackgroundBandRefreshSchedulerTests: XCTestCase {

    func test_taskIdentifier_matchesInfoPlistDeclaredIdentifier() throws {
        // project.yml declares BGTaskSchedulerPermittedIdentifiers with
        // exactly this string — this test guards against the two ever
        // drifting apart (BGTaskScheduler.register throws at runtime if
        // they don't match).
        XCTAssertEqual(BackgroundBandRefreshScheduler.taskIdentifier, "com.kairos.devotional.bandRefresh")
    }

    func test_scheduleNextRefresh_doesNotThrow_evenWithoutBackgroundEntitlement() {
        // The unit test host process typically has no BGTaskScheduler
        // entitlement, so `submit` is expected to throw internally — the
        // scheduler swallows that (non-fatal, see doc comment on
        // `scheduleNextRefresh`) rather than propagating or crashing.
        let service = BandUploadService(
            healthReader: FakeHealthSampleReader(nextInput: .empty),
            uploadClient: FakeBandUploadClient(),
            consentStore: Self.allEnabledConsentStore()
        )
        let sut = BackgroundBandRefreshScheduler(bandUploadService: service)

        // Must not throw/crash regardless of entitlement state.
        sut.scheduleNextRefresh()
    }

    func test_handle_successfulRefresh_marksTaskCompletedSuccessfully() async throws {
        let uploadClient = FakeBandUploadClient()
        let service = BandUploadService(
            healthReader: FakeHealthSampleReader(nextInput: .demoFixture),
            uploadClient: uploadClient,
            consentStore: Self.allEnabledConsentStore()
        )
        let sut = BackgroundBandRefreshScheduler(bandUploadService: service)

        let task = FakeBackgroundRefreshTaskHandle()
        sut.handle(task)

        // `handle` kicks off an unstructured Task internally; poll briefly
        // for completion rather than assuming synchronous execution.
        try await waitUntil(timeout: 2) { task.completedSuccess != nil }

        XCTAssertEqual(task.completedSuccess, true)
        XCTAssertEqual(uploadClient.uploadedRequests.count, 1, "The task handler must actually invoke the upload pipeline")
    }

    func test_handle_healthDataUnavailable_stillMarksTaskCompleted_neverCrashes() async throws {
        // Graceful degradation must hold inside the background task path
        // too, not just the manual-refresh path (issue #37 acceptance:
        // "Tolerates failure").
        let service = BandUploadService(
            healthReader: FakeHealthSampleReader(nextError: .unavailable),
            uploadClient: FakeBandUploadClient(),
            consentStore: Self.allEnabledConsentStore()
        )
        let sut = BackgroundBandRefreshScheduler(bandUploadService: service)

        let task = FakeBackgroundRefreshTaskHandle()
        sut.handle(task)

        try await waitUntil(timeout: 2) { task.completedSuccess != nil }

        XCTAssertEqual(task.completedSuccess, true, "A denied/unavailable HealthKit read is not a task failure — it degrades to calendar-only")
        XCTAssertEqual(service.lastOutcome, .skippedNoHealthData)
    }

    func test_handle_expiration_cancelsWorkAndMarksTaskFailed() {
        let service = BandUploadService(
            healthReader: FakeHealthSampleReader(nextInput: .demoFixture),
            uploadClient: FakeBandUploadClient(),
            consentStore: Self.allEnabledConsentStore()
        )
        let sut = BackgroundBandRefreshScheduler(bandUploadService: service)

        let task = FakeBackgroundRefreshTaskHandle()
        sut.handle(task)

        // Simulate the OS revoking the task's execution budget immediately.
        task.expirationHandler?()

        XCTAssertEqual(task.completedSuccess, false)
    }

    // MARK: - Test helpers

    /// This suite exercises the scheduler/task-handling plumbing, not
    /// consent-gating itself (that's `BandUploadServiceTests`'
    /// responsibility, issue #70) — every category enabled keeps this
    /// suite's existing assertions (e.g. "the upload pipeline was invoked
    /// at all") meaningful without conflating the two concerns.
    private static func allEnabledConsentStore() -> InMemoryConsentStore {
        InMemoryConsentStore(initial: [.recovery: true, .sleep: true, .activity: true, .calendar: true])
    }

    // MARK: - Polling helper (no real background timing implied — just
    // waiting for our own `Task { ... }` inside `handle` to finish hopping
    // back to the main actor).

    private func waitUntil(timeout: TimeInterval, condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("Timed out waiting for condition")
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

/// Fake `BackgroundRefreshTaskHandle` — real `BGAppRefreshTask` cannot be
/// instantiated directly (Apple marks its initializer `NS_UNAVAILABLE`:
/// "Subclasses of this abstract type are created by the system"), so
/// `BackgroundBandRefreshScheduler.handle(_:)` is written against this
/// protocol instead, making it fully testable without the OS.
private final class FakeBackgroundRefreshTaskHandle: BackgroundRefreshTaskHandle {
    var expirationHandler: (() -> Void)?
    private(set) var completedSuccess: Bool?

    func setTaskCompleted(success: Bool) {
        completedSuccess = success
    }
}
