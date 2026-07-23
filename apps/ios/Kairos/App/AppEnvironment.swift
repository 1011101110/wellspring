import Foundation
import SwiftUI
import EventKit

/// Simple composition root. Real app launch wires the real (guarded)
/// Firebase auth service and the real EventKit calendar service; previews,
/// tests, and Demo Mode wire the fakes instead.
///
/// `authService` is exposed as `AnyAuthService` (a type-erased, concrete
/// `ObservableObject`) rather than the concrete `FirebaseAuthService`, so
/// this one composition root can swap in `FakeAuthService` for Demo Mode /
/// UI tests (docs/00_FOUNDATION.md §11 — "Fixture/demo mode is mandatory")
/// without every downstream view needing to be generic over the auth
/// service type.
@MainActor
public final class AppEnvironment: ObservableObject {
    public let authService: AnyAuthService
    public let calendarService: any CalendarConnectService
    public let healthService: any HealthConnectService

    /// The `/v1/connect/google` client (issue #124), promoted to a stored
    /// property by issue #213. It used to be a local inside the real-launch
    /// branch below, visible only to `GoogleCalendarConnectService`, since
    /// connecting was the only thing anyone called it for. #213 added the
    /// other direction — `DELETE /v1/connect/google`, the server-side
    /// revoke behind "Disconnect calendar" — which `DataPrivacyViewModel`
    /// needs, so the client has to outlive that branch.
    ///
    /// Demo Mode gets `FakeGoogleConnectClient`, consistent with every
    /// other collaborator here: a demo/UI-test run must never issue a real
    /// revoke against a real account.
    public let googleConnectClient: any GoogleConnecting

    public let isDemoMode: Bool

    /// Demo-mode fixture snapshot (issue #41 / EPIC E8, docs/05_UX_FLOWS.md
    /// §8): decoded once at launch from the bundled copy of
    /// `fixtures/snapshots/low_poor_heavy.json` (David persona). `nil`
    /// outside demo mode — the real app has no fixture data to show. A
    /// decode failure is logged, never crashes launch (the bundled JSON is
    /// a build-time asset, not user input, but defensive decoding keeps a
    /// malformed/missing resource from taking down demo mode entirely).
    public let demoFixture: DemoFixtureSnapshot?

    /// F7 preferences persistence (issue #38). Real launches use
    /// `UserDefaultsPreferencesStore` (local persistence today, with a
    /// `RemotePreferencesSyncing` seam for later); Demo Mode / previews use
    /// an in-memory store so runs never mutate the real device's saved
    /// preferences.
    public let preferencesStore: any PreferencesStore

    /// Per-category consent toggles (issue #39 / docs/04_DATA_PRIVACY_SECURITY.md
    /// §3). Real launches persist locally via `UserDefaultsConsentStore`;
    /// Demo Mode / previews use an in-memory store, mirroring
    /// `preferencesStore`'s split exactly.
    public let consentStore: any ConsentStore

    /// Explicit "has this device finished onboarding" flag (issue #71 /
    /// docs/14_IMPROVEMENT_REVIEW.md §1.9) — `RootView` reads this instead
    /// of inferring completion from sign-in state. See
    /// `OnboardingCompletionStore`'s doc comment for why the two are
    /// distinct facts. Mirrors `consentStore`/`preferencesStore`'s
    /// real-vs-in-memory split exactly.
    public let onboardingCompletionStore: any OnboardingCompletionStore

    /// Pulls server-authoritative user state on sign-in and on foreground
    /// and applies it to the three local caches (issue #225 / epic #186).
    ///
    /// `nil` in Demo Mode and previews, for the same reason `remoteSync` is
    /// `nil` there: those launches have no live backend, and a coordinator
    /// with nothing to pull from would only add a failing network call to
    /// every foreground. A `nil` coordinator means "local state is all
    /// there is", which is exactly the pre-#225 behavior and remains
    /// correct for a fixture-backed run.
    public let preferencesSyncCoordinator: PreferencesSyncCoordinator?

