import SwiftUI
#if canImport(GoogleSignIn)
import GoogleSignIn
#endif

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
                #if canImport(GoogleSignIn)
                // GoogleSignIn callback safety net: forwards the OAuth
                // redirect (the reversed-client-id scheme registered in
                // Info.plist) back into the in-flight sign-in. No-op for any
                // other URL, so it never interferes with the calendar OAuth
                // (`kairos://`) flow.
                .onOpenURL { url in
                    _ = GIDSignIn.sharedInstance.handle(url)
                }
                #endif
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
