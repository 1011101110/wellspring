import Foundation

/// Errors an `HTTPPreferencesClient` call can surface — same shape as
/// `BandUploadError`/`AccountDeletionError`.
public enum PreferencesSyncError: Error, Equatable, LocalizedError {
    case notAuthenticated
    case network(String)
    case server(statusCode: Int)

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Not signed in."
        case .network(let detail):
            return "Network problem: \(detail)"
        case .server(let statusCode):
            return "Server error (\(statusCode))."
        }
    }
}

/// Real `RemotePreferencesSyncing` conformance: `GET`/`PUT {baseURL}/v1/preferences`
/// with a Firebase Auth JWT bearer token, mirroring `HTTPBandUploadClient`'s
/// auth pattern (issue #85).
///
/// `OnboardingPreferences` (iOS) and the `preferences` table (backend,
/// `packages/shared-contracts/src/api/preferences.ts`) don't line up
/// field-for-field, so this client makes a deliberate, lossy mapping in
/// both directions rather than pretending the two models are the same
/// shape:
///  - `workdayStartHour`/`workdayEndHour` <-> `windowStartLocal`/`windowEndLocal`
///    via `"HH:00"` formatting. Minutes are always `:00` on the way out —
///    this app has never offered sub-hour precision — and only the hour
///    component is read back on the way in.
///  - `days` (`Weekday`, Sun=1...Sat=7) <-> `activeDays` (Sun=0...Sat=6) via
///    a `rawValue - 1` / `rawValue + 1` offset.
///  - `cadence` is a *label* over `days`, not a second setting (K2, #188):
///    derived from the day set on the way out (`OnboardingPreferences.cadence`)
///    and ignored entirely on the way in, since `activeDays` in the same
///    payload already carries the choice. The server applies the identical
///    derivation on write (`cadenceForActiveDays`, shared-contracts), so a
///    contradictory pair cannot be produced at either end — which matters
///    because every row written before #188 *is* one (`cadence: "daily"`
///    beside `activeDays: [1,2,3,4,5]` was the column default).
///  - `duration` (`DurationPreference`, includes `.auto`) <-> `durationPreference`
///    (`DevotionalFormatSchema`, no `.auto` — the backend has no
///    "auto-pick a length" concept). `.auto` is omitted from the push
///    payload entirely rather than forced into a fabricated value; an
///    unrecognized value on pull falls back to `.auto`.
///  - `voice` (`VoiceChoice.rawValue`, one of `warm`/`calm`/`bright`) <->
///    `voice` (a real TTS voice id string, e.g. `"en-US-Chirp3-HD-Kore"`).
///    This mismatch already exists in the schema's own doc comment and is
///    out of scope to fix here; an unrecognized value on pull falls back
///    to `.warm` rather than throwing.
///  - `stillness` (`StillnessPreference.rawValue`, one of `off`/`brief`/`full`)
///    <-> `stillness` (same string values, plain `text` column server-side) —
///    the one field here with an exact 1:1 string mapping; an unrecognized
///    value on pull falls back to `.off`.
///  - `tradition`/`translation` are not synced at all — those live on
///    `users`, not `preferences` (per the schema's own doc comment), so
///    there is no server value to push or pull; `pull()` fills them with
///    `OnboardingPreferences`'s own defaults.
///  - `calendarEnabled`/`healthEnabled` are no longer omitted (issue #225).
///    They have no representation in `OnboardingPreferences` — they come
///    from `ConsentStore` via `ConsentSyncMapping` — and are sent only when
///    the caller supplies a `RemoteConsentWrite`, so an ordinary
///    preferences save still leaves the server's consent columns alone.
///    `communicationEnabled` is read but never written (no device toggle
///    governs it) and `notifyOnSkip` is neither (docs/03 §10 lists it as
///    the one remaining dead field).
///  - `examenEnabled` (`Bool`) <-> `examenEnabled` (`Bool`, issue #77) — a
///    plain 1:1 boolean, same as `stillness`.
///  - `timezone` is push-only and comes from `TimeZone.current.identifier`
///    rather than from `OnboardingPreferences` (issue #187) — it lands on
///    `users`, not `preferences`, so `pull()` has nothing to read back.
public final class HTTPPreferencesClient: RemotePreferencesSyncing, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let idTokenProvider: @Sendable () async throws -> String

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        idTokenProvider: @escaping @Sendable () async throws -> String
    ) {
        self.baseURL = baseURL
        self.session = session
        self.idTokenProvider = idTokenProvider
    }

    public func push(
        _ preferences: OnboardingPreferences,
        consent: RemoteConsentWrite?,
        onboardingCompleted: Bool
    ) async throws {
        let token = try await authorizedToken()

        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("v1/preferences"))
        urlRequest.httpMethod = "PUT"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.httpBody = try JSONEncoder().encode(
            Self.updateBody(for: preferences, consent: consent, onboardingCompleted: onboardingCompleted)
        )

        let (_, response) = try await performRequest(urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw PreferencesSyncError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PreferencesSyncError.server(statusCode: http.statusCode)
        }
    }

    public func pull() async throws -> RemoteUserState? {
        let token = try await authorizedToken()

        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("v1/preferences"))
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await performRequest(urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw PreferencesSyncError.network("No HTTP response.")
        }
        // A brand-new user has no `preferences` row until the first `PUT`
        // (`PreferencesRepository.ensureExists` is only called from that
        // route) — 404 here is the documented "no stored value yet" case,
        // not an error.
        if http.statusCode == 404 {
            return nil
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PreferencesSyncError.server(statusCode: http.statusCode)
        }

        let decoded: PreferencesGetResponseBody
        do {
            decoded = try JSONDecoder().decode(PreferencesGetResponseBody.self, from: data)
        } catch {
            throw PreferencesSyncError.network("Malformed response body.")
        }
        return Self.remoteUserState(from: decoded.data)
    }

    private func authorizedToken() async throws -> String {
        do {
            return try await idTokenProvider()
        } catch {
            throw PreferencesSyncError.notAuthenticated
        }
    }

    private func performRequest(_ urlRequest: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: urlRequest)
        } catch {
            throw PreferencesSyncError.network(error.localizedDescription)
        }
    }

    /// `timeZoneIdentifier` defaults to the device's current zone and is a
    /// parameter only so tests can pin it — production always passes the
    /// real one (see `timezone` on `PreferencesUpdateRequestBody`).
    static func updateBody(
        for preferences: OnboardingPreferences,
        consent: RemoteConsentWrite? = nil,
        onboardingCompleted: Bool = false,
        timeZoneIdentifier: String = TimeZone.current.identifier
    ) -> PreferencesUpdateRequestBody {
        return PreferencesUpdateRequestBody(
            windowStartLocal: hhMM(preferences.workdayStartHour),
            windowEndLocal: hhMM(preferences.workdayEndHour),
            activeDays: preferences.days.map { $0.rawValue - 1 }.sorted(),
            // Derived from `days` by `OnboardingPreferences.cadence` (K2,
            // #188), which is the same derivation the server applies to
            // whatever we send — so the two ends of the wire cannot end up
            // holding different theories about which field is
            // authoritative. Sent at all only because the column exists
            // and other readers (the settings screen on another device)
            // display it.
            cadence: preferences.cadence.rawValue,
            durationPreference: preferences.duration == .auto ? nil : preferences.duration.rawValue,
            voice: preferences.voice.rawValue,
            stillness: preferences.stillness.rawValue,
            examenEnabled: preferences.examenEnabled,
            // Absent unless the caller is making a genuine consent
            // statement (issue #225). `nil` here encodes to an omitted key,
            // which the server COALESCEs — so a routine preferences sync
            // cannot restate, and thereby resurrect, a consent decision
            // made on another surface. See `RemoteConsentWrite`.
            calendarEnabled: consent?.calendarEnabled,
            healthEnabled: consent?.healthEnabled,
            timezone: timeZoneIdentifier,
            // `nil` rather than `false` when not asserting completion: the
            // server's schema is `z.literal(true).optional()`, so a literal
            // `false` on the wire is a 400 by design (there is no
            // "un-onboard me"). Sending the key only when it is `true`
            // keeps every ordinary sync silent on the subject.
            onboardingCompleted: onboardingCompleted ? true : nil
        )
    }

    /// Decodes the full server snapshot, not just preferences (issue #225).
    ///
    /// `onboardedAt` is parsed with a fractional-seconds-tolerant ISO-8601
    /// strategy because the server emits `Date.toISOString()`, which always
    /// includes milliseconds — `ISO8601DateFormatter`'s default options do
    /// not accept them and would silently yield `nil`. A `nil` here is
    /// indistinguishable from "never onboarded" downstream, so a formatter
    /// mismatch would present exactly as the re-onboarding bug this issue
    /// exists to fix. Hence both formatters, tried in order.
    static func remoteUserState(from data: PreferencesResponseDataBody) -> RemoteUserState {
        RemoteUserState(
            preferences: onboardingPreferences(from: data).validated(),
            onboardedAt: data.onboardedAt.flatMap(Self.parseISO8601),
            consent: RemoteConsentFlags(
                calendarEnabled: data.calendarEnabled,
                healthEnabled: data.healthEnabled,
                communicationEnabled: data.communicationEnabled
            )
        )
    }

    private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601Plain = ISO8601DateFormatter()

    static func parseISO8601(_ value: String) -> Date? {
        iso8601WithFractionalSeconds.date(from: value) ?? iso8601Plain.date(from: value)
    }

    static func onboardingPreferences(from data: PreferencesResponseDataBody) -> OnboardingPreferences {
        OnboardingPreferences(
            workdayStartHour: hour(from: data.windowStartLocal) ?? OnboardingPreferences.defaults.workdayStartHour,
            workdayEndHour: hour(from: data.windowEndLocal) ?? OnboardingPreferences.defaults.workdayEndHour,
            // `data.cadence` is deliberately NOT read (K2, #188). It is a
            // label over this same day set, so reading it could only
            // introduce a disagreement — and rows written before #188
            // genuinely carry one (`cadence: "daily"` next to Mon–Fri was
            // the column default of every row). The days are the choice;
            // `OnboardingPreferences.cadence` re-derives the label.
            days: Set(data.activeDays.compactMap { Weekday(rawValue: $0 + 1) }),
            duration: DurationPreference(rawValue: data.durationPreference) ?? .auto,
            tradition: OnboardingPreferences.defaults.tradition,
            translation: OnboardingPreferences.defaults.translation,
            voice: VoiceChoice(rawValue: data.voice) ?? .warm,
            stillness: StillnessPreference(rawValue: data.stillness) ?? .off,
            examenEnabled: data.examenEnabled
        )
    }

    private static func hhMM(_ hour: Int) -> String {
        String(format: "%02d:00", hour)
    }

    private static func hour(from windowLocal: String) -> Int? {
        let hourComponent = windowLocal.split(separator: ":").first
        return hourComponent.flatMap { Int($0) }
    }
}

