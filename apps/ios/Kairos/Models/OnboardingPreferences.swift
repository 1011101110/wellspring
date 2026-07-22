import Foundation

/// Tradition enum — exact spellings pinned by docs/00_FOUNDATION.md §7.
/// Default `general`.
///
/// `anglican` and `orthodox` added by issue #192 (K6). Case order is the
/// picker's display order (both pickers iterate `allCases`), so `general` stays
/// last as the catch-all and the two new values sit with the other liturgical
/// traditions rather than being appended as an afterthought.
///
/// The enum is explicitly CAPPED at these six (#192): finer denominational
/// variation is carried by the practice toggles (lectio, liturgical seasons,
/// stillness, sabbath), not by lengthening this picker. `displayName`'s switch
/// is exhaustive and unqualified by design — no `default:` case — so adding a
/// value here is a compile error until it is given a label, rather than a
/// silent fallback.
public enum Tradition: String, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case evangelical
    case catholic
    case mainline
    case anglican
    case orthodox
    case general

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .evangelical: return "Evangelical"
        case .catholic: return "Catholic"
        case .mainline: return "Mainline"
        // "Anglican / Episcopal" — the same tradition is named differently in
        // the UK and the US, and a user who calls themselves Episcopalian
        // should not have to guess that `anglican` is their row.
        case .anglican: return "Anglican / Episcopal"
        case .orthodox: return "Orthodox"
        case .general: return "General"
        }
    }
}

/// Duration preference, docs/05_UX_FLOWS.md §2 screen 5: auto / 2 / 5 / 10 /
/// 15 min (mirrors the `format` field's ~spoken-minute targets from
/// docs/00_FOUNDATION.md §6: micro≈2, short≈5, standard≈10, extended≈15+).
public enum DurationPreference: String, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case auto
    case micro
    case short
    case standard
    case extended

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .auto: return "Auto"
        case .micro: return "2 min"
        case .short: return "5 min"
        case .standard: return "10 min"
        case .extended: return "15 min"
        }
    }
}

/// Licensed translation choice. docs/00_FOUNDATION.md §4.3 pins the
/// verified-live catalog on our YouVersion app key; NIV is NOT on our key
/// as of 2026-07-02, so BSB (our verified default) is the default here,
/// not NIV — the foundation doc wins over any stale UX-doc mention of NIV.
public enum TranslationChoice: String, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case bsb
    case asv
    case webus

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .bsb: return "Berean Standard Bible (BSB)"
        case .asv: return "American Standard Version (ASV)"
        case .webus: return "World English Bible (WEBUS)"
        }
    }

    /// YouVersion numeric version id, docs/00_FOUNDATION.md §4.3.
    public var versionId: Int {
        switch self {
        case .bsb: return 3034
        case .asv: return 12
        case .webus: return 206
        }
    }
}

/// Voice choice for TTS playback (docs/05_UX_FLOWS.md §2 screen 5: "2-3
/// choices with 3-s preview"). Preview audio playback is out of scope for
/// this onboarding scaffold (no live TTS pipeline wired to iOS yet); the
/// selection itself is captured and persisted like every other preference.
public enum VoiceChoice: String, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case warm
    case calm
    case bright

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .warm: return "Warm"
        case .calm: return "Calm"
        case .bright: return "Bright"
        }
    }
}

/// Stillness (docs/14_IMPROVEMENT_REVIEW.md §5.2): after the verse — and
/// again after the prayer — the voice speaks a hand-off, then genuine
/// encoded silence, then a gentle re-entry. `off` preserves today's
/// behavior exactly and is the default.
public enum StillnessPreference: String, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case off
    case brief
    case full

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .off: return "Off"
        case .brief: return "Brief (15s)"
        case .full: return "Full (45s)"
        }
    }
}

