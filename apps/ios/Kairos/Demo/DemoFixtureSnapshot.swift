import Foundation
import BandDeriver

/// Decodes the exact JSON shape of `fixtures/snapshots/*.json` (see
/// `fixtures/snapshots/low_poor_heavy.json`) — the shared repo-root fixture
/// corpus produced for the backend track and reused verbatim here so the
/// iOS demo path shows the *same* content a judge could cross-check against
/// that file, per docs/00_FOUNDATION.md §11 ("Fixture/demo mode is
/// mandatory") and the issue #41 instruction to "load one of the real
/// fixture scenarios ... directly into the app's UI state."
///
/// Field names match the JSON exactly (`fixtureKey`, `devotionalOutput`,
/// `fetchedText`, etc.) so `Codable`'s default synthesis works without a
/// custom `CodingKeys` maintenance burden.
public struct DemoFixtureSnapshot: Codable, Equatable, Sendable {
    public let fixtureKey: String
    public let scenario: String
    public let description: String
    public let bands: FixtureBands
    public let context: FixtureContext
    public let devotionalOutput: FixtureDevotionalOutput

    public struct FixtureBands: Codable, Equatable, Sendable {
        public let recovery: RecoveryBand
        public let sleepQuality: SleepQualityBand
        public let activity: ActivityBand
        public let busyness: String
        public let communicationLoad: String?
        public let distressSignal: Bool
    }

    public struct FixtureContext: Codable, Equatable, Sendable {
        public let timeOfDayBucket: String
        public let durationPreferenceMinutes: Int
        public let tradition: String
        public let translationVersionId: Int
    }

    /// Mirrors 00_FOUNDATION.md §6 `DevotionalOutput`, restricted to the
    /// fields the demo arc actually renders (verse text/attribution,
    /// transcript, prayer, action step, card summary).
    public struct FixtureDevotionalOutput: Codable, Equatable, Sendable {
        public let format: String
        public let theme: String
        public let verses: [FixtureVerse]
        public let devotionalBody: String
        public let cardSummary: String
        public let prayer: String
        public let actionStep: String?
        public let journalingPrompt: String?
    }

    public struct FixtureVerse: Codable, Equatable, Sendable {
        public let usfm: String
        public let versionId: Int
        public let reference: String
        public let fetchedText: String
        public let attribution: String
    }

    /// Derives the on-device `HealthBands` triple (recovery/sleepQuality/
    /// activity) this fixture implies, for reuse by `BandPhrase` — the same
    /// phrase-mapping code path the real HealthKit-derived bands use, so
    /// demo mode exercises production phrasing rather than a demo-only
    /// copy fork.
    public var healthBands: HealthBands {
        HealthBands(recovery: bands.recovery, sleepQuality: bands.sleepQuality, activity: bands.activity)
    }
}

/// Loads a `DemoFixtureSnapshot` from the app bundle's `Fixtures/` resource
/// directory. The JSON files there are byte-for-byte copies of
/// `fixtures/snapshots/*.json` (see that directory's README-equivalent
/// provenance note in 00_FOUNDATION.md §11) — copied in, not
/// reimplemented, so the demo path can never drift from the shared fixture
/// corpus silently.
public enum DemoFixtureLoader {
    public enum LoadError: Error, Equatable {
        case resourceNotFound(String)
        case decodingFailed(String)
    }

    /// Fixture persona used for the F9 judge-facing demo arc (docs/05_UX_FLOWS.md
    /// §8): David, `low_poor_heavy` — recovery=low, sleepQuality=poor,
    /// busyness=heavy.
    public static let davidFixtureName = "low_poor_heavy"

    public static func load(_ name: String = davidFixtureName, bundle: Bundle = .main) throws -> DemoFixtureSnapshot {
        guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: name, withExtension: "json")
        else {
            throw LoadError.resourceNotFound(name)
        }
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(DemoFixtureSnapshot.self, from: data)
        } catch let error as LoadError {
            throw error
        } catch {
            throw LoadError.decodingFailed(String(describing: error))
        }
    }
}