    /// Backend contract for "Delete account & all data" (issue #39). No
    /// live endpoint exists yet — see `AccountDeletionClient`'s doc
    /// comment — so this is wired but not live-tested in real launches,
    /// and fake/in-memory in Demo Mode.
    public let accountDeletionClient: any AccountDeletionClient

    /// Orchestrates HealthKit-read -> BandDeriver -> upload (issue #37).
    /// Shared by the `BGAppRefreshTask` background handler and the manual
    /// "Refresh now" action on Home, so both paths behave identically.
    public let bandUploadService: BandUploadService

    /// Backend contract for the "I could use a moment now" distress
    /// check-in front door (docs/14_IMPROVEMENT_REVIEW.md §5.8, issue #77).
    /// Real launches hit `POST /v1/devotional/generate-now`; Demo Mode /
    /// previews use an in-memory fake, mirroring `accountDeletionClient`'s
    /// real-vs-fake split.
    public let distressCheckinClient: any DistressCheckinRequesting

    // Dashboard (issue #252) — the signed-in Home's card data sources.
    public let devotionalsClient: any DevotionalsProviding
    public let upcomingEventsClient: any UpcomingEventsProviding
    public let freeBusyClient: any FreeBusyProviding
    public let connectionsClient: any ConnectionsProviding
    public let recapClient: any RecapProviding
    public let journalClient: any JournalProviding
    public let liturgyClient: any LiturgyProviding
    public let accountInfoClient: any AccountInfoProviding
    public let generateNowClient: any GenerateNowRequesting
    /// `nil` in previews/tests that don't need background scheduling —
    /// `BGTaskScheduler.register` traps if invoked more than once per
    /// process, so this is only constructed (and registered) once per real
    /// app launch, guarded by `KairosApp`.
    public let backgroundBandRefreshScheduler: BackgroundBandRefreshScheduler

    /// The API base URL every real (non-demo-mode) network call is built
    /// against (`HTTPBandUploadClient`, `HTTPAccountDeletionClient`).
    ///
    /// Issue #71 (docs/14_IMPROVEMENT_REVIEW.md §1.9): this used to default
    /// to `https://api.kairos.app` — a real, externally-owned, routable
    /// domain nobody on this project controls. Any non-demo build would
    /// have POSTed a live Firebase ID token + band data to that unknown
    /// third party the moment a network call fired. This is the single
    /// configuration point for the base URL (per the issue's "behind a
    /// single configuration point" requirement): every call site reads
    /// `AppEnvironment.apiBaseURL`, never a URL literal of its own — grep
    /// for `api.kairos.app` in this target to confirm no other code path
    /// retains it.
    ///
    /// Resolution order:
    /// 1. `API_BASE_URL` in the main bundle's `Info.plist` (wired via
    ///    `project.yml`'s `INFOPLIST_KEY_API_BASE_URL` build setting) —
    ///    the real, shippable configuration point for any build
    ///    (Debug or Release).
    /// 2. In `DEBUG` builds only, when that key is absent/unset (e.g. a
    ///    fresh checkout that hasn't regenerated the Xcode project yet),
    ///    falls back to the real staging URL directly, so local
    ///    development/testing keeps working without extra setup.
    /// 3. Otherwise (a Release/TestFlight-shaped build missing the
    ///    Info.plist key entirely), falls back to a non-routable `.invalid`
    ///    host — real network calls fail closed with a network error
    ///    rather than ever silently reaching a real, unintended host.
    public static let apiBaseURL: URL = {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
           !configured.isEmpty,
           let url = URL(string: configured) {
            return url
        }
        #if DEBUG
        // `AppEnvironment.stagingAPIBaseURL` (not `Self.`) — `Self` cannot
        // be referenced from a stored static property's initializer
        // closure (the type isn't considered fully available yet at that
        // point), so the concrete type name is used instead.
        return AppEnvironment.stagingAPIBaseURL
        #else
        return URL(string: "https://kairos-api-not-configured.invalid")!
        #endif
    }()

