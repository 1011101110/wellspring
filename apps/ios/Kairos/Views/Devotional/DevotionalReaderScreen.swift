import SwiftUI

/// Loads one devotional's full detail (GET /v1/devotionals/:id) and shows the
/// native reader (issue #3). Pushed from the Home dashboard's Today card and
/// History rows, and from the History tab's archive rows.
///
/// The screen depends only on a `loadDetail` closure, not on a concrete view
/// model type — `HomeViewModel` and `HistoryViewModel` each hand in their own
/// detail fetch (S4 #345; this used to exist twice, as this type plus a
/// private `HistoryReaderScreen` twin differing only in the view model).
struct DevotionalReaderScreen: View {
    private let devotionalID: String
    private let loadingAccessibilityID: String
    private let loadDetail: @MainActor (String) async throws -> DevotionalDetail
    @State private var state: LoadState = .loading

    private enum LoadState {
        case loading
        case loaded(DevotionalDetail)
        case failed(String)
    }

    init(
        devotionalID: String,
        loadingAccessibilityID: String,
        loadDetail: @escaping @MainActor (String) async throws -> DevotionalDetail
    ) {
        self.devotionalID = devotionalID
        self.loadingAccessibilityID = loadingAccessibilityID
        self.loadDetail = loadDetail
    }

    /// Home-dashboard entry point (Today card + "Your devotionals" card).
    init(devotionalID: String, viewModel: HomeViewModel) {
        self.init(
            devotionalID: devotionalID,
            loadingAccessibilityID: "devotionalReader.loading",
            loadDetail: viewModel.devotionalDetail(id:)
        )
    }

    /// History-tab entry point. Keeps its historical accessibility id so the
    /// two surfaces stay distinguishable in UI tests.
    init(devotionalID: String, viewModel: HistoryViewModel) {
        self.init(
            devotionalID: devotionalID,
            loadingAccessibilityID: "history.reader.loading",
            loadDetail: viewModel.detail(id:)
        )
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Opening…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier(loadingAccessibilityID)
            case .loaded(let detail):
                DevotionalDetailView(detail: detail)
            case .failed(let message):
                VStack(spacing: 12) {
                    Text(message)
                        .font(WSTheme.ui(size: 15))
                        .foregroundStyle(WSTheme.mutedInk)
                        .multilineTextAlignment(.center)
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(WSQuietPillButtonStyle())
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(WSTheme.canvas)
        .task { await load() }
    }

    private func load() async {
        state = .loading
        do {
            state = .loaded(try await loadDetail(devotionalID))
        } catch {
            state = .failed((error as? DashboardError)?.errorDescription ?? "Couldn't open this devotional.")
        }
    }
}
