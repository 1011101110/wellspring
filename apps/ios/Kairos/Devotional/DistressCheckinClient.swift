import Foundation

/// Errors a `DistressCheckinClient.checkInNow()` call can surface — same
/// shape as `PreferencesSyncError`/`SlotsUploadError`.
public enum DistressCheckinError: Error, Equatable, LocalizedError {
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

/// The subset of `POST /v1/devotional/generate-now`'s success response this
/// app needs: where to open the session, so the "I could use a moment now"
/// button can jump straight there.
public struct DistressCheckinResult: Equatable, Sendable {
    public let sessionUrl: URL

    public init(sessionUrl: URL) {
        self.sessionUrl = sessionUrl
    }
}

/// Protocol seam for the distress check-in front door (docs/14_IMPROVEMENT_REVIEW.md
/// §5.8, issue #77), so `HomeView`/its view model and tests can depend on
/// the abstraction rather than the concrete HTTP implementation — mirrors
/// `SlotsUploading`/`RemotePreferencesSyncing`.
public protocol DistressCheckinRequesting: AnyObject, Sendable {
    /// Fires an immediate `distressSignal: true` generation. Throws
    /// `DistressCheckinError` on any failure.
    func checkInNow() async throws -> DistressCheckinResult
}

/// HTTP client for `POST /v1/devotional/generate-now`
/// (`apps/api/src/routes/userScoped.ts`'s distress check-in route). The
/// request body is always empty — this route only ever means "I need
/// comfort now," so there is nothing for the client to configure; the
/// backend forces `distressSignalOverride`/`skipIdempotencyCheck`/`skipCalendar`
/// itself.
///
/// `baseURL` is always injected (from `AppEnvironment.apiBaseURL`) and auth
/// follows the same Firebase-ID-token-bearer pattern as
/// `HTTPPreferencesClient`/`SlotsUploadClient` — no client in this app
/// carries a URL literal of its own.
public final class HTTPDistressCheckinClient: DistressCheckinRequesting, @unchecked Sendable {
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

    public func checkInNow() async throws -> DistressCheckinResult {
        let token: String
        do {
            token = try await idTokenProvider()
        } catch {
            throw DistressCheckinError.notAuthenticated
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/devotional/generate-now"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw DistressCheckinError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw DistressCheckinError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw DistressCheckinError.server(statusCode: http.statusCode)
        }

        let decoded: DistressCheckinResponseBody
        do {
            decoded = try JSONDecoder().decode(DistressCheckinResponseBody.self, from: data)
        } catch {
            throw DistressCheckinError.network("Malformed response body.")
        }
        guard let sessionUrl = URL(string: decoded.sessionUrl) else {
            throw DistressCheckinError.network("Malformed sessionUrl.")
        }
        return DistressCheckinResult(sessionUrl: sessionUrl)
    }
}

struct DistressCheckinResponseBody: Decodable {
    let ok: Bool
    let sessionUrl: String
    let devotionalId: String
}

/// In-memory `DistressCheckinRequesting` for unit tests and previews —
/// mirrors `FakePreferencesSyncClient`/`FakeSlotsUploadClient`.
public final class FakeDistressCheckinClient: DistressCheckinRequesting, @unchecked Sendable {
    public var nextError: DistressCheckinError?
    public var nextResult: DistressCheckinResult = DistressCheckinResult(
        sessionUrl: URL(string: "https://kairos-api.test/session/fake-token")!
    )
    public private(set) var checkInCallCount = 0

    public init(nextError: DistressCheckinError? = nil) {
        self.nextError = nextError
    }

    public func checkInNow() async throws -> DistressCheckinResult {
        checkInCallCount += 1
        if let nextError {
            throw nextError
        }
        return nextResult
    }
}
