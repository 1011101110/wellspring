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
                        Text(card.theme).font(.subheadline.weight(.semibold))
                        Text(DashboardDate.calendarDateLabel(card.date))
                            .font(.caption).foregroundStyle(.secondary)
                        Text(card.cardSummary).font(.footnote).foregroundStyle(.secondary)
                        if card.completedAt != nil {
                            CardHint("You sat with this one.")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if card.id != cards.last?.id { Divider() }
            }
            if showMore {
                Button(action: loadMore) {
                    Text(isLoadingMore ? "Loading…" : "Show more")
                }
                .font(.subheadline.weight(.semibold))
                .disabled(isLoadingMore)
            }
        }
    }
}
