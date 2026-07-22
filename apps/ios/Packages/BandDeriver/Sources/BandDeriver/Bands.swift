import Foundation

// MARK: - Canonical band enums (docs/00_FOUNDATION.md §5)
//
// Exact string spellings are pinned by the foundation doc and mirrored here
// via `rawValue` for JSON encoding. Do not rename cases or change spellings
// without updating the foundation doc and every dependent contract.

/// HRV-vs-baseline + resting-HR-trend derived recovery band.
public enum RecoveryBand: String, Codable, Equatable, Sendable, CaseIterable {
    case low
    case moderate
    case high
}

/// Sleep duration + stage distribution derived band.
public enum SleepQualityBand: String, Codable, Equatable, Sendable, CaseIterable {
    case poor
    case fair
    case good
}

/// Recent workouts/steps/active-energy vs baseline derived band.
public enum ActivityBand: String, Codable, Equatable, Sendable, CaseIterable {
    case sedentary
    case moderate
    case active
}

// MARK: - Output type

/// The three on-device health bands, and nothing else.
///
/// Privacy defense-in-depth (docs/00_FOUNDATION.md §8: "raw HealthKit
/// samples or timelines" must NEVER be sent to Gloo or YouVersion): this
/// type is declared with exactly three stored properties, and every stored
/// property's type is one of the three closed band enums above. There is
/// no numeric, Date, or String storage anywhere on this type, so it is
/// *structurally* impossible for a raw HRV/HR/sleep/step/energy value (or a
/// timestamp) to hide inside a `HealthBands` value — the compiler forbids
/// it. This is verified by a reflection-based unit test in
/// `HealthBandsShapeTests` that fails if a non-enum field is ever added.
///
/// If you need to add a new signal category (e.g. `communicationLoad` per
/// §5), add a new closed enum for it following the same pattern — never add
/// a raw numeric/Date/String field to this struct.
public struct HealthBands: Codable, Equatable, Sendable {
    public let recovery: RecoveryBand
    public let sleepQuality: SleepQualityBand
    public let activity: ActivityBand

    public init(
        recovery: RecoveryBand,
        sleepQuality: SleepQualityBand,
        activity: ActivityBand
    ) {
        self.recovery = recovery
        self.sleepQuality = sleepQuality
        self.activity = activity
    }
}

/// The result of a real derivation run, where any band may be **absent**.
///
/// `nil` means "no evidence for this category" — either the input carried
/// no samples for it (HealthKit denied/empty, category not queried because
/// consent is off) or its queries failed. A `nil` band must be *omitted*
/// downstream, never replaced with a fabricated neutral value: per
/// docs/00_FOUNDATION.md §9 bands are "where your body is today, never a
/// verdict," and a moderate/fair/sedentary invented from zero evidence is
/// exactly the verdict-from-nothing the improvement review (docs/14 §1.8)
/// forbids.
///
/// Same structural privacy guarantee as `HealthBands` (see its doc
/// comment): every stored property is an Optional of one of the three
/// closed band enums — no numeric, Date, or String storage can hide here.
public struct DerivedBands: Codable, Equatable, Sendable {
    public let recovery: RecoveryBand?
    public let sleepQuality: SleepQualityBand?
    public let activity: ActivityBand?

    public init(
        recovery: RecoveryBand?,
        sleepQuality: SleepQualityBand?,
        activity: ActivityBand?
    ) {
        self.recovery = recovery
        self.sleepQuality = sleepQuality
        self.activity = activity
    }

    /// True when no category produced a band — i.e. there is nothing
    /// honest to upload at all.
    public var isEmpty: Bool {
        recovery == nil && sleepQuality == nil && activity == nil
    }
}
