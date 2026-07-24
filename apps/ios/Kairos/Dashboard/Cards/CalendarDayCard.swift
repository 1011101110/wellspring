import SwiftUI

// The free/busy day view (issue #6) — the phone counterpart to the web
// calendar card (apps/web/src/components/dashboard/calendar/CalendarCard.tsx),
// deliberately a single-day timeline rather than a week/month grid.
//
// Two sources, two failure modes: today's busy blocks come from this card's
// own `GET /v1/calendar/freebusy` read (HomeViewModel.freeBusy). Wellspring's
// own devotional slots are NOT in that payload — they come from the already
// loaded "Coming up" list, filtered to today (HomeViewModel.todaysWellspringSlots)
// and highlighted on top of the busy blocks.

struct CalendarDayCard: View {
    @ObservedObject var viewModel: HomeViewModel

    /// The privacy note, stated as the product's posture rather than an
    /// apology (Foundation §8 / #255: "the constraint is the feature").
    private static let privacyNote =
        "Wellspring reads only free/busy time — never event titles, attendees, or notes."

    var body: some View {
        CardFrame("Your day") {
            switch viewModel.freeBusy {
            case .loading:
                CardLoading()
            case .failed(let message):
                CardError(message: message) { Task { await viewModel.loadFreeBusy() } }
            case .empty:
                CardEmpty(message: "Nothing on your calendar today.")
            case .loaded(let data):
                content(for: data)
            }
        }
    }

    // MARK: - Loaded content

    @ViewBuilder
    private func content(for data: FreeBusy) -> some View {
        switch data {
        case .consentDisabled:
            CardEmpty(message: "Calendar reading is turned off, so Wellspring can't show your day here. Your Google connection is untouched — turning it back on is one switch in settings.")
        case .notConnected:
            CardEmpty(message: "Connect your Google Calendar and Wellspring can show you where your commitments sit today.")
        case .ok(_, let busy):
            let slots = viewModel.todaysWellspringSlots
            if busy.isEmpty && slots.isEmpty {
                CardEmpty(message: "Nothing on your calendar today.")
            } else {
                dayTimeline(busy: busy, slots: slots)
            }
        }
    }

    @ViewBuilder
    private func dayTimeline(busy: [FreeBusyBlock], slots: [UpcomingCalendarEvent]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHint(Self.privacyNote)

            VStack(alignment: .leading, spacing: 12) {
                ForEach(rows(busy: busy, slots: slots)) { row in
                    rowView(row)
                }
            }

            CardHint("Times shown in \(deviceZoneLabel).")
        }
    }

    // MARK: - Rows

    /// A single timeline entry — a busy window or one of Wellspring's slots —
    /// as a value, not a pre-built `AnyView` (S4 #345): the row enum keeps
    /// SwiftUI's type-level view identity, and `id` is derived from the
    /// underlying data (not the row's position) so identity survives
    /// reordering. `start` is the sort key both kinds interleave by.
    private enum TimelineRow: Identifiable {
        case busy(FreeBusyBlock, start: Date)
        case slot(UpcomingCalendarEvent, start: Date)

        var start: Date {
            switch self {
            case .busy(_, let start), .slot(_, let start): return start
            }
        }

        var id: String {
            switch self {
            // A busy window has no server id — its bounds are its identity.
            case .busy(let block, _): return "busy:\(block.start)-\(block.end)"
            case .slot(let event, _): return "slot:\(event.id)"
            }
        }
    }

    private func rows(busy: [FreeBusyBlock], slots: [UpcomingCalendarEvent]) -> [TimelineRow] {
        var rows: [TimelineRow] = []

        for block in busy {
            guard let start = DashboardDate.parse(block.start) else { continue }
            rows.append(.busy(block, start: start))
        }
        for slot in slots {
            guard let start = DashboardDate.parse(slot.gapStartAt) else { continue }
            rows.append(.slot(slot, start: start))
        }

        return rows.sorted { $0.start < $1.start }
    }

    @ViewBuilder
    private func rowView(_ row: TimelineRow) -> some View {
        switch row {
        case .busy(let block, _): busyRow(block)
        case .slot(let slot, _): slotRow(slot)
        }
    }

    private func busyRow(_ block: FreeBusyBlock) -> some View {
        HStack(alignment: .top, spacing: 12) {
            // A quiet warm-stone dot — busy time is context, never the focus.
            Circle()
                .fill(WSTheme.muted)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(DashboardDate.timeLabel(block.start))–\(DashboardDate.timeLabel(block.end))")
                    .font(WSTheme.ui(.medium, size: 15))
                    .foregroundStyle(WSTheme.ink)
                Text("Busy")
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func slotRow(_ slot: UpcomingCalendarEvent) -> some View {
        // Wellspring's own moment — the row the eye should land on:
        // terracotta dot (the only accent) on a soft mist ground.
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(WSTheme.terracotta)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(DashboardDate.timeLabel(slot.gapStartAt))–\(DashboardDate.timeLabel(slot.gapEndAt))")
                    .font(WSTheme.ui(.semibold, size: 15))
                    .foregroundStyle(WSTheme.ink)
                Text(slot.devotional?.theme ?? "Wellspring devotional")
                    .font(WSTheme.ui(.medium, size: 13))
                    .foregroundStyle(WSTheme.clayDeep)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: CardLayout.insetCornerRadius, style: .continuous).fill(WSTheme.mist))
    }

    // MARK: - Zone label

    /// "Times shown in <device timezone>" — a friendly generic name where the
    /// OS offers one (e.g. "Eastern Time"), falling back to the identifier.
    private var deviceZoneLabel: String {
        let tz = TimeZone.current
        return tz.localizedName(for: .generic, locale: .current) ?? tz.identifier
    }
}