    /// Placeholder staging API host for the open-source repo. Used as
    /// `project.yml`'s Debug-config `API_BASE_URL` value and as this file's
    /// own `DEBUG`-only fallback above. Point it at your own deployed API
    /// host (kept out of source so the public repo carries no real infra URL).
    public static let stagingAPIBaseURL = URL(string: "https://your-api-host.example.com")!

    public init(
        authService: AnyAuthService? = nil,
        calendarService: (any CalendarConnectService)? = nil,
        googleConnectClient: (any GoogleConnecting)? = nil,
        healthService: (any HealthConnectService)? = nil,
        healthSampleReader: (any HealthSampleReading)? = nil,
        bandUploadClient: (any BandUploading)? = nil,
        preferencesStore: (any PreferencesStore)? = nil,
        /// Injectable so tests can drive `preferencesSyncCoordinator`
        /// against `FakePreferencesSyncClient` (issue #225). `nil` in a real
        /// launch means "resolve the default", which is the live
        /// `HTTPPreferencesClient` outside Demo Mode and nothing inside it.
        remoteSync: (any RemotePreferencesSyncing)? = nil,
        consentStore: (any ConsentStore)? = nil,
        accountDeletionClient: (any AccountDeletionClient)? = nil,
        onboardingCompletionStore: (any OnboardingCompletionStore)? = nil,
        distressCheckinClient: (any DistressCheckinRequesting)? = nil,
        isDemoMode: Bool? = nil
    ) {
        // Defaults are constructed here (inside the @MainActor init body)
        // rather than as parameter default expressions, since default
        // expressions are evaluated in a nonisolated context and some of
        // these types' initializers are main-actor-isolated.
        let resolvedIsDemoMode = isDemoMode ?? Self.launchImpliesDemoMode()
        self.isDemoMode = resolvedIsDemoMode

        if resolvedIsDemoMode {
            do {
                self.demoFixture = try DemoFixtureLoader.load(bundle: .main)
            } catch {
                #if DEBUG
                print("DemoFixtureLoader failed to load bundled fixture: \(error)")
                #endif
                self.demoFixture = nil
            }
        } else {
            self.demoFixture = nil
        }

        if let authService {
            self.authService = authService
        } else if resolvedIsDemoMode {
            // For the Home-dashboard demo/UI-test hook, start already signed
            // in so RootView routes straight to the tab shell (it needs both a
            // current user and completed onboarding).
            let demoUser = Self.launchImpliesOnboardingComplete()
                ? KairosUser(id: "demo-user", displayName: "Demo", email: "demo@wellspring.app")
                : nil
            self.authService = AnyAuthService(FakeAuthService(initialUser: demoUser))
        } else {
            self.authService = AnyAuthService(FirebaseAuthService())
        }

        // Resolved ahead of `calendarService` (issue #213) because it is no
        // longer only the connect path's collaborator: whichever calendar
        // service this launch ends up with, the Data & Privacy screen needs
        // this client to issue the server-side revoke, so it must exist on
        // every branch rather than just the real-Google one.
        let resolvedGoogleConnectClient: any GoogleConnecting
        if let googleConnectClient {
            resolvedGoogleConnectClient = googleConnectClient
        } else if resolvedIsDemoMode {
            resolvedGoogleConnectClient = FakeGoogleConnectClient()
        } else {
            let capturedAuthServiceForConnect = self.authService
            resolvedGoogleConnectClient = HTTPGoogleConnectClient(
                baseURL: Self.apiBaseURL,
                idTokenProvider: { try await capturedAuthServiceForConnect.idToken() }
            )
        }
        self.googleConnectClient = resolvedGoogleConnectClient

        if let calendarService {
            self.calendarService = calendarService
        } else if resolvedIsDemoMode {
            // UI tests can opt into simulating a denied EventKit request
            // (docs/05_UX_FLOWS.md §3.1 "Denied permission" /
            // docs/04_DATA_PRIVACY_SECURITY.md §3 "Denied behavior:
            // .ics-invite-only mode") via a launch argument, without
            // needing a real device/OS permission sheet — mirrors
            // `UITEST_HEALTH_DENIED` below.
            let fakeCalendar = FakeCalendarConnectService()
            if Self.launchImpliesCalendarDenied() {
                fakeCalendar.nextError = .permissionDenied
            }
            self.calendarService = fakeCalendar
        } else {
            // Real Google Calendar connect (issue #124): fetches the
            // authorization URL from the backend, then drives it through
            // `ASWebAuthenticationSession`. EventKitCalendarConnectService
            // delegates its `.google` case to this collaborator.
            // Shares the single client resolved above rather than building
            // a second one (#213) — connect and revoke must go to the same
            // base URL with the same token provider by construction.
            let googleConnectService = GoogleCalendarConnectService(
                connectClient: resolvedGoogleConnectClient,
                sessionRunner: ASWebAuthenticationGoogleOAuthSessionRunner()
            )
            self.calendarService = EventKitCalendarConnectService(googleConnectService: googleConnectService)
        }

        if let healthService {
            self.healthService = healthService
        } else if resolvedIsDemoMode {
            // UI tests can opt into simulating a denied HealthKit request
            // (docs/05_UX_FLOWS.md §3.1 "Denied permission") via a launch
            // argument, without needing a real device/OS permission sheet.
            self.healthService = FakeHealthConnectService(simulatesDenial: Self.launchImpliesHealthDenied())
        } else {
            self.healthService = HealthKitConnectService()
        }

        let resolvedHealthSampleReader: any HealthSampleReading
        if let healthSampleReader {
            resolvedHealthSampleReader = healthSampleReader
        } else if resolvedIsDemoMode {
            // Demo Mode uses a fixture-backed reader so "Refresh now" is
            // demoable with zero live HealthKit dependency, matching the
            // `demoDavid`-style fixture persona used elsewhere.
            resolvedHealthSampleReader = FakeHealthSampleReader(
                nextInput: Self.launchImpliesHealthDenied() ? .empty : .demoFixture
            )
        } else {
            resolvedHealthSampleReader = HealthKitSampleReader()
        }

        let resolvedBandUploadClient: any BandUploading
        if let bandUploadClient {
            resolvedBandUploadClient = bandUploadClient
        } else if resolvedIsDemoMode {
            resolvedBandUploadClient = FakeBandUploadClient()
        } else {
            let capturedAuthService = self.authService
            resolvedBandUploadClient = HTTPBandUploadClient(
                baseURL: Self.apiBaseURL,
                idTokenProvider: { try await capturedAuthService.idToken() }
            )
        }

        // Same test-isolation rationale as the preferences suite reset
        // below, for the Data & Privacy screen's consent toggles. Resolved
        // (and reset) *before* `bandUploadService` below, since
        // `BandUploadService` now needs a `ConsentStore` injected at
        // construction time (issue #70).
        if ProcessInfo.processInfo.environment["UITEST_RESET_CONSENT_DEFAULTS_SUITE"] == "1" {
            for category in ConsentCategory.allCases {
                UserDefaults.standard.removeObject(forKey: "com.kairos.consent.v1.\(category.rawValue)")
            }
        }

        let resolvedConsentStore: any ConsentStore
        if let consentStore {
            resolvedConsentStore = consentStore
        } else if resolvedIsDemoMode && !Self.launchImpliesRealPreferencesStore() {
            // Reuses the same UI-test escape hatch as
            // `launchImpliesRealPreferencesStore` — a test that wants real
            // on-device persistence for preferences wants it for consent
            // toggles too (both are "does this survive relaunch" screens).
            resolvedConsentStore = InMemoryConsentStore()
        } else {
            resolvedConsentStore = UserDefaultsConsentStore()
        }
        self.consentStore = resolvedConsentStore

        self.bandUploadService = BandUploadService(
            healthReader: resolvedHealthSampleReader,
            uploadClient: resolvedBandUploadClient,
            consentStore: resolvedConsentStore
        )

        // Wire EventKit slot collection into the background refresh scheduler
        // (issue #27 C6). In Demo Mode no real EKEventStore is used and the
        // scheduler gets nil collectors so it skips silently. In real launches
        // the collector reads only start/end timestamps from EKEvent objects
        // (never titles, attendees, or notes — Foundation §8).
        let resolvedSlotCollector: EventKitSlotCollector?
        let resolvedSlotsUploadClient: (any SlotsUploading)?
        if resolvedIsDemoMode {
            resolvedSlotCollector = nil
            resolvedSlotsUploadClient = nil
        } else {
            resolvedSlotCollector = EventKitSlotCollector(eventStore: .init())
            let capturedAuthServiceForSlots = self.authService
            resolvedSlotsUploadClient = SlotsUploadClient(
                baseURL: Self.apiBaseURL,
                getIdToken: { try await capturedAuthServiceForSlots.idToken() }
            )
        }

        self.backgroundBandRefreshScheduler = BackgroundBandRefreshScheduler(
            bandUploadService: self.bandUploadService,
            slotCollector: resolvedSlotCollector,
            slotsUploadClient: resolvedSlotsUploadClient
        )

        // Test isolation: a UI test that wants a clean slate for the real
        // `UserDefaultsPreferencesStore` (rather than whatever a previous
        // run on this simulator left behind) sets this env var. Cleared
        // before the store is constructed so it's never observed by app
        // code as "restored from a previous run."
        if ProcessInfo.processInfo.environment["UITEST_RESET_PREFERENCES_DEFAULTS_SUITE"] == "1" {
            UserDefaults.standard.removeObject(forKey: "com.kairos.preferences.v1")
        }

        // Hoisted out of the real-store branch below (issue #225): the sync
        // client is no longer only the store's push collaborator — it is
        // also what `PreferencesSyncCoordinator` pulls through — so it has
        // to outlive that branch, the same way `googleConnectClient` was
        // promoted by #213 when revoke needed it.
        let resolvedRemoteSync: (any RemotePreferencesSyncing)?
        if let remoteSync {
            resolvedRemoteSync = remoteSync
        } else if resolvedIsDemoMode {
            // Demo Mode backs auth with `FakeAuthService`, so there is no
            // real token to mint and nothing to talk to. Matches
            // `resolvedBandUploadClient`'s split above.
            resolvedRemoteSync = nil
        } else {
            let capturedAuthServiceForPreferences = self.authService
            resolvedRemoteSync = HTTPPreferencesClient(
                baseURL: Self.apiBaseURL,
                idTokenProvider: { try await capturedAuthServiceForPreferences.idToken() }
            )
        }

        if let preferencesStore {
            self.preferencesStore = preferencesStore
        } else if resolvedIsDemoMode && !Self.launchImpliesRealPreferencesStore() {
            self.preferencesStore = InMemoryPreferencesStore()
        } else {
            // Real on-device persistence. Also used in Demo Mode when a UI
            // test explicitly asks for it (see `launchImpliesRealPreferencesStore`)
            // so a relaunch-persistence UI test can exercise the real
            // `UserDefaultsPreferencesStore` without any live
            // Firebase/EventKit/network dependency — demo mode still backs
            // auth/calendar/health with fakes regardless of this flag, so
            // `remoteSync` stays `nil` in that branch (matching
            // `resolvedBandUploadClient`'s own demo-mode split above).
            self.preferencesStore = UserDefaultsPreferencesStore(remoteSync: resolvedRemoteSync)
        }

        if let accountDeletionClient {
            self.accountDeletionClient = accountDeletionClient
        } else if resolvedIsDemoMode {
            self.accountDeletionClient = FakeAccountDeletionClient()
        } else {
            let capturedAuthService = self.authService
            self.accountDeletionClient = HTTPAccountDeletionClient(
                baseURL: Self.apiBaseURL,
                idTokenProvider: { try await capturedAuthService.idToken() }
            )
        }

        if let distressCheckinClient {
            self.distressCheckinClient = distressCheckinClient
        } else if resolvedIsDemoMode {
            self.distressCheckinClient = FakeDistressCheckinClient()
        } else {
            let capturedAuthService = self.authService
            self.distressCheckinClient = HTTPDistressCheckinClient(
                baseURL: Self.apiBaseURL,
                idTokenProvider: { try await capturedAuthService.idToken() }
            )
        }

        // Dashboard clients (issue #252). Demo mode wires the DashboardDemoData
        // fakes so the signed-in Home is populated offline; otherwise real HTTP
        // clients against the same API base + Firebase ID token.
        if resolvedIsDemoMode {
            self.devotionalsClient = DashboardDemoData.devotionals()
            self.upcomingEventsClient = DashboardDemoData.upcoming()
            self.freeBusyClient = DashboardDemoData.freeBusy()
            self.connectionsClient = DashboardDemoData.connections()
            self.recapClient = DashboardDemoData.recap()
            self.journalClient = DashboardDemoData.journal()
            self.liturgyClient = DashboardDemoData.liturgy()
            self.accountInfoClient = DashboardDemoData.accountInfo()
            self.generateNowClient = DashboardDemoData.generateNow()
        } else {
            let captured = self.authService
            let token: @Sendable () async throws -> String = { try await captured.idToken() }
            self.devotionalsClient = HTTPDevotionalsClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.upcomingEventsClient = HTTPUpcomingEventsClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.freeBusyClient = HTTPFreeBusyClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.connectionsClient = HTTPConnectionsClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.recapClient = HTTPRecapClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.journalClient = HTTPJournalClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.liturgyClient = HTTPLiturgyClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.accountInfoClient = HTTPAccountInfoClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
            self.generateNowClient = HTTPGenerateNowClient(baseURL: Self.apiBaseURL, idTokenProvider: token)
        }

        // Test isolation, same rationale as the preferences/consent suite
        // resets above: a UI test that wants a fresh "never completed
        // onboarding" state for the real `UserDefaultsOnboardingCompletionStore`
        // sets this env var.
        if ProcessInfo.processInfo.environment["UITEST_RESET_ONBOARDING_COMPLETION_SUITE"] == "1" {
            UserDefaults.standard.removeObject(forKey: "com.kairos.onboarding.completed.v1")
        }

        if let onboardingCompletionStore {
            self.onboardingCompletionStore = onboardingCompletionStore
        } else if resolvedIsDemoMode && !Self.launchImpliesRealPreferencesStore() {
            // Reuses the same UI-test escape hatch as
            // `launchImpliesRealPreferencesStore`/the consent store above —
            // a test that wants real on-device persistence for one wants it
            // for all three "survives relaunch" screens/flags.
            self.onboardingCompletionStore = InMemoryOnboardingCompletionStore(initial: Self.launchImpliesOnboardingComplete())
        } else {
            self.onboardingCompletionStore = UserDefaultsOnboardingCompletionStore()
        }

        // Constructed last: it needs all three stores, and the onboarding
        // one is resolved immediately above (issue #225).
        if let resolvedRemoteSync {
            self.preferencesSyncCoordinator = PreferencesSyncCoordinator(
                remoteSync: resolvedRemoteSync,
                preferencesStore: self.preferencesStore,
                consentStore: self.consentStore,
                onboardingCompletionStore: self.onboardingCompletionStore
            )
        } else {
            self.preferencesSyncCoordinator = nil
        }
    }

