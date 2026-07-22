import XCTest
@testable import Kairos

/// Unit tests for issue #38 (F7 Preferences): the `OnboardingPreferences`
/// model's validation logic, `Codable` round-trip, and the
/// `PreferencesStore` persistence round-trip (save -> load returns exactly
/// what was saved, across a *fresh* store instance simulating relaunch).
final class PreferencesStoreTests: XCTestCase {

    // MARK: - Model defaults (docs/00_FOUNDATION.md §7 exact enum spellings,
    // §4.3 BSB-not-NIV default)

    func test_defaults_matchFoundationDocPinnedValues() {
        let defaults = OnboardingPreferences.defaults
        XCTAssertEqual(defaults.tradition, .general, "docs/00_FOUNDATION.md §7: default tradition is general")
        XCTAssertEqual(defaults.translation, .bsb, "docs/00_FOUNDATION.md §4.3: BSB is the verified-live default, not NIV")
        XCTAssertEqual(defaults.translation.versionId, 3034, "BSB YouVersion id is 3034 per §4.3")
        XCTAssertEqual(defaults.duration, .auto)
        XCTAssertEqual(defaults.days, Weekday.weekdays)
        XCTAssertEqual(defaults.workdayStartHour, 9)
        XCTAssertEqual(defaults.workdayEndHour, 17)
    }

    func test_traditionEnum_exactCasesFromFoundationDoc() {
        // docs/00_FOUNDATION.md §7: `evangelical` · `catholic` · `mainline` ·
        // `anglican` · `orthodox` · `general` (default). No other values, no
        // invented spellings — these raw values are the wire contract with the
        // Postgres `tradition` enum, so a typo here is a 500 on save.
        // `anglican`/`orthodox` added by issue #192; the enum is capped here.
        let rawValues = Set(Tradition.allCases.map(\.rawValue))
        XCTAssertEqual(rawValues, ["evangelical", "catholic", "mainline", "anglican", "orthodox", "general"])
    }

    func test_traditionEnum_everyCaseHasADistinctDisplayName() {
        // #192: a tradition that renders with a missing, duplicated, or
        // placeholder label in the picker is one a user cannot deliberately
        // choose. Guards the `displayName` switch against a case being added
        // and given an empty or copy-pasted label.
        let names = Tradition.allCases.map(\.displayName)
        XCTAssertEqual(Set(names).count, Tradition.allCases.count, "displayName must be unique per tradition")
        XCTAssertFalse(names.contains(where: \.isEmpty), "no tradition may render an empty label")
        XCTAssertEqual(Tradition.anglican.displayName, "Anglican / Episcopal")
        XCTAssertEqual(Tradition.orthodox.displayName, "Orthodox")
    }

    func test_translationChoice_doesNotIncludeNIV() {
        // NIV is not on our YouVersion key (§4.3) — it must never appear as
        // a selectable translation.
        XCTAssertFalse(TranslationChoice.allCases.contains { $0.displayName.contains("NIV") })
        XCTAssertNil(TranslationChoice(rawValue: "niv"))
    }

    // MARK: - validated()

    func test_validated_clampsOutOfRangeHours() {
        var prefs = OnboardingPreferences.defaults
        prefs.workdayStartHour = -5
        prefs.workdayEndHour = 99

        let validated = prefs.validated()

        XCTAssertEqual(validated.workdayStartHour, 0)
        XCTAssertEqual(validated.workdayEndHour, 23)
    }

    func test_validated_invertedWindow_pushesEndAfterStart() {
        var prefs = OnboardingPreferences.defaults
        prefs.workdayStartHour = 14
        prefs.workdayEndHour = 10

        let validated = prefs.validated()

        XCTAssertLessThan(validated.workdayStartHour, validated.workdayEndHour)
        XCTAssertEqual(validated.workdayStartHour, 14)
        XCTAssertEqual(validated.workdayEndHour, 15)
    }

    func test_validated_equalStartAndEnd_repairsToNonZeroWidth() {
        var prefs = OnboardingPreferences.defaults
        prefs.workdayStartHour = 9
        prefs.workdayEndHour = 9

        let validated = prefs.validated()

        XCTAssertLessThan(validated.workdayStartHour, validated.workdayEndHour)
    }

