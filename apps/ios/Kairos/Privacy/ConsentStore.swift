import Foundation

/// Abstraction over "where per-category consent toggles
/// (docs/04_DATA_PRIVACY_SECURITY.md §3) are persisted" — the actual
/// source of truth for whether a category's signal is ever collected or
/// sent, independent of the underlying OS permission grant. A user can
/// have OS-level HealthKit "sleep" access granted and still have the
/// Kairos "sleep" toggle off (data ledger / upload paths must respect
/// this), and this store is what they're toggling.
///
/// Mirrors `PreferencesStore`'s shape and persistence pattern exactly (see
/// that file's doc comment) so the two screens (F7 Preferences, this Data
/// & Privacy screen) behave identically from the user's point of view:
/// every toggle write-throughs immediately, no separate "Save" step.
public protocol ConsentStore: AnyObject, Sendable {
    /// Loads the full per-category consent map. Any category never
    /// explicitly toggled by the user defaults to `false` (opted out) —
    /// docs/04_DATA_PRIVACY_SECURITY.md §3's consent model is opt-in by
    /// category, matching `OnboardingViewModel.healthCategoryToggles`'
    /// existing default-off posture ("each category is an independent
    /// toggle, off by default — only toggled-on categories are ever
    /// requested from HealthKit"). This store's real seeding happens once,
    /// explicitly, from onboarding's health-priming + calendar-connect
    /// results (`OnboardingViewModel`'s completion path) — a category the
    /// user never had a chance to toggle on (e.g. this store being read
    /// before onboarding has run at all) must never be silently treated as
    /// consented.
    func isEnabled(_ category: ConsentCategory) -> Bool

    /// Sets a single category's consent and persists immediately.
    /// Independent of every other category (docs/04 §3: "each signal
    /// category... is an independent, revocable opt-in").
    func setEnabled(_ enabled: Bool, for category: ConsentCategory)

    /// Convenience: the full current state as a dictionary, for views that
    /// want to render all categories at once.
    func allStates() -> [ConsentCategory: Bool]
}

/// Real, local persistence: one `UserDefaults` bool per category, keyed by
/// category raw value. Deliberately *not* a single JSON blob (unlike
/// `UserDefaultsPreferencesStore`) — each category is independently
/// readable/writable with no risk of a decode failure on one category
/// losing every other category's state.
public final class UserDefaultsConsentStore: ConsentStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let keyPrefix: String

    public init(defaults: UserDefaults = .standard, keyPrefix: String = "com.kairos.consent.v1.") {
        self.defaults = defaults
        self.keyPrefix = keyPrefix
    }

    public func isEnabled(_ category: ConsentCategory) -> Bool {
        let key = storageKey(for: category)
        // `UserDefaults.bool(forKey:)` returns `false` for both "never set"
        // and "explicitly turned off," which would be indistinguishable —
        // that ambiguity doesn't matter for the *value* returned now that
        // the default is `false` either way, but `object(forKey:)` is kept
        // here (rather than switching to the shorter `bool(forKey:)`) so a
        // future change to the never-set default only has to change this
        // one return statement, not detection logic.
        guard let stored = defaults.object(forKey: key) as? Bool else {
            return false
        }
        return stored
    }

    public func setEnabled(_ enabled: Bool, for category: ConsentCategory) {
        defaults.set(enabled, forKey: storageKey(for: category))
        // Same rationale as `UserDefaultsPreferencesStore.save`: a consent
        // toggle is a rare, deliberate, privacy-sensitive action — force a
        // synchronous flush so it is never lost to a killed process
        // immediately after toggling (including `XCUIApplication.terminate()`
        // in tests).
        defaults.synchronize()
    }

    public func allStates() -> [ConsentCategory: Bool] {
        var result: [ConsentCategory: Bool] = [:]
        for category in ConsentCategory.allCases {
            result[category] = isEnabled(category)
        }
        return result
    }

    private func storageKey(for category: ConsentCategory) -> String {
        keyPrefix + category.rawValue
    }
}

/// In-memory `ConsentStore` for previews, unit tests, and Demo Mode — no
/// `UserDefaults`/disk dependency at all.
public final class InMemoryConsentStore: ConsentStore, @unchecked Sendable {
    private var states: [ConsentCategory: Bool]

    public init(initial: [ConsentCategory: Bool] = [:]) {
        var seeded = initial
        for category in ConsentCategory.allCases where seeded[category] == nil {
            seeded[category] = false
        }
        self.states = seeded
    }

    public func isEnabled(_ category: ConsentCategory) -> Bool {
        states[category] ?? false
    }

    public func setEnabled(_ enabled: Bool, for category: ConsentCategory) {
        states[category] = enabled
    }

    public func allStates() -> [ConsentCategory: Bool] {
        states
    }
}
