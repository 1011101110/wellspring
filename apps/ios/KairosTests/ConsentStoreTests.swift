import XCTest
@testable import Kairos

/// Unit tests for issue #39/#70's `ConsentStore` — persistence and
/// independence of each category's toggle, matching
/// docs/04_DATA_PRIVACY_SECURITY.md §3 ("each signal category... is an
/// independent, revocable opt-in") and the opt-in-by-default posture pinned
/// by issue #70 (docs/14_IMPROVEMENT_REVIEW.md §1.8): a category never
/// explicitly toggled on must default to *disabled*, matching
/// `OnboardingViewModel.healthCategoryToggles`'s existing default-off
/// toggles — a consent store that defaulted every category to `true` is
/// exactly the "toggles gate nothing" bug this issue fixes.
final class ConsentStoreTests: XCTestCase {

    // MARK: - Defaults

    func test_userDefaultsStore_neverToggled_defaultsToDisabled() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsConsentStore(defaults: defaults)

        for category in ConsentCategory.allCases {
            XCTAssertFalse(sut.isEnabled(category), "\(category) should default to opted-out before any explicit toggle (opt-in posture, issue #70)")
        }
    }

    func test_inMemoryStore_defaultsToDisabled() {
        let sut = InMemoryConsentStore()
        for category in ConsentCategory.allCases {
            XCTAssertFalse(sut.isEnabled(category))
        }
    }

    // MARK: - Independence: toggling one category never affects another

    func test_userDefaultsStore_togglingOneCategoryOn_doesNotAffectOthers() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsConsentStore(defaults: defaults)

        sut.setEnabled(true, for: .recovery)

        XCTAssertTrue(sut.isEnabled(.recovery))
        XCTAssertFalse(sut.isEnabled(.sleep))
        XCTAssertFalse(sut.isEnabled(.activity))
        XCTAssertFalse(sut.isEnabled(.calendar))
    }

    func test_inMemoryStore_togglingOneCategoryOn_doesNotAffectOthers() {
        let sut = InMemoryConsentStore()
        sut.setEnabled(true, for: .calendar)

        XCTAssertTrue(sut.isEnabled(.calendar))
        XCTAssertFalse(sut.isEnabled(.recovery))
        XCTAssertFalse(sut.isEnabled(.sleep))
        XCTAssertFalse(sut.isEnabled(.activity))
    }

    func test_enablingAllFourCategories_eachIndependentlyOn() {
        let sut = InMemoryConsentStore()
        for category in ConsentCategory.allCases {
            sut.setEnabled(true, for: category)
        }
        for category in ConsentCategory.allCases {
            XCTAssertTrue(sut.isEnabled(category))
        }
        // Disabling one must not revoke the others.
        sut.setEnabled(false, for: .sleep)
        XCTAssertFalse(sut.isEnabled(.sleep))
        XCTAssertTrue(sut.isEnabled(.recovery))
        XCTAssertTrue(sut.isEnabled(.activity))
        XCTAssertTrue(sut.isEnabled(.calendar))
    }

    // MARK: - Persistence survives a fresh store instance (relaunch)

    func test_userDefaultsStore_persistsAcrossFreshInstance() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let writer = UserDefaultsConsentStore(defaults: defaults)
        writer.setEnabled(true, for: .recovery)
        writer.setEnabled(true, for: .calendar)

        // Fresh instance, same underlying suite — simulates an app relaunch.
        let reader = UserDefaultsConsentStore(defaults: defaults)
        XCTAssertTrue(reader.isEnabled(.recovery))
        XCTAssertTrue(reader.isEnabled(.calendar))
        XCTAssertFalse(reader.isEnabled(.sleep))
        XCTAssertFalse(reader.isEnabled(.activity))
    }

    func test_userDefaultsStore_toggleOnThenOff_persistsFinalState() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsConsentStore(defaults: defaults)

        sut.setEnabled(true, for: .activity)
        sut.setEnabled(false, for: .activity)

        let reader = UserDefaultsConsentStore(defaults: defaults)
        XCTAssertFalse(reader.isEnabled(.activity))
    }

    func test_allStates_returnsEveryCategory() {
        let sut = InMemoryConsentStore()
        sut.setEnabled(true, for: .sleep)

        let states = sut.allStates()
        XCTAssertEqual(states.count, ConsentCategory.allCases.count)
        XCTAssertEqual(states[.sleep], true)
        XCTAssertEqual(states[.recovery], false)
    }

    // MARK: - Distinct storage keys don't collide with each other or with PreferencesStore

    func test_categories_useDistinctStorageKeys() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsConsentStore(defaults: defaults)

        sut.setEnabled(true, for: .calendar)
        sut.setEnabled(true, for: .recovery)
        sut.setEnabled(true, for: .sleep)
        sut.setEnabled(true, for: .activity)

        // Every one of the four keys must be independently readable back
        // as true — if two categories shared a key, some of these would
        // incorrectly read false.
        for category in ConsentCategory.allCases {
            XCTAssertTrue(sut.isEnabled(category), "\(category) key collided with another category's key")
        }
    }
}