    /// Composition helper for the Data & Privacy screen (issue #39):
    /// assembles a `DataPrivacyViewModel` from this environment's real
    /// services every time it's called, so `PreferencesView`'s
    /// `NavigationLink` always gets a fresh view model reflecting current
    /// state rather than one captured at app-launch time.
    @MainActor
    public func makeDataPrivacyViewModel() -> DataPrivacyViewModel {
        DataPrivacyViewModel(
            consentStore: consentStore,
            calendarService: calendarService,
            ledgerProvider: BandUploadLedgerProvider(
                bandUploadService: bandUploadService
            ),
            deletionClient: accountDeletionClient,
            authService: authService,
            googleConnectClient: googleConnectClient,
            // Issue #225: consent toggles write through to the server
            // columns as well as the device store.
            syncCoordinator: preferencesSyncCoordinator
        )
    }

    /// Composition helper for the signed-in Home dashboard (issue #252):
    /// assembles a `HomeViewModel` from this environment's dashboard clients.
    @MainActor
    public func makeHomeViewModel() -> HomeViewModel {
        HomeViewModel(
            devotionals: devotionalsClient,
            upcomingClient: upcomingEventsClient,
            connectionsClient: connectionsClient,
            recapClient: recapClient,
            journalClient: journalClient,
            liturgyClient: liturgyClient,
            generateNowClient: generateNowClient,
            accountInfo: accountInfoClient,
            freeBusyClient: freeBusyClient,
            calendarService: calendarService
        )
    }

