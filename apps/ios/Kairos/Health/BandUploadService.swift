import Foundation
import BandDeriver

/// Outcome of a single `BandUploadService.refreshAndUpload()` run — surfaced
/// to the UI (manual "refresh now" button on Home) and used by tests to
/// assert the graceful-degradation behavior issue #37 asks for.
///
/// `DerivedBands` (not `HealthBands`) carries the derived result as of
/// issue #70: any category withheld by consent or lacking HealthKit
/// evidence is `nil` here, never a fabricated verdict — this is the same
/// value that gets uploaded (or, for `.uploadFailed`, would have been
/// uploaded), so `DataLedger` can snapshot exactly what was (or would have
/// been) sent rather than reconstructing it from current consent state.
public enum BandUploadOutcome: Equatable, Sendable {
    /// HealthKit read + upload both succeeded. `DerivedBands` may still be
    /// partially or fully empty (every enabled category legitimately had no
    /// evidence) — an upload of an all-omitted payload is not an error.
    case uploaded(DerivedBands)
    /// HealthKit read failed or is unavailable — the app continues in
    /// calendar-only mode (no bands uploaded this run), which is NOT a
    /// crash and NOT treated as an error by callers.
    case skippedNoHealthData
    /// HealthKit read succeeded (bands derived) but the network upload
    /// failed — bands stay on-device; the next scheduled/manual attempt
    /// will retry. Also non-fatal. Surfaced to the user as "derived on
    /// device, not sent" (issue #70's ledger-truthfulness requirement) —
    /// never as if it had been uploaded.
    case uploadFailed(DerivedBands, BandUploadError)
}

/// Orchestrates the full morning band pipeline (issue #37 / EPIC E):
/// read HealthKit-shaped samples -> derive the three on-device bands via
/// `BandDeriver`'s pure functions -> POST them to the backend. This is the
/// single call site both the `BGAppRefreshTask` background job and the
/// manual "Refresh now" button on Home invoke, so their behavior (including
/// graceful degradation) is identical and only tested once.
///
/// Every failure mode degrades gracefully per issue #37's acceptance
/// criteria ("Tolerates failure (backend degrades to calendar-only)"):
/// a denied/unavailable/erroring HealthKit read never throws out of this
/// method — it resolves to `.skippedNoHealthData` so the app keeps running
/// in calendar-only mode. A network/upload failure after a successful read
/// similarly never throws — it resolves to `.uploadFailed` so the derived
/// bands are not silently lost from view (callers can log/retry) without
/// crashing the background task or the UI action.
@MainActor
public final class BandUploadService: ObservableObject {
    private let healthReader: any HealthSampleReading
    private let uploadClient: any BandUploading
    private let consentStore: any ConsentStore
    private let calendar: Calendar
    private let dateProvider: () -> Date

    @Published public private(set) var lastOutcome: BandUploadOutcome?
    @Published public private(set) var lastAttemptAt: Date?
    @Published public private(set) var isRefreshing = false

    /// The exact `BandUploadRequest` sent (or attempted) on the most recent
    /// run — `nil` if no request was ever built (e.g. `.skippedNoHealthData`,
    /// or every category was withheld/empty and there was nothing honest to
    /// send). Issue #70's ledger-truthfulness fix reads this directly rather
    /// than reconstructing a request from `lastOutcome` + current consent
    /// state, so the ledger always reflects what was *actually* sent (or
    /// would have been sent, for an upload failure) at the moment of
    /// upload — never a re-filtered guess using consent as of whenever the
    /// ledger happens to be viewed.
    @Published public private(set) var lastSentRequest: BandUploadRequest?

    public init(
        healthReader: any HealthSampleReading,
        uploadClient: any BandUploading,
        consentStore: any ConsentStore,
        calendar: Calendar = .current,
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.healthReader = healthReader
        self.uploadClient = uploadClient
        self.consentStore = consentStore
        self.calendar = calendar
        self.dateProvider = dateProvider
    }