struct PreferencesUpdateRequestBody: Encodable, Equatable {
    let windowStartLocal: String?
    let windowEndLocal: String?
    let activeDays: [Int]?
    let cadence: String?
    let durationPreference: String?
    let voice: String?
    let stillness: String?
    let examenEnabled: Bool?
    /// The two consent columns iOS is entitled to write (issue #225,
    /// docs/03 §10.4). `nil` omits the key entirely — see
    /// `RemoteConsentWrite` for why "no opinion" and "false" must stay
    /// distinguishable on this wire.
    let calendarEnabled: Bool?
    let healthEnabled: Bool?
    /// `TimeZone.current.identifier` (issue #187). The one field here that
    /// doesn't come from `OnboardingPreferences` at all, and the one that
    /// doesn't land on the `preferences` table server-side — it writes
    /// `users.timezone`, which defaulted to `UTC` and, until recently,
    /// nothing ever set: the first real connected user got a devotional
    /// gap at 07:30 UTC, 3:30am where they live.
    ///
    /// Sent on EVERY push, not just the first. It costs nothing (the sync
    /// is already in flight) and it is what makes a relocation actually
    /// take effect. The server ranks this as the lowest non-default
    /// source, so re-sending it can never overwrite a calendar-derived
    /// zone or a zone the user picked by hand — the precedence lives
    /// there, deliberately, so no client has to implement it correctly.
    let timezone: String?
    /// Asserts onboarding completion server-side (issue #225). Only ever
    /// `true` or absent — never `false`, which the server rejects with a
    /// 400 on purpose. See `PreferencesUpdateRequestSchema` in
    /// shared-contracts.
    let onboardingCompleted: Bool?
}

