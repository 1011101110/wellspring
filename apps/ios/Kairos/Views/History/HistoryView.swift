import SwiftUI

/// docs/05_UX_FLOWS.md §3.1 "History" (F10) / backlog #4 — the full-screen
/// devotionals archive. Same content as the Home dashboard's "Your
/// devotionals" card (HistoryCard), lifted into its own tab: a paginated,
/// newest-first list with optional search, each row tapping into the native
/// in-app reader (#3).
struct HistoryView: View {
    @StateObject private var viewModel: HistoryViewModel
    @State private var searchText = ""

    /// `makeViewModel` is an autoclosure so `@StateObject` builds the view
    /// model exactly once (same pattern as `HomeView`), not on every
    /// re-evaluation.
    init(makeViewModel: @autoclosure @escaping () -> HistoryViewModel) {
        _viewModel = StateObject(wrappedValue: makeViewModel())
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if viewModel.searchAvailable { searchField }

                    if let results = viewModel.searchResults {
                        if results.isEmpty {
                            CardEmpty(message: "No devotionals matched that.")
                        } else {
                            devotionalList(results, showMore: false)
                        }
                    } else {
                        switch viewModel.list {
                        case .loading:
                            CardLoading()
                        case .failed(let message):
                            CardError(message: message) { Task { await viewModel.load() } }
                        case .empty:
                            CardEmpty(message: "Your devotionals will collect here as they happen, newest first.")
                        case .loaded(let cards):
                            devotionalList(cards, showMore: viewModel.nextCursor != nil)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Your devotionals")
            .refreshable { await viewModel.load() }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { viewModel.actionError != nil },
                    set: { if !$0 { viewModel.actionError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { viewModel.actionError = nil }
            } message: {
                Text(viewModel.actionError ?? "")
            }
        }
        .task { await viewModel.load() }
    }

    private var searchField: some View {
        HStack {
            TextField("Search devotionals", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.search)
                .onSubmit { Task { await viewModel.runSearch(searchText) } }
                .accessibilityIdentifier("history.search")
            if viewModel.searchResults != nil {
                Button("Clear") { searchText = ""; viewModel.clearSearch() }
                    .font(.subheadline)
            }
        }
    }

    /// Row markup + pagination live in the shared `DevotionalCardList`
    /// (S4 #345) — this screen only wires in its `HistoryViewModel` plumbing
    /// and its own reader entry point (the History-tab `DevotionalReaderScreen`
    /// init, which keeps the "history.reader.loading" accessibility id).
    private func devotionalList(_ cards: [DevotionalCard], showMore: Bool) -> some View {
        DevotionalCardList(
            cards: cards,
            showMore: showMore,
            isLoadingMore: viewModel.isLoadingMore,
            loadMore: { Task { await viewModel.loadMore() } },
            makeReader: { DevotionalReaderScreen(devotionalID: $0.id, viewModel: viewModel) }
        )
        .accessibilityIdentifier("history.list")
    }
}
