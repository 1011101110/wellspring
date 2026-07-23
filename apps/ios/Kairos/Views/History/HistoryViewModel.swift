import Foundation

/// Backs the History tab (backlog #4) — the full-screen devotionals archive.
/// It is the same content as the Home dashboard's "Your devotionals" card
/// (HistoryCard), lifted out of `HomeViewModel` into its own standalone view
/// model so the History screen owns its paginated list + search without
/// dragging in every other dashboard card's state.
///
/// The list/search/pagination logic mirrors `HomeViewModel`'s history slice
/// (`loadHistory` / `loadMoreHistory` / `runSearch` / `clearSearch`) exactly,
/// so both surfaces behave identically.
@MainActor
public final class HistoryViewModel: ObservableObject {
    // Reuses `CardState` (from HomeViewModel.swift) so the view can render the
    // same loading/empty/failed sub-states the dashboard cards use.
    @Published public private(set) var list: CardState<[DevotionalCard]> = .loading
    @Published public private(set) var nextCursor: String?
    @Published public private(set) var isLoadingMore = false
    @Published public private(set) var searchAvailable = false
    @Published public private(set) var searchResults: [DevotionalCard]?

    /// Transient error from a load-more / search action, surfaced as an alert.
    @Published public var actionError: String?

    private let devotionals: any DevotionalsProviding

    public init(devotionals: any DevotionalsProviding) {
        self.devotionals = devotionals
    }

    private func message(for error: Error) -> String {
        (error as? DashboardError)?.errorDescription ?? "Something went wrong."
    }

    // MARK: - Loading

    /// Loads the first page and probes search availability concurrently.
    public func load() async {
        async let a: Void = loadFirstPage()
        async let b: Void = probeSearch()
        _ = await (a, b)
    }

    private func loadFirstPage() async {
        list = .loading
        do {
            let page = try await devotionals.list(cursor: nil)
            nextCursor = page.nextCursor
            list = page.devotionals.isEmpty ? .empty : .loaded(page.devotionals)
        } catch {
            list = .failed(message(for: error))
        }
    }

    public func loadMore() async {
        guard case .loaded(let current) = list, let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await devotionals.list(cursor: cursor)
            nextCursor = page.nextCursor
            list = .loaded(current + page.devotionals)
        } catch {
            actionError = message(for: error)
        }
    }

    private func probeSearch() async {
        // Fail-closed: only offer search once we know the endpoint answers.
        searchAvailable = (try? await devotionals.search(query: "a")) != nil
    }

    // MARK: - Search

    public func runSearch(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { searchResults = nil; return }
        do { searchResults = try await devotionals.search(query: trimmed) ?? [] }
        catch { actionError = message(for: error) }
    }

    public func clearSearch() { searchResults = nil }

    // MARK: - Reader

    /// Fetch a single devotional's full detail for the native reader (#3).
    public func detail(id: String) async throws -> DevotionalDetail {
        try await devotionals.detail(id: id)
    }
}
