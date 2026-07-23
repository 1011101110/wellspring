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

    @ViewBuilder
    private func devotionalList(_ cards: [DevotionalCard], showMore: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(cards) { card in
                NavigationLink {
                    HistoryReaderScreen(devotionalID: card.id, viewModel: viewModel)
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
                Button {
                    Task { await viewModel.loadMore() }
                } label: {
                    Text(viewModel.isLoadingMore ? "Loading…" : "Show more")
                }
                .font(.subheadline.weight(.semibold))
                .disabled(viewModel.isLoadingMore)
            }
        }
        .accessibilityIdentifier("history.list")
    }
}

/// Loads one devotional's full detail (GET /v1/devotionals/:id) through the
/// `HistoryViewModel` and shows the native reader. A History-tab twin of
/// `DevotionalReaderScreen` (which is bound to `HomeViewModel`), so the
/// archive can open a devotional in-app without depending on the Home view
/// model.
private struct HistoryReaderScreen: View {
    private let devotionalID: String
    @ObservedObject private var viewModel: HistoryViewModel
    @State private var state: LoadState = .loading

    private enum LoadState {
        case loading
        case loaded(DevotionalDetail)
        case failed(String)
    }

    init(devotionalID: String, viewModel: HistoryViewModel) {
        self.devotionalID = devotionalID
        self.viewModel = viewModel
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Opening…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("history.reader.loading")
            case .loaded(let detail):
                DevotionalDetailView(detail: detail)
            case .failed(let message):
                VStack(spacing: 12) {
                    Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await load() }
    }

    private func load() async {
        state = .loading
        do {
            state = .loaded(try await viewModel.detail(id: devotionalID))
        } catch {
            state = .failed((error as? DashboardError)?.errorDescription ?? "Couldn't open this devotional.")
        }
    }
}
