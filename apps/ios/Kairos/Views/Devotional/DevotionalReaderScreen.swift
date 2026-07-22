import SwiftUI

/// Loads one devotional's full detail (GET /v1/devotionals/:id) and shows the
/// native reader (issue #3). Pushed from the Home dashboard's Today card and
/// History rows, so opening a devotional stays in-app instead of bouncing to
/// a web session.
struct DevotionalReaderScreen: View {
    private let devotionalID: String
    @ObservedObject private var viewModel: HomeViewModel
    @State private var state: LoadState = .loading

    private enum LoadState {
        case loading
        case loaded(DevotionalDetail)
        case failed(String)
    }

    init(devotionalID: String, viewModel: HomeViewModel) {
        self.devotionalID = devotionalID
        self.viewModel = viewModel
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Opening…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("devotionalReader.loading")
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
            state = .loaded(try await viewModel.devotionalDetail(id: devotionalID))
        } catch {
            state = .failed((error as? DashboardError)?.errorDescription ?? "Couldn't open this devotional.")
        }
    }
}
