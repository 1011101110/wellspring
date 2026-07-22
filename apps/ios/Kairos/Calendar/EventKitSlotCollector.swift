import Foundation
import EventKit

/// A free time window within the user's scheduling day, formatted for upload
/// to `POST /v1/slots` (packages/shared-contracts/src/api/slots.ts
/// `CandidateSlotSchema`).
///
/// Privacy invariant (docs/00_FOUNDATION.md §8): this struct ONLY carries
/// start/end instants — never event titles, attendees, locations, notes, or
/// precise original event timestamps. The field names `startIso`/`endIso`
/// match `CandidateSlotSchema` exactly so `JSONEncoder` produces the correct
/// wire keys without any custom coding key mapping.
public struct FreeWindow: Codable, Equatable, Sendable {
    /// ISO 8601 with UTC offset, e.g. "2026-07-04T09:00:00-05:00".
    public let startIso: String
    /// ISO 8601 with UTC offset, e.g. "2026-07-04T09:30:00-05:00".
    public let endIso: String

    public init(startIso: String, endIso: String) {
        self.startIso = startIso
        self.endIso = endIso
    }
}

// MARK: - Gap-finding functions (internal so tests can call them directly)

/// Merges a list of possibly-overlapping intervals into a sorted,
/// non-overlapping list. O(n log n).
///
/// Exposed as `internal` so `EventKitSlotCollector` and unit tests share
/// the exact same implementation without any duplication or subclassing.
func mergeIntervals(
    _ intervals: [(start: Date, end: Date)]
) -> [(start: Date, end: Date)] {
    guard !intervals.isEmpty else { return [] }
    let sorted = intervals.sorted { $0.start < $1.start }
    var merged: [(start: Date, end: Date)] = []
    var current = sorted[0]
    for interval in sorted.dropFirst() {
        if interval.start <= current.end {
            // Overlapping or adjacent — extend the current block.
            current = (start: current.start, end: max(current.end, interval.end))
        } else {
            merged.append(current)
            current = interval
        }
    }
    merged.append(current)
    return merged
}

/// Returns the free sub-intervals of `window` that are NOT covered by any
/// of `busyBlocks` (which must already be sorted and non-overlapping).
///
/// Exposed as `internal` so tests share the same implementation.
func subtractBusyIntervals(
    from window: (start: Date, end: Date),
    busyBlocks: [(start: Date, end: Date)]
) -> [(start: Date, end: Date)] {
    var free: [(start: Date, end: Date)] = []
    var cursor = window.start
    for block in busyBlocks {
        if block.start > cursor {
            // Gap before this busy block.
            free.append((start: cursor, end: min(block.start, window.end)))
        }
        cursor = max(cursor, block.end)
        if cursor >= window.end { break }
    }
    // Remaining tail of the window after all busy blocks.
    if cursor < window.end {
        free.append((start: cursor, end: window.end))
    }
    return free
}

// MARK: - EventKitSlotCollector

/// Reads Apple Calendar free/busy for a given date and returns a list of
/// FREE time windows (the complement of the user's busy blocks within the
/// requested scheduling window).
///
/// Privacy invariant (docs/00_FOUNDATION.md §8):
/// - Only `event.startDate` and `event.endDate` are ever accessed — never
///   `event.title`, `event.attendees`, `event.location`, `event.notes`, or
///   any other EKEvent property.
/// - The raw busy blocks are processed in-memory and never persisted.
/// - The output `[FreeWindow]` contains only start/end timestamps.
///
/// The `eventFetcher` closure is injected so tests can supply pre-built
/// busy-block arrays without touching a real `EKEventStore` (which cannot be
/// authorised in a CI simulator environment).
public final class EventKitSlotCollector: Sendable {
    private let eventStore: EKEventStore
    /// Override hook for tests: when non-nil this is called instead of the
    /// real `EKEventStore.events(matching:)` query. Receives the window
    /// start and end as context. Returns `(start, end)` pairs (the only data
    /// extracted from real EKEvent objects).
    let eventFetcher: (@Sendable (_ windowStart: Date, _ windowEnd: Date) -> [(start: Date, end: Date)])?

    /// Production init — uses the real `EKEventStore`.
    public init(eventStore: EKEventStore) {
        self.eventStore = eventStore
        self.eventFetcher = nil
    }

    /// Test init — uses an injected closure instead of touching EKEventStore.
    init(
        eventStore: EKEventStore = EKEventStore(),
        eventFetcher: @escaping @Sendable (_ windowStart: Date, _ windowEnd: Date) -> [(start: Date, end: Date)]
    ) {
        self.eventStore = eventStore
        self.eventFetcher = eventFetcher
    }

