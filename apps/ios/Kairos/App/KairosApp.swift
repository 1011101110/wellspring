import SwiftUI

@main
struct KairosApp: App {
    @StateObject private var appEnvironment = AppEnvironment()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Must be called before app-launch finishes (Apple requirement for
        // `BGTaskScheduler.register`) — issue #37. `_appEnvironment` is
        // already constructed by the property initializer above by the
        // time `init` runs, so this reads back through the wrapper.
        _appEnvironment.wrappedValue.backgroundBandRefreshScheduler.register()
    }

    var body: some Scene {
        WindowGroup {
            RootView(appEnvironment: appEnvironment)
                .environmentObject(appEnvironment)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Re-submit the next background refresh request every time the
            // app backgrounds — `BGTaskScheduler` replaces any existing
            // pending request for the same identifier rather than
            // stacking duplicates, so this is safe to call repeatedly.
            if newPhase == .background {
                appEnvironment.backgroundBandRefreshScheduler.scheduleNextRefresh()
            }
        }
    }
}
