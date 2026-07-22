import SwiftUI

/// docs/05_UX_FLOWS.md §3 screen inventory: Home / History / Preferences.
struct RootTabView: View {
    @EnvironmentObject private var appEnvironment: AppEnvironment

    var body: some View {
        TabView {
            HomeView(
                makeViewModel: appEnvironment.makeHomeViewModel(),
                distressCheckinClient: appEnvironment.distressCheckinClient
            )
                .tabItem { Label("Home", systemImage: "house") }
                .accessibilityIdentifier("tab.home")

            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
                .accessibilityIdentifier("tab.history")

            PreferencesView(authService: appEnvironment.authService, preferencesStore: appEnvironment.preferencesStore)
                .tabItem { Label("Preferences", systemImage: "gearshape") }
                .accessibilityIdentifier("tab.preferences")
        }
    }
}

#Preview {
    RootTabView()
        .environmentObject(AppEnvironment())
}
