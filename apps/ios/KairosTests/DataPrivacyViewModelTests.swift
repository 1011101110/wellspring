import XCTest
import BandDeriver
@testable import Kairos

/// Unit tests for `DataPrivacyViewModel` (issue #39). Central assertion
/// per the task: "toggling a category off is reflected immediately (not
/// just visually) — verify the underlying preference/consent state
/// actually changed." Every test that flips a toggle reads the state back
/// through a *second, independent* `ConsentStore` reference (not the view
/// model's published property) to prove the underlying persisted state
/// changed, not just the on-screen binding.
@MainActor
final class DataPrivacyViewModelTests: XCTestCase {

    private func makeSUT(
        consentStore: (any ConsentStore)? = nil,
        calendarService: (any CalendarConnectService)? = nil,
        ledgerProvider: (any DataLedgerProviding)? = nil,
        deletionClient: (any AccountDeletionClient)? = nil,
        authService: (any AuthService)? = nil,
        googleConnectClient: FakeGoogleConnectClient? = nil
    ) -> (DataPrivacyViewModel, any ConsentStore, FakeCalendarConnectService, FakeAccountDeletionClient, FakeAuthService) {
        let consent = consentStore ?? InMemoryConsentStore()
        let calendar = (calendarService as? FakeCalendarConnectService) ?? FakeCalendarConnectService(status: .connected(.appleEventKit))
        let ledger = ledgerProvider ?? FakeDataLedgerProvider()
        let deletion = (deletionClient as? FakeAccountDeletionClient) ?? FakeAccountDeletionClient()
        let auth = (authService as? FakeAuthService) ?? FakeAuthService(initialUser: .demoDavid)
        let connect = googleConnectClient ?? FakeGoogleConnectClient()

        let sut = DataPrivacyViewModel(
            consentStore: consent,
            calendarService: calendar,
            ledgerProvider: ledger,
            deletionClient: deletion,
            authService: auth,
            googleConnectClient: connect
        )
        return (sut, consent, calendar, deletion, auth)
    }

    // MARK: - Toggle state reflected immediately in the underlying store

    func test_setEnabled_off_isReflectedInUnderlyingConsentStore_notJustPublishedState() {
        let sharedStore = InMemoryConsentStore()
        let (sut, _, _, _, _) = makeSUT(consentStore: sharedStore)

        sut.setEnabled(false, for: .recovery)

        // Read back through a completely independent reference to the same
        // underlying store — proves the write is real persisted state, not
        // just the view model's own `@Published` copy.
        XCTAssertFalse(sharedStore.isEnabled(.recovery), "Underlying ConsentStore must reflect the toggle immediately")
        XCTAssertFalse(sut.isEnabled(.recovery), "Published state must match too")
    }

    func test_setEnabled_on_afterOff_isReflectedInUnderlyingStore() {
        let sharedStore = InMemoryConsentStore()
        let (sut, _, _, _, _) = makeSUT(consentStore: sharedStore)

        sut.setEnabled(false, for: .sleep)
        sut.setEnabled(true, for: .sleep)

        XCTAssertTrue(sharedStore.isEnabled(.sleep))
        XCTAssertTrue(sut.isEnabled(.sleep))
    }

    func test_setEnabled_eachCategoryIndependent_viaViewModel() {
        // Every category defaults to off (issue #70's opt-in posture) — so
        // "independent" is proven by turning ONE category on and asserting
        // the sibling categories stay at their off default, not by turning
        // one off and checking the (no longer true) old opt-out default.
        let sharedStore = InMemoryConsentStore()
        let (sut, _, _, _, _) = makeSUT(consentStore: sharedStore)

        sut.setEnabled(true, for: .activity)

        XCTAssertTrue(sharedStore.isEnabled(.activity))
        XCTAssertFalse(sharedStore.isEnabled(.calendar))
        XCTAssertFalse(sharedStore.isEnabled(.recovery))
        XCTAssertFalse(sharedStore.isEnabled(.sleep))
    }

    func test_freshViewModelInstance_overSameStore_seesPriorToggle() {
        // Simulates navigating away from the screen and back: a second
        // `DataPrivacyViewModel` backed by the same store must observe the
        // first instance's write, exactly like `PreferencesViewModelTests`'
        // analogous coverage.
        let sharedStore = InMemoryConsentStore()
        let (first, _, _, _, _) = makeSUT(consentStore: sharedStore)
        first.setEnabled(false, for: .calendar)

        let (second, _, _, _, _) = makeSUT(consentStore: sharedStore)
        XCTAssertFalse(second.isEnabled(.calendar))
    }

    // MARK: - Ledger truthfulness: snapshots the actual sent request, unaffected by later toggles

