import Foundation
import BandDeriver

/// Request payload for `POST /v1/bands` (docs/03_API_INTEGRATION_SPEC.md
/// §8.1: "iOS uploads today's five bands (enums only, 00_FOUNDATION §5)").
///
/// Field names and enum spellings mirror `packages/shared-contracts/src/bands.ts`
/// (`BandInputSchema`) exactly — `recovery`/`sleepQuality`/`activity`/
/// `busyness`/`communicationLoad`/`distressSignal` — and the backend's
/// `UpsertDailyBandsInput` (`apps/api/src/db/repositories/dailyBandsRepository.ts`),
/// which takes the same camelCase field names. This app only ever produces
/// the three on-device bands (`recovery`, `sleepQuality`, `activity`) —
/// `busyness` is backend-derived from free/busy data (00_FOUNDATION §5:
/// "Where derived: backend") and `communicationLoad` is an unshipped
/// stretch signal (S4) — so both are sent as `nil`/omitted here rather than
/// invented on-device. `distressSignal` is a manual check-in flag (not
/// HealthKit-derived) and is out of scope for this automatic morning
/// upload; it defaults to `false` (the shared-contracts schema default)
/// exactly like `BandInputSchema.distressSignal.default(false)`.
///
/// `recovery`/`sleepQuality`/`activity` are **optional** (issue #70 /
/// docs/14_IMPROVEMENT_REVIEW.md §1.8): a category the user has withheld
/// consent for, or one HealthKit returned no evidence for, must be
/// omittable from the wire payload entirely rather than forced to carry a
/// fabricated value — the backend's `POST /v1/bands` route is being
/// extended in parallel to accept an omitted key as "withheld," exactly
/// like it already does for `busyness`/`communicationLoad`.
public struct BandUploadRequest: Encodable, Equatable, Sendable {
    public let date: String // YYYY-MM-DD, local calendar day
    public let recovery: String?
    public let sleepQuality: String?
    public let activity: String?
    public let busyness: String?
    public let communicationLoad: String?
    public let distressSignal: Bool

    /// Builds a request from a guaranteed `HealthBands` triple (every
    /// category present). Used by call sites/tests that already have a
    /// full, unconditional derivation and don't need the consent/no-data
    /// omission `init(date:derivedBands:...)` exists for.
    public init(
        date: String,
        bands: HealthBands,
        busyness: String? = nil,
        communicationLoad: String? = nil,
        distressSignal: Bool = false
    ) {
        self.date = date
        self.recovery = bands.recovery.rawValue
        self.sleepQuality = bands.sleepQuality.rawValue
        self.activity = bands.activity.rawValue
        self.busyness = busyness
        self.communicationLoad = communicationLoad
        self.distressSignal = distressSignal
    }

    /// Builds a request from `DerivedBands` (issue #70): any `nil` category
    /// — withheld by consent or lacking evidence — is omitted from the
    /// encoded JSON (see `test_uploadRequest_encodesToJSONWithExpectedKeys`'s
    /// note on `JSONEncoder`'s default `nil`-omission behavior), never
    /// coerced into a fabricated raw value.
    public init(
        date: String,
        derivedBands: DerivedBands,
        busyness: String? = nil,
        communicationLoad: String? = nil,
        distressSignal: Bool = false
    ) {
        self.date = date
        self.recovery = derivedBands.recovery?.rawValue
        self.sleepQuality = derivedBands.sleepQuality?.rawValue
        self.activity = derivedBands.activity?.rawValue
        self.busyness = busyness
        self.communicationLoad = communicationLoad
        self.distressSignal = distressSignal
    }
}

/// The shared `APIError` under the name this client's seam and tests were
/// written against (kairos-devotional #345).
public typealias BandUploadError = APIError

/// Abstraction over "how the app uploads today's bands to the backend."
/// Kept as a protocol (same pattern as `AuthService`/`CalendarConnectService`/
/// `HealthConnectService`) so `BandUploadService` (the orchestrator that
/// also owns the HealthKit-read → BandDeriver step) is fully unit-testable
/// against a fake, with zero live network dependency — matching
/// docs/00_FOUNDATION.md §11 ("Fixture/demo mode is mandatory") and issue
/// #37's note that no backend is reachable from a simulator in a
/// meaningful live way yet.
public protocol BandUploading: AnyObject, Sendable {
    func upload(_ request: BandUploadRequest) async throws
}

/// Real implementation: `POST {baseURL}/v1/bands` with a Firebase Auth JWT
/// bearer token, per docs/03_API_INTEGRATION_SPEC.md §8.1 ("All user
/// routes require a Firebase Auth JWT"). The HTTP mechanics live in the
/// shared `APITransport` (#345); `baseURL` is always injected by the caller
/// (`AppEnvironment.apiBaseURL`, issue #71) — this type has no URL
/// default/literal of its own, so there is exactly one place in the app
/// that decides which host real network calls go to.
public final class HTTPBandUploadClient: BandUploading, @unchecked Sendable {
    private let transport: APITransport

    /// `idTokenProvider` supplies a fresh Firebase Auth ID token for the
    /// `Authorization` header. Injected as a closure (rather than depending
    /// on `AuthService` directly) to keep this client decoupled from the
    /// auth layer's concrete type.
    public init(
        baseURL: URL,
        session: URLSession = .shared,
        idTokenProvider: @escaping @Sendable () async throws -> String
    ) {
        transport = APITransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }

    public func upload(_ request: BandUploadRequest) async throws {
        try await transport.sendNoContent(path: "v1/bands", method: "POST", jsonBody: try JSONEncoder().encode(request))
    }
}

/// In-memory `BandUploading` for unit tests, previews, and Demo Mode.
public final class FakeBandUploadClient: BandUploading, @unchecked Sendable {
    public var nextError: BandUploadError?
    public private(set) var uploadedRequests: [BandUploadRequest] = []

    public init(nextError: BandUploadError? = nil) {
        self.nextError = nextError
    }

    public func upload(_ request: BandUploadRequest) async throws {
        if let nextError {
            throw nextError
        }
        uploadedRequests.append(request)
    }
}