    func test_validated_startClampedTo23_stillProducesNonZeroWidthWindow() {
        var prefs = OnboardingPreferences.defaults
        prefs.workdayStartHour = 23
        prefs.workdayEndHour = 23

        let validated = prefs.validated()

        XCTAssertLessThan(validated.workdayStartHour, validated.workdayEndHour)
        XCTAssertEqual(validated.workdayEndHour, 23)
    }

    func test_validated_emptyDays_fallsBackToWeekdays() {
        var prefs = OnboardingPreferences.defaults
        prefs.days = []

        let validated = prefs.validated()

        XCTAssertEqual(validated.days, Weekday.weekdays, "An empty day set is never a valid schedule — must fall back")
    }

    func test_validated_nonEmptyCustomDays_preserved() {
        var prefs = OnboardingPreferences.defaults
        prefs.days = [.saturday]

        let validated = prefs.validated()

        XCTAssertEqual(validated.days, [.saturday])
    }

    func test_validated_alreadyValidPreferences_isUnchanged() {
        let prefs = OnboardingPreferences.defaults
        XCTAssertEqual(prefs.validated(), prefs)
    }

    // MARK: - Cadence as a label over `days` (K2, #188)

    func test_cadence_isDerivedFromTheSelectedDays() {
        var prefs = OnboardingPreferences.defaults

        prefs.days = Set(Weekday.allCases)
        XCTAssertEqual(prefs.cadence, .daily)

        prefs.days = Weekday.weekdays
        XCTAssertEqual(prefs.cadence, .weekdays)

        prefs.days = [.saturday, .sunday]
        XCTAssertEqual(prefs.cadence, .custom)
    }

    func test_defaults_reportWeekdaysCadence_notDaily() {
        // The pre-#188 stored pair said `cadence: daily` while listing
        // Mon–Fri. The onboarding default is, and has always been, Mon–Fri
        // — so "Weekdays" is what the user should be told they picked.
        XCTAssertEqual(OnboardingPreferences.defaults.days, Weekday.weekdays)
        XCTAssertEqual(OnboardingPreferences.defaults.cadence, .weekdays)
    }

    func test_settingCadence_writesTheDaySetItStandsFor() {
        // This is what makes the picker a preset rather than a second,
        // ignorable setting: choosing Daily has to actually change which
        // days generate.
        var prefs = OnboardingPreferences.defaults

        prefs.cadence = .daily
        XCTAssertEqual(prefs.days, Set(Weekday.allCases))

        prefs.cadence = .weekdays
        XCTAssertEqual(prefs.days, Weekday.weekdays)
    }

    func test_settingCadenceCustom_leavesTheSelectedDaysAlone() {
        // "Custom" names a day set that is already whatever the user
        // picked; there is nothing to apply, and inventing a set here
        // would discard their selection.
        var prefs = OnboardingPreferences.defaults
        prefs.days = [.tuesday, .thursday]

        prefs.cadence = .custom

        XCTAssertEqual(prefs.days, [.tuesday, .thursday])
        XCTAssertEqual(prefs.cadence, .custom)
    }

    func test_deselectingADay_flipsCadenceToCustomWithNoExtraWiring() {
        // The property that makes a contradictory pair unrepresentable:
        // the day rows (#189's circles, once they land) and the cadence
        // picker are two views of one value, not two values to keep in
        // sync.
        var prefs = OnboardingPreferences.defaults
        prefs.cadence = .daily
        XCTAssertEqual(prefs.cadence, .daily)

        prefs.days.remove(.sunday)

        XCTAssertEqual(prefs.cadence, .custom)
    }

    // MARK: - Codable round-trip

    func test_codable_roundTrip_preservesAllFields() throws {
        var prefs = OnboardingPreferences.defaults
        prefs.workdayStartHour = 7
        prefs.workdayEndHour = 16
        prefs.days = [.tuesday, .thursday, .saturday]
        prefs.duration = .extended
        prefs.tradition = .catholic
        prefs.translation = .asv
        prefs.voice = .bright
        prefs.examenEnabled = true

        let data = try JSONEncoder().encode(prefs)
        let decoded = try JSONDecoder().decode(OnboardingPreferences.self, from: data)

        XCTAssertEqual(decoded, prefs)
    }

    // MARK: - UserDefaultsPreferencesStore persistence round-trip