    /// Issue #70 (docs/14_IMPROVEMENT_REVIEW.md §1.8) replaces the old
    /// (incorrect) expectation that toggling consent off retroactively
    /// hides an already-uploaded band from today's ledger. The ledger's
    /// entire purpose is "what we sent today" — a category consented-to
    /// and genuinely sent this morning must keep showing as sent even if
    /// the user revokes that consent this afternoon; only *tomorrow's*
    /// upload will actually omit it. This test directly replaces
    /// `test_togglingRecoveryOff_removesRecoveryFromLedgerImmediately`,
    /// which used to assert the opposite (fictional) behavior.
    func test_togglingRecoveryOffAfterUpload_doesNotRewriteAlreadySentLedgerEntry() {
        let consentStore = InMemoryConsentStore(initial: [.recovery: true, .sleep: true, .activity: true])
        let bandUploadService = BandUploadService(
            healthReader: FakeHealthSampleReader(nextInput: .demoFixture),
            uploadClient: FakeBandUploadClient(),
            consentStore: consentStore
        )
        let ledgerProvider = BandUploadLedgerProvider(bandUploadService: bandUploadService)

        let (sut, _, _, _, _) = makeSUT(consentStore: consentStore, ledgerProvider: ledgerProvider)

        let expectation = expectation(description: "upload completes")
        Task {
            _ = await bandUploadService.refreshAndUpload()
            sut.refresh()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 5)

        XCTAssertNotNil(sut.ledgerEntry?.recovery, "Recovery should be present — it was consented and sent this morning")

        sut.setEnabled(false, for: .recovery)
        sut.refresh()

        XCTAssertNotNil(sut.ledgerEntry?.recovery, "Turning recovery off AFTER it was already sent must not retroactively rewrite today's ledger — that band genuinely left the device")
        XCTAssertNotNil(sut.ledgerEntry?.sleepQuality)
        XCTAssertNotNil(sut.ledgerEntry?.activity)
    }

    /// The flip side: a category withheld BEFORE the upload (so it was
    /// never sent) correctly shows as withheld in the ledger, and turning
    /// it on afterwards does not retroactively fabricate a "sent" entry for
    /// data that never actually left the device this morning.
    func test_categoryWithheldBeforeUpload_showsWithheldInLedger_evenIfToggledOnAfterward() {
        let consentStore = InMemoryConsentStore(initial: [.recovery: false, .sleep: true, .activity: true])
        let bandUploadService = BandUploadService(
            healthReader: FakeHealthSampleReader(nextInput: .demoFixture),
            uploadClient: FakeBandUploadClient(),
            consentStore: consentStore
        )
        let ledgerProvider = BandUploadLedgerProvider(bandUploadService: bandUploadService)

        let (sut, _, _, _, _) = makeSUT(consentStore: consentStore, ledgerProvider: ledgerProvider)

        let expectation = expectation(description: "upload completes")
        Task {
            _ = await bandUploadService.refreshAndUpload()
            sut.refresh()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 5)

        XCTAssertNil(sut.ledgerEntry?.recovery, "Recovery was withheld before the upload — it was genuinely never sent")

        sut.setEnabled(true, for: .recovery)
        sut.refresh()

        XCTAssertNil(sut.ledgerEntry?.recovery, "Turning recovery on AFTER today's upload must not fabricate a 'sent' entry for data that never left the device this morning")
    }

    // MARK: - Disconnect calendar (issue #213)

    /// The regression test for #213 itself. Before the fix, `disconnectCalendar()`
    /// was three local writes and no network call at all: this assertion —
    /// that a request actually left the client — is the one that would have
    /// caught it. Everything else on this screen could pass while the
    /// backend kept a live refresh token and went on reading the user's
    /// free/busy every day.
    func test_disconnectCalendar_callsDeleteConnectGoogle() async {
        let connect = FakeGoogleConnectClient()
        let (sut, _, _, _, _) = makeSUT(googleConnectClient: connect)

        await sut.disconnectCalendar()

        XCTAssertEqual(connect.disconnectCallCount, 1, "Disconnect must issue the server-side revoke, not just mutate local state")
    }

    func test_disconnectCalendar_success_setsStatusToNotConnected_andConsentOff() async {
        let sharedStore = InMemoryConsentStore(initial: [.calendar: true])
        let calendar = FakeCalendarConnectService(status: .connected(.appleEventKit))
        let (sut, _, _, _, _) = makeSUT(consentStore: sharedStore, calendarService: calendar)

        await sut.disconnectCalendar()

        XCTAssertEqual(sut.calendarStatus, .notConnected)
        XCTAssertFalse(sharedStore.isEnabled(.calendar), "Disconnect must also flip the calendar consent toggle off in the underlying store")
        XCTAssertNil(sut.disconnectError)
        XCTAssertTrue(sut.didCompleteDisconnect)
    }

    /// The other half of #213: "a failed request leaves the UI showing
    /// connected, with an error." Reporting `.notConnected` for a revoke
    /// that did not happen is the same defect the issue is about, just
    /// reached along the error path instead of the happy one.
    func test_disconnectCalendar_failure_leavesStatusConnected_andSurfacesError() async {
        let sharedStore = InMemoryConsentStore(initial: [.calendar: true])
        let calendar = FakeCalendarConnectService(status: .connected(.google))
        let connect = FakeGoogleConnectClient()
        connect.nextDisconnectError = .server(statusCode: 500)
        let (sut, _, _, _, _) = makeSUT(
            consentStore: sharedStore,
            calendarService: calendar,
            googleConnectClient: connect
        )

        await sut.disconnectCalendar()

        XCTAssertEqual(
            sut.calendarStatus,
            .connected(.google),
            "A failed revoke must NOT display 'Not connected' — the calendar is still connected"
        )
        XCTAssertTrue(
            sharedStore.isEnabled(.calendar),
            "A failed revoke must not flip the persisted consent flag either — that would make the next screen render read as disconnected"
        )
        XCTAssertNotNil(sut.disconnectError)
        XCTAssertFalse(sut.didCompleteDisconnect)
    }