    /// Runs the full read -> derive -> upload pipeline once. Safe to call
    /// from both the `BGAppRefreshTask` handler and the manual "Refresh
    /// now" button — never throws (see type doc); the outcome is both
    /// returned and published via `lastOutcome` for SwiftUI observers.
    ///
    /// Consent-gated end to end, with two independent layers (issue #70 /
    /// docs/14_IMPROVEMENT_REVIEW.md §1.8):
    ///   1. **Upstream**: a category the user has turned off in
    ///      `ConsentStore` is never even queried from HealthKit (via the
    ///      `enabledCategories` set passed to `healthReader.readTodayInput`)
    ///      — the real `HealthKitSampleReader` honors this by skipping the
    ///      underlying HK queries entirely.
    ///   2. **Downstream (defense-in-depth)**: after deriving, any category
    ///      not in `enabledCategories` is force-omitted from the result
    ///      before it's ever built into a request or uploaded — this holds
    ///      even against a `HealthSampleReading` conformance that doesn't
    ///      fully honor `enabledCategories` (e.g. a naive fake/fixture
    ///      reader that returns the same canned input regardless of what
    ///      was requested), so a consent violation can never reach the wire
    ///      even if the upstream gate is imperfect. The wire payload only
    ///      ever contains categories that are both consented *and* had real
    ///      HealthKit evidence.
    @discardableResult
    public func refreshAndUpload() async -> BandUploadOutcome {
        isRefreshing = true
        defer { isRefreshing = false }

        let enabledCategories = enabledHealthCategories()

        let outcome: BandUploadOutcome
        var sentRequest: BandUploadRequest?
        do {
            let input = try await healthReader.readTodayInput(enabledCategories: enabledCategories)
            let rawDerivedBands = BandDeriver.deriveDerivedBands(from: input)
            // Downstream consent re-assertion (see doc comment above) —
            // never trust the reader alone to have honored the requested
            // category set.
            let derivedBands = DerivedBands(
                recovery: enabledCategories.contains(.recovery) ? rawDerivedBands.recovery : nil,
                sleepQuality: enabledCategories.contains(.sleepQuality) ? rawDerivedBands.sleepQuality : nil,
                activity: enabledCategories.contains(.activity) ? rawDerivedBands.activity : nil
            )
            let request = BandUploadRequest(date: todayDateString(), derivedBands: derivedBands)
            sentRequest = request
            do {
                try await uploadClient.upload(request)
                outcome = .uploaded(derivedBands)
            } catch let uploadError as BandUploadError {
                outcome = .uploadFailed(derivedBands, uploadError)
            } catch {
                outcome = .uploadFailed(derivedBands, .network(error.localizedDescription))
            }
        } catch {
            // HealthKit read failed, was denied, or the store is
            // unavailable (simulator without health data, permission
            // denied, etc.) — degrade to calendar-only mode rather than
            // propagating. This is the graceful-degradation path issue #37
            // explicitly asks to verify without a real device.
            outcome = .skippedNoHealthData
            sentRequest = nil
        }

        lastOutcome = outcome
        lastAttemptAt = dateProvider()
        // Only a genuinely-sent-or-attempted request is recorded — an
        // `.uploaded`/`.uploadFailed` outcome always has one (even an
        // all-omitted request is still "what was sent"); `.skippedNoHealthData`
        // never does, since nothing was derived at all.
        lastSentRequest = sentRequest
        return outcome
    }

    /// Maps `ConsentStore`'s four `ConsentCategory` cases to the three
    /// `HealthCategory` cases `HealthSampleReading` understands (calendar
    /// has no HealthKit analog, so it's simply not part of this set).
    /// Deliberately re-read on every call (not cached) so a consent toggle
    /// flipped between two refreshes takes effect on the very next one,
    /// with no restart/re-sync step required.
    private func enabledHealthCategories() -> Set<HealthCategory> {
        var enabled: Set<HealthCategory> = []
        if consentStore.isEnabled(.recovery) { enabled.insert(.recovery) }
        if consentStore.isEnabled(.sleep) { enabled.insert(.sleepQuality) }
        if consentStore.isEnabled(.activity) { enabled.insert(.activity) }
        return enabled
    }

    private func todayDateString() -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: dateProvider())
    }
}