public enum Weekday: Int, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case monday = 2, tuesday = 3, wednesday = 4, thursday = 5, friday = 6, saturday = 7, sunday = 1

    public var id: Int { rawValue }

    /// Unabbreviated name, used as the accessibility label of each day
    /// circle (K3, #189).
    ///
    /// The circles are drawn as single letters — M T W T F S S — which is
    /// legible to the eye because position disambiguates the two Ts and the
    /// two Ss. Spoken aloud that cue is gone entirely: "T, selected. T, not
    /// selected." is unusable. VoiceOver gets the whole word; only the
    /// pixels get the abbreviation.
    public var fullName: String {
        switch self {
        case .monday: return "Monday"
        case .tuesday: return "Tuesday"
        case .wednesday: return "Wednesday"
        case .thursday: return "Thursday"
        case .friday: return "Friday"
        case .saturday: return "Saturday"
        case .sunday: return "Sunday"
        }
    }

    /// The single character drawn inside the circle (K3, #189). Deliberately
    /// derived from `fullName` rather than typed out again, so a day can
    /// never end up with a letter that disagrees with its name.
    public var initial: String {
        String(fullName.prefix(1))
    }

    /// Display order, Mon...Sun.
    ///
    /// The raw values follow `Calendar.weekday` (Sunday = 1), which is the
    /// wire format the backend's `active_days` gate reads (#188) — but it is
    /// not the order a workday-oriented product should present. Both
    /// preference screens previously carried their own private `orderIndex`
    /// switch to re-sort into this order; it lives here now so the two
    /// screens cannot drift apart, and so #189's circle row has exactly one
    /// definition of "left to right".
    public static let mondayFirst: [Weekday] = [
        .monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday,
    ]

    /// Default onboarding selection: Mon-Fri, per docs/05_UX_FLOWS.md §2
    /// screen 5 "days (Mon–Fri)".
    public static let weekdays: Set<Weekday> = [.monday, .tuesday, .wednesday, .thursday, .friday]
}

/// A *name* for a day set, not an independent setting (K2, issue #188).
///
/// Before #188 both `cadence` and `active_days` were stored and read by
/// nothing (docs/03 §10, issue #193). #188 makes `active_days` the value
/// the backend daily run actually consumes, which forces the question the
/// two fields had been able to dodge: they overlap, and they can
/// contradict — `cadence: daily` alongside Mon–Fri is not a corner case,
/// it is the stored default of every row.
///
/// The model, matching `cadenceForActiveDays` in shared-contracts: the day
/// set is the truth, and this is derived from it. All seven days is called
/// "Daily", Mon–Fri is "Weekdays", anything else is "Custom". Because it is
/// computed rather than stored (see `OnboardingPreferences.cadence`), a
/// cadence that disagrees with the selected days cannot be constructed,
/// persisted, or synced — the disagreement is unrepresentable rather than
/// merely discouraged.
///
/// `custom` is deliberately not a preset: it is what you *see* when your
/// days match neither preset, never something you set. That is why #189's
/// day circles are the Custom surface rather than a second, redundant
/// control alongside this one.
public enum Cadence: String, CaseIterable, Equatable, Codable, Sendable, Identifiable {
    case daily
    case weekdays
    case custom

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .daily: return "Daily"
        case .weekdays: return "Weekdays"
        case .custom: return "Custom"
        }
    }
}

/// docs/05_UX_FLOWS.md §2 screen 5: "All preloaded with defaults; one
/// screen, grouped." Everything here is editable later from the F7
/// Preferences screen (`PreferencesView`); this is the same model used for
/// the onboarding-time capture (with sensible defaults so "Looks good" is a
/// valid zero-edits action) and for the always-editable F7 screen, and is
/// what `PreferencesStore` persists.
///
/// `Codable` so it round-trips through `UserDefaultsPreferencesStore` (JSON
/// blob) and, later, through the backend sync payload (issue #38's
/// persistence seam) without a second serialization to maintain.
public struct OnboardingPreferences: Equatable, Codable, Sendable {
    public var workdayStartHour: Int
    public var workdayEndHour: Int
    /// The single source of truth for *when* devotionals generate, and the
    /// only half of the days/cadence pair that crosses the wire as a
    /// decision (K2, #188 — the backend daily run reads `active_days` and
    /// nothing else).
    public var days: Set<Weekday>
    public var duration: DurationPreference
    public var tradition: Tradition
    public var translation: TranslationChoice
    public var voice: VoiceChoice
    public var stillness: StillnessPreference
    /// Evening examen cadence (docs/14_IMPROVEMENT_REVIEW.md §5.3): when on,
    /// schedules an additional short evening reflection session alongside
    /// the regular workday devotional. Off by default — opt-in, not a
    /// second devotional forced on every user.
    public var examenEnabled: Bool