    /// Composition helper for the History tab (backlog #4): assembles a
    /// `HistoryViewModel` from this environment's devotionals client, so the
    /// full-screen archive shares the same data source as the Home dashboard's
    /// "Your devotionals" card.
    @MainActor
    public func makeHistoryViewModel() -> HistoryViewModel {
        HistoryViewModel(devotionals: devotionalsClient)
    }

    /// UI-test-only escape hatch (see `launchImpliesDemoMode` doc for why
    /// this is checked the same way): lets `PreferencesPersistenceUITests`
    /// prove real `UserDefaultsPreferencesStore` persistence survives an
    /// app relaunch, while every other service in the same launch stays
    /// fake/in-memory (still demo mode).
    /// Demo/UI-test hook (issue #252): start already onboarded so a launch
    /// lands straight on the signed-in Home dashboard, for screenshotting and
    /// Home UI tests, without driving the whole onboarding flow first.
    private static func launchImpliesOnboardingComplete() -> Bool {
        if UserDefaults.standard.string(forKey: "UITEST_ONBOARDING_COMPLETE") != nil { return true }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("UITEST_ONBOARDING_COMPLETE") }) { return true }
        return false
    }

    private static func launchImpliesRealPreferencesStore() -> Bool {
        if UserDefaults.standard.string(forKey: "UITEST_REAL_PREFERENCES_STORE") != nil {
            return true
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("UITEST_REAL_PREFERENCES_STORE") }) {
            return true
        }
        return false
    }

    /// Demo Mode / UI test launch detection (docs/05_UX_FLOWS.md §3.1
    /// "Demo mode"): driven by a launch argument so XCUITest can request
    /// fixture-backed services without any live Firebase/EventKit/network
    /// dependency, per docs/00_FOUNDATION.md §11.
    ///
    /// Checked three ways so this is robust to how the flag was actually
    /// passed in: `XCUIApplication.launchArguments = ["-UITEST_MODE", "1"]`
    /// is parsed by Foundation as a `-key value` pair and surfaces via
    /// `UserDefaults` (NOT as a literal "-UITEST_MODE" string in
    /// `ProcessInfo.arguments`), but a bare `"UITEST_MODE"` argument (no
    /// leading dash, no value) would show up directly in `arguments`. The
    /// environment-variable path covers manual `simctl launch` invocations
    /// during debugging.
    private static func launchImpliesDemoMode() -> Bool {
        if UserDefaults.standard.string(forKey: "UITEST_MODE") != nil {
            return true
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("UITEST_MODE") }) {
            return true
        }
        if ProcessInfo.processInfo.environment["KAIROS_DEMO_MODE"] == "1" {
            return true
        }
        return false
    }

    /// See `launchImpliesDemoMode` for why this is checked three ways.
    private static func launchImpliesHealthDenied() -> Bool {
        if UserDefaults.standard.string(forKey: "UITEST_HEALTH_DENIED") != nil {
            return true
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("UITEST_HEALTH_DENIED") }) {
            return true
        }
        return false
    }

    /// See `launchImpliesDemoMode` for why this is checked three ways.
    private static func launchImpliesCalendarDenied() -> Bool {
        if UserDefaults.standard.string(forKey: "UITEST_CALENDAR_DENIED") != nil {
            return true
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("UITEST_CALENDAR_DENIED") }) {
            return true
        }
        return false
    }
}
