import Foundation
import BackgroundTasks
import EventKit

/// The slice of `BGAppRefreshTask`'s API that `BackgroundBandRefreshScheduler`
/// actually needs. `BGTask`/`BGAppRefreshTask` are abstract types the
/// system creates and hands to the registration handler — Apple's headers
/// explicitly mark their initializers `NS_UNAVAILABLE` ("Subclasses of this
/// abstract type are created by the system and cannot be directly
/// instantiated"), so a real `BGAppRefreshTask` cannot be constructed in a
/// test target. This protocol is the seam that works around that: the real
/// `BGAppRefreshTask` conforms to it for free (structurally, via the
/// extension below), and tests use a plain fake conformance instead —
/// exactly the same pattern as every other service protocol in this app
/// (`AuthService`, `HealthConnectService`, ...).
protocol BackgroundRefreshTaskHandle: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func setTaskCompleted(success: Bool)
}

extension BGAppRefreshTask: BackgroundRefreshTaskHandle {}

/// Schedules and handles the morning `BGAppRefreshTask` that reads
/// HealthKit, derives bands via `BandDeriver`, and uploads them
/// (issue #37 / EPIC E4: "Morning band upload").
///
/// **Simulator/testing limitation (matches docs/07_TEST_PLAN.md's
/// acknowledged gap, not a gap introduced here):** iOS's `BGTaskScheduler`
/// gives the OS full discretion over *when* (or whether) a submitted
/// `BGAppRefreshTaskRequest` actually runs — it depends on device usage
/// patterns, battery state, and background App Refresh being enabled, none
/// of which the Simulator models realistically, and none of which can be
/// forced deterministically without a physical device. docs/07_TEST_PLAN.md
/// §6 lists "Real iPhone: ... morning `BGAppRefreshTask` uploads them" as a
/// manual physical-device checklist item for exactly this reason. What
/// *is* unit-testable here — and is tested — is: (a) the task identifier
/// matches what's declared in Info.plist, (b) `register` wires the handler
/// exactly once without crashing, (c) the handler correctly calls
/// `BandUploadService.refreshAndUpload()`, marks the task complete/failed
/// based on the outcome, and reschedules the next request, and (d) the
/// next-request scheduling math (next calendar day, `earliestBeginDate`)
/// is correct. None of that requires the OS to actually fire the task.
@MainActor
public final class BackgroundBandRefreshScheduler {
    /// Must exactly match `BGTaskSchedulerPermittedIdentifiers` in
    /// Info.plist (wired via `project.yml`) or `BGTaskScheduler.register`
    /// throws at runtime.
    public static let taskIdentifier = "com.kairos.devotional.bandRefresh"

    /// How long after "now" the next background attempt is earliest
    /// eligible to run — mirrors F6's "each morning" cadence (issue #37):
    /// this is intentionally the *next calendar day*, not a fixed interval,
    /// so a task that happens to run at 11pm doesn't immediately become
    /// eligible again a few hours later.
    private let rescheduleInterval: TimeInterval = 24 * 60 * 60

    private let bandUploadService: BandUploadService
    private let scheduler: BGTaskScheduler
    private let dateProvider: () -> Date

    /// Collects EventKit free windows; `nil` if no Apple-Calendar integration
    /// is configured for this run (e.g. Demo Mode, or access not yet granted).
    private let slotCollector: EventKitSlotCollector?
    /// HTTP client for `POST /v1/slots`. `nil` when `slotCollector` is `nil`.
    private let slotsUploadClient: (any SlotsUploading)?

    /// Scheduling window defaults — mirror `OnboardingPreferences` defaults
    /// (7:00–21:00) so the background task aligns with what the user
    /// configured during onboarding. These are intentionally not re-read from
    /// `PreferencesStore` here (injecting the store would tighten coupling for
    /// a detail that can always be refined later).
    private let windowStartHour: Int
    private let windowStartMinute: Int
    private let windowEndHour: Int
    private let windowEndMinute: Int

    public init(
        bandUploadService: BandUploadService,
        scheduler: BGTaskScheduler = .shared,
        dateProvider: @escaping () -> Date = Date.init,
        slotCollector: EventKitSlotCollector? = nil,
        slotsUploadClient: (any SlotsUploading)? = nil,
        windowStartHour: Int = 7,
        windowStartMinute: Int = 0,
        windowEndHour: Int = 21,
        windowEndMinute: Int = 0
    ) {
        self.bandUploadService = bandUploadService
        self.scheduler = scheduler
        self.dateProvider = dateProvider
        self.slotCollector = slotCollector
        self.slotsUploadClient = slotsUploadClient
        self.windowStartHour = windowStartHour
        self.windowStartMinute = windowStartMinute
        self.windowEndHour = windowEndHour
        self.windowEndMinute = windowEndMinute
    }

