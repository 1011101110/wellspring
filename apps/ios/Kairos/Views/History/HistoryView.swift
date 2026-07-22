import SwiftUI

/// docs/05_UX_FLOWS.md §3.1 "History" (F10) — reverse-chron list of past
/// devotionals. Empty state shown here; real list wiring lands in a later
/// stage.
struct HistoryView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Spacer()
                Text("Your past devotionals will gather here.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 32)
                    .accessibilityIdentifier("history.emptyState")
                Spacer()
            }
            .navigationTitle("History")
        }
    }
}

#Preview {
    HistoryView()
}
