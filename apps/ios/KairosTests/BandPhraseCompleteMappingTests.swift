import XCTest
import BandDeriver
@testable import Kairos

/// Unit tests for the gentle-phrase mapping added for issue #39's Data &
/// Privacy screen (the data ledger's phrase lines): `activityPhrase`,
/// `busynessPhrase`, `communicationLoadPhrase`, and `DataLedgerEntry`'s
/// `phraseLines` derivation. `recoveryPhrase`/`sleepQualityPhrase` are
/// already covered by `BandPhraseTests`.
///
/// This mapping is a pure function from band enum -> display string, so it
/// is tested exhaustively over every case (docs/00_FOUNDATION.md §5's
/// closed enums) with no view/UI dependency at all — exactly the kind of
/// "real, testable pure function" issue #39 calls out as not to be left
/// untested.
final class BandPhraseCompleteMappingTests: XCTestCase {

    // MARK: - activityPhrase (all ActivityBand cases)

    func test_activityPhrase_everyCase_isNonEmptyAndDescriptive() {
        for band in ActivityBand.allCases {
            let phrase = BandPhrase.activityPhrase(band)
            XCTAssertFalse(phrase.isEmpty, "\(band) produced an empty phrase")
        }
    }

    func test_activityPhrase_exactCopy() {
        XCTAssertEqual(BandPhrase.activityPhrase(.active), "you've been moving today")
        XCTAssertEqual(BandPhrase.activityPhrase(.moderate), "a steady amount of movement")
        XCTAssertEqual(BandPhrase.activityPhrase(.sedentary), "today has been a quiet, still day")
    }

    func test_activityPhrase_neverContainsRawEnumOrJudgment() {
        // Tone rule (docs/05_UX_FLOWS.md §3.2): "phrases describe, never
        // judge." A minimal proxy check: the raw enum rawValue string
        // itself, and common judgmental words, never leak into the phrase.
        for band in ActivityBand.allCases {
            let phrase = BandPhrase.activityPhrase(band).lowercased()
            XCTAssertFalse(phrase.contains(band.rawValue), "Phrase for \(band) leaks the raw enum value: \(phrase)")
            for judgmental in ["fail", "bad", "should", "lazy", "unhealthy"] {
                XCTAssertFalse(phrase.contains(judgmental), "Phrase for \(band) contains judgmental language: \(phrase)")
            }
        }
    }

    // MARK: - busynessPhrase (docs/05_UX_FLOWS.md §3.2 pinned copy)

    func test_busynessPhrase_exactCopyFromUXSpec() {
        XCTAssertEqual(BandPhrase.busynessPhrase("light"), "today has room to breathe")
        XCTAssertEqual(BandPhrase.busynessPhrase("moderate"), "a steady day")
        XCTAssertEqual(BandPhrase.busynessPhrase("heavy"), "today looks heavy")
    }

    func test_busynessPhrase_unknownValue_fallsBackGracefully() {
        XCTAssertEqual(BandPhrase.busynessPhrase("garbage"), "calendar-only today")
    }

    // MARK: - communicationLoadPhrase (stretch signal, nullable)

    func test_communicationLoadPhrase_allThreeBands() {
        XCTAssertEqual(BandPhrase.communicationLoadPhrase("light"), "messages have been light")
        XCTAssertEqual(BandPhrase.communicationLoadPhrase("moderate"), "a normal amount of messages")
        XCTAssertEqual(BandPhrase.communicationLoadPhrase("heavy"), "messages have been a lot today")
    }

    func test_communicationLoadPhrase_nil_meansNotConnected() {
        XCTAssertEqual(BandPhrase.communicationLoadPhrase(nil), "not tracked today")
    }

    // MARK: - DataLedgerEntry.phraseLines

    func test_phraseLines_allFiveBandsPresentInCanonicalOrder() {
        let entry = DataLedgerEntry(
            sentAt: Date(),
            recovery: .high,
            sleepQuality: .good,
            activity: .active,
            busyness: "light",
            communicationLoad: "moderate"
        )

        let labels = entry.phraseLines.map(\.label)
        XCTAssertEqual(labels, ["Recovery", "Sleep", "Activity", "Your day", "Messages"])

        let phrases = entry.phraseLines.map(\.phrase)
        XCTAssertEqual(phrases, [
            "your body looks rested",
            "you slept well",
            "you've been moving today",
            "today has room to breathe",
            "a normal amount of messages",
        ])
    }

    func test_phraseLines_neverExposesRawBandValues() {
        // Defense-in-depth for P5 ("bands as gentle phrases, never
        // numbers/scores"): none of the five rendered phrase strings may
        // equal a raw enum rawValue.
        let entry = DataLedgerEntry(
            sentAt: Date(),
            recovery: .low,
            sleepQuality: .poor,
            activity: .sedentary,
            busyness: "heavy",
            communicationLoad: "heavy"
        )
        let rawValues: Set<String> = ["low", "poor", "sedentary", "heavy", "moderate", "high", "good", "fair", "active", "light"]
        for line in entry.phraseLines {
            XCTAssertFalse(rawValues.contains(line.phrase), "\(line.label) phrase '\(line.phrase)' is a bare raw band value, not a gentle phrase")
        }
    }

    func test_phraseLines_nilCategory_rendersNotSharedRatherThanOmitted() {
        let entry = DataLedgerEntry(
            sentAt: Date(),
            recovery: nil,
            sleepQuality: .fair,
            activity: nil,
            busyness: nil,
            communicationLoad: nil
        )

        let byLabel = Dictionary(uniqueKeysWithValues: entry.phraseLines.map { ($0.label, $0.phrase) })
        XCTAssertEqual(byLabel["Recovery"], "not shared today")
        XCTAssertEqual(byLabel["Activity"], "not shared today")
        XCTAssertEqual(byLabel["Your day"], "not shared today")
        XCTAssertEqual(byLabel["Sleep"], "sleep was okay")
        XCTAssertEqual(byLabel["Messages"], "not tracked today")
    }

    /// Issue #70 (docs/14_IMPROVEMENT_REVIEW.md §1.8): an upload failure
    /// must render as "derived on device, not sent" — never implying the
    /// data reached Kairos when it didn't.
    func test_phraseLines_uploadFailed_rendersDerivedOnDeviceNotSent_notNotSharedToday() {
        let entry = DataLedgerEntry(
            sentAt: Date(),
            recovery: .low,
            sleepQuality: nil,
            activity: .sedentary,
            busyness: nil,
            communicationLoad: nil,
            wasUploaded: false
        )

        let byLabel = Dictionary(uniqueKeysWithValues: entry.phraseLines.map { ($0.label, $0.phrase) })
        XCTAssertEqual(byLabel["Sleep"], "derived on device, not sent", "A category with no evidence in a FAILED upload uses the failure-specific copy")
        XCTAssertEqual(byLabel["Recovery"], "your body is asking for gentleness", "A present band still renders its normal gentle phrase regardless of upload outcome")
        XCTAssertEqual(byLabel["Activity"], "today has been a quiet, still day")
    }

    func test_dataLedgerEntry_wasUploaded_defaultsToTrue() {
        // The default keeps every existing call site (and every other test
        // in this file) meaningful without threading the parameter through
        // everywhere a genuinely-successful upload is being modeled.
        let entry = DataLedgerEntry(
            sentAt: Date(), recovery: nil, sleepQuality: nil, activity: nil,
            busyness: nil, communicationLoad: nil
        )
        XCTAssertTrue(entry.wasUploaded)
    }
}