    /// Returns the list of FREE windows for `date` within the given hour:minute
    /// scheduling window. Each window is guaranteed to be at least
    /// `minimumDurationMinutes` long. Returns an empty array (never throws)
    /// if calendar access has not been granted.
    ///
    /// - Parameters:
    ///   - date: The calendar day to examine (time-of-day portion is ignored;
    ///     the scheduling window overrides it).
    ///   - windowStartHour: Local hour the window opens (0–23).
    ///   - windowStartMinute: Local minute within the opening hour (0–59).
    ///   - windowEndHour: Local hour the window closes (0–23).
    ///   - windowEndMinute: Local minute within the closing hour (0–59).
    ///   - minimumDurationMinutes: Free intervals shorter than this are dropped.
    public func collectFreeWindows(
        for date: Date,
        windowStartHour: Int,
        windowStartMinute: Int,
        windowEndHour: Int,
        windowEndMinute: Int,
        minimumDurationMinutes: Int = 10
    ) async -> [FreeWindow] {
        // When a test injected an eventFetcher, skip the real access check
        // and EKEventStore call entirely (the fetcher already encodes the
        // desired access-denied / access-granted scenario).
        if let fetcher = eventFetcher {
            let cal = Calendar.current
            guard
                let windowStart = dateBySettingTime(
                    hour: windowStartHour, minute: windowStartMinute,
                    on: date, calendar: cal),
                let windowEnd = dateBySettingTime(
                    hour: windowEndHour, minute: windowEndMinute,
                    on: date, calendar: cal),
                windowEnd > windowStart
            else { return [] }

            let rawBlocks = fetcher(windowStart, windowEnd)
            return computeFreeWindows(
                rawBlocks: rawBlocks,
                windowStart: windowStart,
                windowEnd: windowEnd,
                minimumDurationMinutes: minimumDurationMinutes
            )
        }

        // Production path — verify access before touching any store data;
        // return empty silently if not granted (do not request permission here
        // — that was done during onboarding in EventKitCalendarConnectService).
        guard Self.hasCalendarAccess() else { return [] }

        let cal = Calendar.current
        guard
            let windowStart = dateBySettingTime(
                hour: windowStartHour, minute: windowStartMinute,
                on: date, calendar: cal),
            let windowEnd = dateBySettingTime(
                hour: windowEndHour, minute: windowEndMinute,
                on: date, calendar: cal),
            windowEnd > windowStart
        else { return [] }

        // Fetch all EK events that overlap the scheduling window.
        // PRIVACY: only .startDate and .endDate are ever read from EKEvent.
        let predicate = eventStore.predicateForEvents(
            withStart: windowStart,
            end: windowEnd,
            calendars: nil // all calendars
        )
        let events = eventStore.events(matching: predicate)

        // Extract ONLY start/end dates — no title, no attendees, nothing else.
        let rawBlocks: [(start: Date, end: Date)] = events.compactMap { event in
            guard let s = event.startDate, let e = event.endDate, e > s else { return nil }
            return (start: s, end: e)
        }

        return computeFreeWindows(
            rawBlocks: rawBlocks,
            windowStart: windowStart,
            windowEnd: windowEnd,
            minimumDurationMinutes: minimumDurationMinutes
        )
    }

    // MARK: - Private helpers

    private static func hasCalendarAccess() -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess, .authorized:
            return true
        default:
            return false
        }
    }

    private func computeFreeWindows(
        rawBlocks: [(start: Date, end: Date)],
        windowStart: Date,
        windowEnd: Date,
        minimumDurationMinutes: Int
    ) -> [FreeWindow] {
        // Clamp busy blocks to the scheduling window.
        let clamped: [(start: Date, end: Date)] = rawBlocks.compactMap { block in
            let s = max(block.start, windowStart)
            let e = min(block.end,   windowEnd)
            return e > s ? (start: s, end: e) : nil
        }

        let merged = mergeIntervals(clamped)
        let freeIntervals = subtractBusyIntervals(
            from: (start: windowStart, end: windowEnd),
            busyBlocks: merged
        )

        let minimumSeconds = TimeInterval(minimumDurationMinutes * 60)
        let formatter = Self.iso8601Formatter()
        return freeIntervals
            .filter { $0.end.timeIntervalSince($0.start) >= minimumSeconds }
            .map { FreeWindow(startIso: formatter.string(from: $0.start),
                              endIso:   formatter.string(from: $0.end)) }
    }

    private func dateBySettingTime(
        hour: Int, minute: Int,
        on date: Date,
        calendar: Calendar
    ) -> Date? {
        var components = calendar.dateComponents([.year, .month, .day], from: date)
        components.hour   = hour
        components.minute = minute
        components.second = 0
        return calendar.date(from: components)
    }

    private static func iso8601Formatter() -> ISO8601DateFormatter {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withTimeZone]
        f.timeZone = TimeZone.current
        return f
    }
}