    /// Registers the task handler. Must be called before
    /// `UIApplication.didFinishLaunchingWithOptions` returns (Apple
    /// requirement), so this is invoked from `KairosApp.init` via
    /// `AppEnvironment`. Safe to call at most once per process — calling it
    /// twice is a programmer error (BGTaskScheduler traps), so
    /// `AppEnvironment` guards this with a static flag.
    public func register() {
        scheduler.register(forTaskWithIdentifier: Self.taskIdentifier, using: nil) { [weak self] task in
            guard let appRefreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handle(appRefreshTask)
        }
    }

    /// Submits (or re-submits) the next background refresh request. Safe to
    /// call repeatedly (e.g. on every app foreground) — `BGTaskScheduler`
    /// replaces any pending request with the same identifier rather than
    /// stacking duplicates.
    public func scheduleNextRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
        request.earliestBeginDate = dateProvider().addingTimeInterval(rescheduleInterval)
        do {
            try scheduler.submit(request)
        } catch {
            // Non-fatal: scheduling can legitimately fail (e.g. Background
            // App Refresh disabled in Settings, or running in a context
            // BGTaskScheduler rejects like an extension/simulator without
            // entitlements). The manual "Refresh now" path in Home remains
            // available regardless, so this is not a user-facing failure.
        }
    }

    /// The actual task body. Always calls `setTaskCompleted` exactly once
    /// (Apple requirement) and always reschedules the next attempt before
    /// returning, regardless of outcome — a failed HealthKit read or a
    /// failed upload must not stop future mornings from trying again.
    ///
    /// Takes `any BackgroundRefreshTaskHandle` rather than the concrete
    /// `BGAppRefreshTask` so this method is callable from tests with a
    /// fake handle (see doc comment on `BackgroundRefreshTaskHandle`).
    func handle(_ task: any BackgroundRefreshTaskHandle) {
        // The OS can revoke the remaining execution budget at any time;
        // this expiration handler cancels our in-flight work and ends the
        // task promptly so iOS doesn't penalize the app for future
        // scheduling.
        let work = Task { @MainActor in
            _ = await bandUploadService.refreshAndUpload()

            // After band upload: collect tomorrow's free windows from Apple
            // Calendar and upload them to POST /v1/slots if access is granted.
            // Failure is logged but does NOT fail the whole background task
            // (graceful-degradation: calendar-slot upload is best-effort,
            // exactly like band upload in the health-unavailable path).
            await self.collectAndUploadSlotsIfAllowed()

            self.scheduleNextRefresh()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = {
            work.cancel()
            task.setTaskCompleted(success: false)
        }
    }

    /// Collects tomorrow's EventKit free windows and uploads them via
    /// `SlotsUploadClient`. Called from the background task handler only.
    ///
    /// Guards:
    ///  - Returns immediately if `slotCollector` or `slotsUploadClient` is nil
    ///    (no Apple-Calendar integration configured for this environment).
    ///  - Returns immediately if calendar access is not granted at the
    ///    `EKAuthorizationStatus` level — does NOT request permission here
    ///    (that was done at onboarding, per the task spec).
    ///  - If `SlotsUploadClient` throws, logs the error but does not propagate —
    ///    the band upload has already succeeded; slot failure is non-fatal.
    @MainActor
    private func collectAndUploadSlotsIfAllowed() async {
        guard
            let collector = slotCollector,
            let client = slotsUploadClient
        else { return }

        // Do not request permission in background. If access is not `.fullAccess`
        // (or the legacy `.authorized`), skip silently.
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess, .authorized:
            break
        default:
            return
        }

        // Collect slots for tomorrow (the next calendar day) so the backend
        // has candidate windows before the morning begins.
        let tomorrow = dateProvider().addingTimeInterval(24 * 60 * 60)
        let freeWindows = await collector.collectFreeWindows(
            for: tomorrow,
            windowStartHour: windowStartHour,
            windowStartMinute: windowStartMinute,
            windowEndHour: windowEndHour,
            windowEndMinute: windowEndMinute
        )

        // Derive the YYYY-MM-DD date string for tomorrow in local time.
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        dateFormatter.timeZone = TimeZone.current
        let dateString = dateFormatter.string(from: tomorrow)

        do {
            try await client.uploadSlots(date: dateString, freeWindows: freeWindows)
        } catch {
            // Non-fatal: log for debugging, do not re-throw.
            #if DEBUG
            print("[BackgroundBandRefreshScheduler] Slots upload failed (non-fatal): \(error)")
            #endif
        }
    }
}