    /// Simulates a relaunch: `save` on one store instance, then `load` on a
    /// *brand-new* store instance backed by the same `UserDefaults` suite —
    /// proves persistence survives past any single store object's lifetime,
    /// not just its in-memory state.
    func test_userDefaultsStore_saveThenLoadFromFreshInstance_roundTrips() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        var prefs = OnboardingPreferences.defaults
        prefs.workdayStartHour = 6
        prefs.workdayEndHour = 12
        prefs.days = [.monday, .wednesday, .friday]
        prefs.duration = .short
        prefs.tradition = .mainline
        prefs.translation = .webus
        prefs.voice = .calm

        let writer = UserDefaultsPreferencesStore(defaults: defaults)
        writer.save(prefs)

        // Fresh instance -- nothing shared but the underlying UserDefaults
        // suite, exactly as a real app relaunch would only share disk state.
        let reader = UserDefaultsPreferencesStore(defaults: defaults)
        let loaded = reader.load()

        XCTAssertEqual(loaded, prefs)
    }

    func test_userDefaultsStore_load_beforeAnySave_returnsDefaults() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let sut = UserDefaultsPreferencesStore(defaults: defaults)

        XCTAssertEqual(sut.load(), .defaults)
    }

    func test_userDefaultsStore_save_persistsValidatedNotRawValue() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        var prefs = OnboardingPreferences.defaults
        prefs.days = [] // invalid; validated() should repair before persisting

        let sut = UserDefaultsPreferencesStore(defaults: defaults)
        let returned = sut.save(prefs)

        XCTAssertEqual(returned.days, Weekday.weekdays)
        XCTAssertEqual(sut.load().days, Weekday.weekdays, "The repaired value, not the raw invalid input, must be what's persisted")
    }

    func test_userDefaultsStore_corruptStoredData_fallsBackToDefaultsRatherThanCrashing() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(Data([0xDE, 0xAD, 0xBE, 0xEF]), forKey: "com.kairos.preferences.v1")

        let sut = UserDefaultsPreferencesStore(defaults: defaults)

        XCTAssertEqual(sut.load(), .defaults)
    }

    func test_userDefaultsStore_overwrite_replacesPreviousValue() {
        let suiteName = "com.kairos.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sut = UserDefaultsPreferencesStore(defaults: defaults)

        var first = OnboardingPreferences.defaults
        first.tradition = .evangelical
        sut.save(first)

        var second = OnboardingPreferences.defaults
        second.tradition = .catholic
        sut.save(second)

        XCTAssertEqual(sut.load().tradition, .catholic)
    }

    // MARK: - InMemoryPreferencesStore (Demo Mode / previews / tests)

    func test_inMemoryStore_saveThenLoad_roundTrips() {
        let sut = InMemoryPreferencesStore()
        var prefs = OnboardingPreferences.defaults
        prefs.voice = .bright

        sut.save(prefs)

        XCTAssertEqual(sut.load().voice, .bright)
    }

    func test_inMemoryStore_customInitialValue_isReturnedByLoad() {
        var initial = OnboardingPreferences.defaults
        initial.tradition = .mainline
        let sut = InMemoryPreferencesStore(initial: initial)

        XCTAssertEqual(sut.load().tradition, .mainline)
    }

    // MARK: - PreferencesViewModel

    @MainActor
    func test_preferencesViewModel_init_loadsFromStore() {
        var initial = OnboardingPreferences.defaults
        initial.tradition = .evangelical
        let store = InMemoryPreferencesStore(initial: initial)

        let sut = PreferencesViewModel(store: store)

        XCTAssertEqual(sut.preferences.tradition, .evangelical)
    }

    @MainActor
    func test_preferencesViewModel_fieldChange_persistsToStoreImmediately() {
        let store = InMemoryPreferencesStore()
        let sut = PreferencesViewModel(store: store)

        sut.preferences.tradition = .catholic

        XCTAssertEqual(store.load().tradition, .catholic, "Every field edit should write through, not require an explicit Save action")
    }

    /// Replaces the old `setDay(_:isOn:)` test, removed with that method in
    /// K3 (#189): the circle row binds `$viewModel.preferences.days`
    /// directly, so what has to be proven is that mutating the day set
    /// through the binding still trips the `preferences` `didSet` and
    /// write-through save — the same path Duration and Tradition use, and
    /// the one a tap on a circle now takes.
    @MainActor
    func test_preferencesViewModel_dayMutationThroughBinding_persistsToStore() {
        let store = InMemoryPreferencesStore()
        let sut = PreferencesViewModel(store: store)

        sut.preferences.days.insert(.sunday)

        XCTAssertTrue(sut.preferences.days.contains(.sunday))
        XCTAssertTrue(store.load().days.contains(.sunday), "A day edit must write through without an explicit Save action")

        sut.preferences.days.remove(.sunday)

        XCTAssertFalse(store.load().days.contains(.sunday), "Deselecting must persist too, not just selecting")
    }

    @MainActor
    func test_preferencesViewModel_separateInstanceOverSameStore_seesPersistedEdit() {
        // Simulates "edit on Preferences tab, navigate away, come back" —
        // a second view model instance backed by the same store must see
        // the previous instance's write.
        let store = InMemoryPreferencesStore()
        let first = PreferencesViewModel(store: store)
        first.preferences.duration = .extended

        let second = PreferencesViewModel(store: store)

        XCTAssertEqual(second.preferences.duration, .extended)
    }

    // MARK: - Day circle selection rule (K3, #189)

    func test_weekdaySelection_tappingUnselectedDay_selectsIt() {
        let result = WeekdaySelection.toggling(.saturday, in: Weekday.weekdays)

        XCTAssertEqual(result, Weekday.weekdays.union([.saturday]))
    }

    func test_weekdaySelection_tappingSelectedDay_deselectsIt() {
        let result = WeekdaySelection.toggling(.friday, in: Weekday.weekdays)

        XCTAssertEqual(result, [.monday, .tuesday, .wednesday, .thursday])
    }

    /// The core of #189's last-day rule. `nil` is "refused", and the caller
    /// leaves the set untouched.
    ///
    /// This is deliberately NOT the `validated()` behavior tested above.
    /// `validated()` repairs an already-empty set to Mon–Fri, which is right
    /// for a corrupt blob arriving from disk and wrong for a tap: the user
    /// would tap their one selected day and get five back. Refusing here
    /// means the empty set — a 400 from the API since #188 — never exists in
    /// the first place.
    func test_weekdaySelection_deselectingTheOnlySelectedDay_isRefused() {
        XCTAssertNil(
            WeekdaySelection.toggling(.wednesday, in: [.wednesday]),
            "Emptying the day set means 'never generate again, silently' — the tap is refused, not repaired afterwards"
        )
    }

    func test_weekdaySelection_deselectingWithTwoSelected_isAllowed() {
        // The boundary immediately above the refusal: two selected days must
        // still be reducible to one.
        let result = WeekdaySelection.toggling(.wednesday, in: [.wednesday, .friday])

        XCTAssertEqual(result, [.friday])
    }

    func test_weekdaySelection_selectingWhenOnlyOneDayIsSelected_isAllowed() {
        // The guard must constrain deselection only — a single-day user
        // adding a second day is the normal way out of the locked state.
        let result = WeekdaySelection.toggling(.friday, in: [.wednesday])

        XCTAssertEqual(result, [.wednesday, .friday])
    }

    /// Deselecting a day must flip the derived cadence label to Custom with
    /// no extra wiring — the property #188 made computed, exercised through
    /// the operation #189's circles perform.
    func test_weekdaySelection_deselectingADay_flipsDerivedCadenceToCustom() {
        var prefs = OnboardingPreferences.defaults
        XCTAssertEqual(prefs.cadence, .weekdays)

        prefs.days = WeekdaySelection.toggling(.wednesday, in: prefs.days) ?? prefs.days

        XCTAssertEqual(prefs.cadence, .custom)
    }

    // MARK: - Weekday display metadata (K3, #189)

    func test_weekdayMondayFirst_coversEveryDayInDisplayOrder() {
        XCTAssertEqual(
            Weekday.mondayFirst,
            [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]
        )
        XCTAssertEqual(
            Set(Weekday.mondayFirst), Set(Weekday.allCases),
            "The circle row renders `mondayFirst`, so a day missing from it would be unreachable in the UI"
        )
    }

    func test_weekdayInitials_renderTheExpectedMTWTFSSRow() {
        XCTAssertEqual(
            Weekday.mondayFirst.map(\.initial),
            ["M", "T", "W", "T", "F", "S", "S"]
        )
    }

    /// The two Ts and the two Ss are indistinguishable by letter, so the
    /// spoken label must be the full word — this is the assertion that
    /// protects VoiceOver users from a row of ambiguous single characters.
    func test_weekdayFullNames_areUnambiguousForVoiceOver() {
        let names = Weekday.mondayFirst.map(\.fullName)

        XCTAssertEqual(
            names,
            ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        )
        XCTAssertEqual(Set(names).count, 7, "Every circle must announce a distinct name")
    }
}
