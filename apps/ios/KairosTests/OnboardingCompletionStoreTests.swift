import XCTest
@testable import Kairos

/// Unit tests for issue #71's `OnboardingCompletionStore` — the explicit,
/// persisted "has this device finished onboarding" flag that replaces
/// `RootView`'s old sign-in-at-launch inference
/// (docs/14_IMPROVEMENT_REVIEW.md §1.9).
final class OnboardingCompletionStoreTests: XCTestCase {

    // MARK: - Defaults

    func test_userDefaultsStore_neverCompleted_defaultsToFalse() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsOnboardingCompletionStore(defaults: defaults)

        XCTAssertFalse(sut.hasCompletedOnboarding())
    }

    func test_inMemoryStore_defaultsToFalse() {
        let sut = InMemoryOnboardingCompletionStore()
        XCTAssertFalse(sut.hasCompletedOnboarding())
    }

    func test_inMemoryStore_canBeSeededAsAlreadyCompleted() {
        let sut = InMemoryOnboardingCompletionStore(initial: true)
        XCTAssertTrue(sut.hasCompletedOnboarding())
    }

    // MARK: - markCompleted

    func test_userDefaultsStore_markCompleted_flipsToTrue() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsOnboardingCompletionStore(defaults: defaults)

        sut.markCompleted()

        XCTAssertTrue(sut.hasCompletedOnboarding())
    }

    func test_inMemoryStore_markCompleted_flipsToTrue() {
        let sut = InMemoryOnboardingCompletionStore()
        sut.markCompleted()
        XCTAssertTrue(sut.hasCompletedOnboarding())
    }

    func test_markCompleted_isIdempotent() {
        let sut = InMemoryOnboardingCompletionStore()
        sut.markCompleted()
        sut.markCompleted()
        XCTAssertTrue(sut.hasCompletedOnboarding())
    }

    // MARK: - Persistence survives a fresh store instance (relaunch)

    func test_userDefaultsStore_persistsAcrossFreshInstance() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let writer = UserDefaultsOnboardingCompletionStore(defaults: defaults)
        writer.markCompleted()

        // Fresh instance, same underlying suite — simulates an app relaunch.
        let reader = UserDefaultsOnboardingCompletionStore(defaults: defaults)
        XCTAssertTrue(reader.hasCompletedOnboarding())
    }

    func test_userDefaultsStore_neverCompleted_freshInstanceStillFalse() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        // No write at all — a fresh app install's exact scenario.
        let reader = UserDefaultsOnboardingCompletionStore(defaults: defaults)
        XCTAssertFalse(reader.hasCompletedOnboarding())
    }

    // MARK: - The latch (issue #225)

    /// These pin the property the whole server-authoritative design rests
    /// on: this flag is monotonic. It goes false -> true from either
    /// surface and has no true -> false edge at all — not from a `nil`
    /// server answer, not from a failed pull, not from anything.

    func test_applyServerCompletion_withADate_marksCompleted() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsOnboardingCompletionStore(defaults: defaults)

        sut.applyServerCompletion(at: Date(timeIntervalSince1970: 1_770_000_000))

        XCTAssertTrue(sut.hasCompletedOnboarding())
    }

    func test_applyServerCompletion_withNil_neverClearsALocalCompletion() {
        // `nil` means "the server has no record", which is also exactly what
        // every user who onboarded before #225 shipped looks like. Treating
        // it as "not onboarded" would re-onboard the entire existing user
        // base on upgrade.
        let sut = InMemoryOnboardingCompletionStore(initial: true)

        sut.applyServerCompletion(at: nil)

        XCTAssertTrue(sut.hasCompletedOnboarding())
    }

    func test_applyServerCompletion_withNil_doesNotInventACompletion() {
        // The other direction of the same guard: `nil` is not a grant
        // either. A fresh install must still be shown onboarding.
        let sut = InMemoryOnboardingCompletionStore(initial: false)

        sut.applyServerCompletion(at: nil)

        XCTAssertFalse(sut.hasCompletedOnboarding())
    }

    func test_needsServerBackfill_trueForALocallyOnboardedDeviceTheServerDoesNotKnowAbout() {
        // The pre-#225 user. Migration 1721800000000 backfilled nothing, so
        // this is how their completion reaches the server: individually, on
        // their next refresh, with a real timestamp.
        let sut = InMemoryOnboardingCompletionStore(initial: true, serverOnboardedAt: nil)
        XCTAssertTrue(sut.needsServerBackfill())
    }

    func test_needsServerBackfill_falseOnceTheServerHasARecord() {
        let sut = InMemoryOnboardingCompletionStore(initial: true)
        sut.applyServerCompletion(at: Date(timeIntervalSince1970: 1_770_000_000))
        XCTAssertFalse(sut.needsServerBackfill())
    }

    func test_needsServerBackfill_falseForADeviceThatNeverOnboarded() {
        // Distinct from `!hasCompletedOnboarding()`: a device with nothing
        // to say must not assert completion merely because the server
        // agrees nothing has happened.
        let sut = InMemoryOnboardingCompletionStore(initial: false)
        XCTAssertFalse(sut.needsServerBackfill())
    }

    func test_userDefaultsStore_serverTimestampPersistsAcrossFreshInstance() {
        // Otherwise every relaunch would re-backfill a server that already
        // knows, forever.
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let writer = UserDefaultsOnboardingCompletionStore(defaults: defaults)
        writer.applyServerCompletion(at: Date(timeIntervalSince1970: 1_770_000_000))

        let reader = UserDefaultsOnboardingCompletionStore(defaults: defaults)
        XCTAssertTrue(reader.hasCompletedOnboarding())
        XCTAssertFalse(reader.needsServerBackfill())
    }
}
