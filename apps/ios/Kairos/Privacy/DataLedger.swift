import Foundation
import BandDeriver

/// A single, plain-language record of exactly what was sent to Kairos for
/// one day's devotional — docs/05_UX_FLOWS.md §3.1 "Data & Privacy" row's
/// "data ledger": *"What we sent today: 'low recovery, fair sleep, heavy
/// day', 10:02 AM"*, and docs/04_DATA_PRIVACY_SECURITY.md §1 rule 4 ("Show
/// your work").
///
/// Every band is surfaced as its gentle phrase (`BandPhrase`), never a raw
/// enum/number (P5) — the whole point of the ledger is to make the
/// silhouette Gloo receives legible to the user in the same non-clinical
/// language the rest of the app uses, not to expose the wire format.
///
/// Truthfulness (issue #70 / docs/14_IMPROVEMENT_REVIEW.md §1.8): this type
/// is built directly from the *actual* `BandUploadRequest` sent (or
/// attempted) at upload time — never re-derived from current `ConsentStore`
/// state — so a category the user disables *after* today's upload still
/// correctly shows as sent (what actually left the device), and a category
/// that was withheld/had no evidence *at* upload time correctly shows as
/// withheld, regardless of what the toggle reads right now.
public struct DataLedgerEntry: Equatable, Sendable {
    public let sentAt: Date
    /// `nil` when that category was withheld (consent off) or had no
    /// HealthKit evidence at upload time — rendered as "not shared today"
    /// rather than omitted, so a user can see *that* a category was
    /// withheld, not just silently miss it.
    public let recovery: RecoveryBand?
    public let sleepQuality: SleepQualityBand?
    public let activity: ActivityBand?
    public let busyness: String?
    public let communicationLoad: String?
    /// `false` when the network upload itself failed — the bands above were
    /// derived on-device but never actually left the phone. Rendered as
    /// "derived on device, not sent" rather than implying the upload
    /// succeeded (issue #70's ledger-truthfulness requirement).
    public let wasUploaded: Bool

    public init(
        sentAt: Date,
        recovery: RecoveryBand?,
        sleepQuality: SleepQualityBand?,
        activity: ActivityBand?,
        busyness: String?,
        communicationLoad: String?,
        wasUploaded: Bool = true
    ) {
        self.sentAt = sentAt
        self.recovery = recovery
        self.sleepQuality = sleepQuality
        self.activity = activity
        self.busyness = busyness
        self.communicationLoad = communicationLoad
        self.wasUploaded = wasUploaded
    }

    /// The five gentle-phrase lines shown on screen, in the canonical band
    /// order from docs/00_FOUNDATION.md §5 (recovery, sleepQuality,
    /// activity, busyness, communicationLoad). A `nil` band renders as "not
    /// shared today" if the upload succeeded, or "derived on device, not
    /// sent" if it didn't (see `wasUploaded`'s doc comment) — never dropped
    /// from the list entirely.
    public var phraseLines: [(label: String, phrase: String)] {
        let withheldLabel = wasUploaded ? "not shared today" : "derived on device, not sent"
        return [
            ("Recovery", recovery.map(BandPhrase.recoveryPhrase) ?? withheldLabel),
            ("Sleep", sleepQuality.map(BandPhrase.sleepQualityPhrase) ?? withheldLabel),
            ("Activity", activity.map(BandPhrase.activityPhrase) ?? withheldLabel),
            ("Your day", busyness.map(BandPhrase.busynessPhrase) ?? withheldLabel),
            ("Messages", BandPhrase.communicationLoadPhrase(communicationLoad)),
        ]
    }
}

/// Abstraction over "where today's ledger entry comes from." No backend
/// endpoint for reading back a per-day sent-record exists yet in
/// docs/03_API_INTEGRATION_SPEC.md (only `POST /v1/bands` — write, not
/// read-back) — so the real, local implementation reconstructs the ledger
/// from the same `BandUploadService.lastOutcome` the Home screen's manual
/// "Refresh now" flow already populates (issue #37), filtered through
/// current `ConsentStore` state so a category the user has since turned
/// off does not keep appearing as "sent" even if it was sent earlier today.
/// A future `GET /v1/bands/today`-shaped endpoint could replace this with a
/// real network-backed conformance without changing any view.
public protocol DataLedgerProviding: AnyObject, Sendable {
    /// The most recent entry for "today," or `nil` if nothing has been
    /// sent yet today (docs/05_UX_FLOWS.md §3.1 empty state: "Nothing sent
    /// yet today.").
    @MainActor
    func todayEntry() -> DataLedgerEntry?
}

/// Real implementation: derives today's ledger entry from
/// `BandUploadService.lastSentRequest` — the *actual* request built (and
/// sent, or attempted) at upload time — rather than re-filtering
/// `lastOutcome`'s bands through whatever `ConsentStore` reads right now
/// (issue #70 / docs/14_IMPROVEMENT_REVIEW.md §1.8: "the ledger snapshots
/// the actual sent request... not a consent-filtered reconstruction"). This
/// is what makes the ledger's "what we sent today" claim true even after
/// the user later flips a toggle: a category sent this morning still shows
/// as sent this afternoon, and a category withheld this morning still shows
/// as withheld even if the user turns it on this afternoon (it will show as
/// sent starting with *tomorrow's* upload, once it's actually been sent).
@MainActor
public final class BandUploadLedgerProvider: DataLedgerProviding {
    private let bandUploadService: BandUploadService
    private let calendar: Calendar

    public init(
        bandUploadService: BandUploadService,
        calendar: Calendar = .current
    ) {
        self.bandUploadService = bandUploadService
        self.calendar = calendar
    }

    public func todayEntry() -> DataLedgerEntry? {
        guard let lastAttemptAt = bandUploadService.lastAttemptAt,
              calendar.isDateInToday(lastAttemptAt),
              let request = bandUploadService.lastSentRequest else {
            return nil
        }

        // `.skippedNoHealthData` never has a `lastSentRequest` (nothing was
        // derived at all — see `BandUploadService.refreshAndUpload`'s doc
        // comment), so reaching here always means either `.uploaded` or
        // `.uploadFailed`; `wasUploaded` distinguishes the two for the
        // "derived on device, not sent" vs. "not shared today" copy.
        let wasUploaded: Bool
        switch bandUploadService.lastOutcome {
        case .uploaded:
            wasUploaded = true
        case .uploadFailed:
            wasUploaded = false
        case .skippedNoHealthData, .none:
            wasUploaded = true
        }

        return DataLedgerEntry(
            sentAt: lastAttemptAt,
            recovery: request.recovery.flatMap(RecoveryBand.init(rawValue:)),
            sleepQuality: request.sleepQuality.flatMap(SleepQualityBand.init(rawValue:)),
            activity: request.activity.flatMap(ActivityBand.init(rawValue:)),
            busyness: request.busyness,
            communicationLoad: request.communicationLoad,
            wasUploaded: wasUploaded
        )
    }
}

/// In-memory `DataLedgerProviding` for previews, unit tests, and Demo Mode.
public final class FakeDataLedgerProvider: DataLedgerProviding, @unchecked Sendable {
    public var nextEntry: DataLedgerEntry?

    public init(nextEntry: DataLedgerEntry? = nil) {
        self.nextEntry = nextEntry
    }

    public func todayEntry() -> DataLedgerEntry? {
        nextEntry
    }
}