    func test_disconnectCalendar_failure_thenRetrySucceeds_clearsErrorAndDisconnects() async {
        let sharedStore = InMemoryConsentStore(initial: [.calendar: true])
        let connect = FakeGoogleConnectClient()
        connect.nextDisconnectError = .network("offline")
        let (sut, _, _, _, _) = makeSUT(consentStore: sharedStore, googleConnectClient: connect)

        await sut.disconnectCalendar()
        XCTAssertNotNil(sut.disconnectError)

        connect.nextDisconnectError = nil
        await sut.disconnectCalendar()

        XCTAssertNil(sut.disconnectError, "A successful retry must clear the stale failure message")
        XCTAssertEqual(sut.calendarStatus, .notConnected)
        XCTAssertFalse(sharedStore.isEnabled(.calendar))
        XCTAssertEqual(connect.disconnectCallCount, 2)
    }

    func test_isDisconnectingCalendar_falseAfterCompletion_onBothPaths() async {
        let (success, _, _, _, _) = makeSUT()
        await success.disconnectCalendar()
        XCTAssertFalse(success.isDisconnectingCalendar)

        let failing = FakeGoogleConnectClient()
        failing.nextDisconnectError = .notAuthenticated
        let (failure, _, _, _, _) = makeSUT(googleConnectClient: failing)
        await failure.disconnectCalendar()
        XCTAssertFalse(failure.isDisconnectingCalendar)
    }

    /// `refresh()` re-reads `calendarService.status`, which is in-memory
    /// device state that knows nothing about the server's `connections`
    /// row and therefore still says `.connected` after a confirmed revoke.
    /// `DataPrivacyView` calls `refresh()` from both `.task` and
    /// `.onAppear`, so without the `didCompleteDisconnect` guard the very
    /// next appearance would silently resurrect "Connected" over a genuine
    /// disconnect.
    func test_refreshAfterSuccessfulDisconnect_doesNotResurrectConnectedStatus() async {
        let calendar = FakeCalendarConnectService(status: .connected(.appleEventKit))
        let (sut, _, _, _, _) = makeSUT(calendarService: calendar)

        await sut.disconnectCalendar()
        sut.refresh()

        XCTAssertEqual(sut.calendarStatus, .notConnected)
    }

    /// The mirror image: a *failed* disconnect must leave `refresh()`
    /// working normally, since nothing was revoked and the device's status
    /// is still the truthful one.
    func test_refreshAfterFailedDisconnect_stillReadsThroughToCalendarService() async {
        let calendar = FakeCalendarConnectService(status: .connected(.appleEventKit))
        let connect = FakeGoogleConnectClient()
        connect.nextDisconnectError = .server(statusCode: 503)
        let (sut, _, _, _, _) = makeSUT(calendarService: calendar, googleConnectClient: connect)

        await sut.disconnectCalendar()
        sut.refresh()

        XCTAssertEqual(sut.calendarStatus, .connected(.appleEventKit))
    }

    // MARK: - Delete account

    func test_confirmDeleteAccount_success_signsOutAndSetsCompletionFlag() async {
        let deletionClient = FakeAccountDeletionClient()
        let auth = FakeAuthService(initialUser: .demoDavid)
        let (sut, _, _, _, _) = makeSUT(deletionClient: deletionClient, authService: auth)

        await sut.confirmDeleteAccount()

        XCTAssertEqual(deletionClient.deleteAccountCallCount, 1)
        XCTAssertTrue(sut.didCompleteDeletion)
        XCTAssertNil(sut.deletionError)
        XCTAssertNil(auth.currentUser, "A successful deletion must sign the user out locally too")
    }

    func test_confirmDeleteAccount_failure_surfacesErrorAndDoesNotSignOut() async {
        let deletionClient = FakeAccountDeletionClient(nextError: .server(statusCode: 500))
        let auth = FakeAuthService(initialUser: .demoDavid)
        let (sut, _, _, _, _) = makeSUT(deletionClient: deletionClient, authService: auth)

        await sut.confirmDeleteAccount()

        XCTAssertFalse(sut.didCompleteDeletion)
        XCTAssertNotNil(sut.deletionError)
        XCTAssertNotNil(auth.currentUser, "A failed deletion must not sign the user out")
    }

    func test_isDeletingAccount_falseAfterCompletion() async {
        let (sut, _, _, _, _) = makeSUT()
        await sut.confirmDeleteAccount()
        XCTAssertFalse(sut.isDeletingAccount)
    }
}