    public init(
        workdayStartHour: Int = 9,
        workdayEndHour: Int = 17,
        days: Set<Weekday> = Weekday.weekdays,
        duration: DurationPreference = .auto,
        tradition: Tradition = .general,
        translation: TranslationChoice = .bsb,
        voice: VoiceChoice = .warm,
        stillness: StillnessPreference = .off,
        examenEnabled: Bool = false
    ) {
        self.workdayStartHour = workdayStartHour
        self.workdayEndHour = workdayEndHour
        self.days = days
        self.duration = duration
        self.tradition = tradition
        self.translation = translation
        self.voice = voice
        self.stillness = stillness
        self.examenEnabled = examenEnabled
    }

    /// The default-preloaded value shown when screen 5 first appears, and
    /// the fallback `PreferencesStore.load()` returns before any value has
    /// ever been saved.
    public static let defaults = OnboardingPreferences()

    /// The cadence label for the current `days`, and the preset writer
    /// behind the cadence picker (K2, #188 — see `Cadence`).
    ///
    /// Computed, not stored, and that is the whole design: there is no
    /// second field to fall out of step with `days`, so no migration, no
    /// reconciliation on load, and no way for the UI to show "Daily" while
    /// Mon–Fri is what actually generates. It is also why removing the old
    /// stored `isDailyCadence` is safe for `Codable` round-trips —
    /// previously-persisted blobs simply carry one key nobody decodes any
    /// more, and no key is newly *required*.
    ///
    /// Setting `.custom` is intentionally a no-op rather than an error:
    /// "custom" names a day set that is already whatever the user picked,
    /// so there is nothing to apply. SwiftUI `Picker` bindings must be
    /// total (the picker can hand back any tag it renders), and silently
    /// keeping the current days is the only reading that does not discard
    /// a selection the user made.
    public var cadence: Cadence {
        get {
            if days == Set(Weekday.allCases) { return .daily }
            if days == Weekday.weekdays { return .weekdays }
            return .custom
        }
        set {
            switch newValue {
            case .daily: days = Set(Weekday.allCases)
            case .weekdays: days = Weekday.weekdays
            case .custom: break
            }
        }
    }

    /// Clamps/repairs field values into a state that is always safe to
    /// render and persist:
    ///   - workday hours are clamped to `0...23`
    ///   - if the (clamped) start is not strictly before the end, the end is
    ///     pushed to `start + 1` (wrapping into the same 0...23 clamp), so a
    ///     zero-width or inverted window can never round-trip
    ///   - `days` falls back to `Weekday.weekdays` (Mon-Fri) if left empty —
    ///     an empty day set would silently schedule nothing, which is never
    ///     a valid user intent (P4: skipping means "use the default," not
    ///     "book nothing, forever")
    /// Every other field is a `CaseIterable` enum, so it is valid by
    /// construction and needs no clamping.
    public func validated() -> OnboardingPreferences {
        var copy = self
        copy.workdayStartHour = min(max(workdayStartHour, 0), 23)
        copy.workdayEndHour = min(max(workdayEndHour, 0), 23)
        if copy.workdayStartHour >= copy.workdayEndHour {
            copy.workdayEndHour = min(copy.workdayStartHour + 1, 23)
            if copy.workdayStartHour >= copy.workdayEndHour {
                // Start was already 23 (clamped) — pull start back instead
                // so the window is never zero-width.
                copy.workdayStartHour = max(copy.workdayEndHour - 1, 0)
            }
        }
        if copy.days.isEmpty {
            copy.days = Weekday.weekdays
        }
        return copy
    }
}
