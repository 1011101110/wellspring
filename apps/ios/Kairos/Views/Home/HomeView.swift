import SwiftUI

/// The signed-in Home — the iOS counterpart to the web dashboard
/// (issue #252). Each card owns its own fetch through `HomeViewModel` and
/// degrades independently, matching the web's "presence outranks archive,
/// one card failing never takes the screen down" model
/// (apps/web/src/views/Dashboard.tsx). The distress check-in front door
/// (#77) is preserved as a quiet footer.
struct HomeView: View {
    @StateObject private var viewModel: HomeViewModel
    private let distressCheckinClient: any DistressCheckinRequesting

    @Environment(\.openURL) private var openURL
    @State private var distressFailed = false

    /// `makeViewModel` is an autoclosure so `@StateObject` builds the view
    /// model exactly once (same pattern as `DataPrivacyView`), not on every
    /// re-evaluation.
    init(
        makeViewModel: @autoclosure @escaping () -> HomeViewModel,
        distressCheckinClient: any DistressCheckinRequesting
    ) {
        _viewModel = StateObject(wrappedValue: makeViewModel())
        self.distressCheckinClient = distressCheckinClient
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    TodayCard(viewModel: viewModel)
                    UpcomingCard(viewModel: viewModel)
                    ConnectionCard(viewModel: viewModel)
                    CalendarDayCard(viewModel: viewModel)
                    InviteAddressCard(viewModel: viewModel)
                    JournalCard(viewModel: viewModel)
                    HistoryCard(viewModel: viewModel)
                    RecapCard(viewModel: viewModel)
                    ComingSoonCard()
                    distressFooter
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Wellspring")
            .refreshable { await viewModel.loadAll() }
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
        .task { await viewModel.loadAll() }
    }

    /// docs/14_IMPROVEMENT_REVIEW.md §5.8 / #77 — always-available "I need
    /// comfort now" door, kept quiet at the bottom of Home.
    private var distressFooter: some View {
        VStack(spacing: 6) {
            Button {
                Task { await checkInNow() }
            } label: {
                Label("I could use a moment now", systemImage: "heart")
                    .font(.subheadline)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("home.distressCheckinButton")

            if distressFailed {
                Text("Couldn't reach Wellspring just now — please try again in a moment. If you need immediate help, call or text 988.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("home.distressCheckinError")
            }
        }
        .padding(.top, 8)
    }

    private func checkInNow() async {
        distressFailed = false
        do {
            let result = try await distressCheckinClient.checkInNow()
            openURL(result.sessionUrl)
        } catch {
            distressFailed = true
        }
    }
}