struct PreferencesGetResponseBody: Decodable {
    let ok: Bool
    let data: PreferencesResponseDataBody
}

struct PreferencesResponseDataBody: Decodable, Equatable {
    let userId: String
    let windowStartLocal: String
    let windowEndLocal: String
    let activeDays: [Int]
    let cadence: String
    let durationPreference: String
    let voice: String
    let stillness: String
    let examenEnabled: Bool
    let calendarEnabled: Bool
    let healthEnabled: Bool
    let communicationEnabled: Bool
    let notifyOnSkip: Bool
    /// `users.onboarded_at` as an ISO-8601 string, or `nil` if the server
    /// has no record (issue #225). Optional on this side — not merely
    /// nullable — so that a response from a server predating #225, which
    /// omits the key entirely, decodes rather than throwing. A decode
    /// failure would surface as a `.network("Malformed response body.")`
    /// and take the whole pull down, including the preferences that
    /// decoded perfectly well.
    let onboardedAt: String?
    let updatedAt: String
}

/// In-memory `RemotePreferencesSyncing` for unit tests and previews —
/// mirrors `FakeBandUploadClient`/`FakeAccountDeletionClient`.
public final class FakePreferencesSyncClient: RemotePreferencesSyncing, @unchecked Sendable {
    /// One recorded `push`, kept whole so tests can assert on the side-car
    /// fields (#225) and not just the preferences payload — "iOS now writes
    /// consent and onboarding" is exactly the claim that needs proving.
    public struct RecordedPush: Equatable, Sendable {
        public let preferences: OnboardingPreferences
        public let consent: RemoteConsentWrite?
        public let onboardingCompleted: Bool
    }

