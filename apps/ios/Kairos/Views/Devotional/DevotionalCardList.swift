import SwiftUI

/// The shared newest-first devotional list: rows that push the native reader
/// (#3), plus an optional "Show more" pagination control.
///
/// Rendered by both the Home dashboard's "Your devotionals" card
/// (`HistoryCard`) and the History tab (`HistoryView`) — the two surfaces
/// deliberately show the same content (backlog #4), and their row markup had
/// drifted into byte-identical twins before it was extracted here (S4 #345).
/// Each caller hands in its own reader destination and pagination wiring, so
/// the list stays view-model-agnostic.
struct DevotionalCardList: View {
    let cards: [DevotionalCard]
    let showMore: Bool
    let isLoadingMore: Bool
    let loadMore: () -> Void
    let makeReader: (DevotionalCard) -> DevotionalReaderScreen

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(cards) { card in
                NavigationLink {
                    makeReader(card)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        // The row's title wears the serif title role — a
                        // devotional is content, not chrome (§03).
                        Text(card.theme)
                            .font(WSTheme.title(size: 17))
                            .foregroundStyle(WSTheme.ink)
                        Text(DashboardDate.calendarDateLabel(card.date))
                            .font(WSTheme.reference())
                            .foregroundStyle(WSTheme.mutedInk)
                        Text(card.cardSummary)
                            .font(WSTheme.ui(size: 13))
                            .foregroundStyle(WSTheme.mutedInk)
                            .lineSpacing(3)
                        if card.completedAt != nil {
                            CardHint("You sat with this one.")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4) // rows stay comfortably ≥44pt targets
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if card.id != cards.last?.id { Divider().overlay(WSTheme.dawn) }
            }
            if showMore {
                Button(action: loadMore) {
                    Text(isLoadingMore ? "Loading…" : "Show more")
                }
                .font(WSTheme.ui(.semibold, size: 15))
                .foregroundStyle(WSTheme.clayDeep)
                .frame(minHeight: 44)
                .disabled(isLoadingMore)
            }
        }
    }
}