    public var nextPushError: PreferencesSyncError?
    public var nextPullError: PreferencesSyncError?
    public var pullResult: RemoteUserState?
    /// Invoked at the top of `pull()`, before the error check — the seam
    /// tests use to simulate a local save landing while a pull is in
    /// flight (see `PreferencesStore.localWriteGeneration`).
    public var onPull: (@Sendable () -> Void)?
    public private(set) var pushes: [RecordedPush] = []
    public private(set) var pullCallCount = 0

    /// Preferences from every recorded push, for the many existing tests
    /// that only care about that.
    public var pushedPreferences: [OnboardingPreferences] { pushes.map(\.preferences) }

    public init(
        pullResult: RemoteUserState? = nil,
        nextPushError: PreferencesSyncError? = nil,
        nextPullError: PreferencesSyncError? = nil
    ) {
        self.pullResult = pullResult
        self.nextPushError = nextPushError
        self.nextPullError = nextPullError
    }

    public func push(
        _ preferences: OnboardingPreferences,
        consent: RemoteConsentWrite?,
        onboardingCompleted: Bool
    ) async throws {
        if let nextPushError {
            throw nextPushError
        }
        pushes.append(
            RecordedPush(
                preferences: preferences,
                consent: consent,
                onboardingCompleted: onboardingCompleted
            )
        )
    }

    public func pull() async throws -> RemoteUserState? {
        pullCallCount += 1
        onPull?()
        if let nextPullError {
            throw nextPullError
        }
        return pullResult
    }
}
