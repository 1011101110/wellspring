import Foundation

/// Errors from the `GET /v1/connect/google` call that starts the OAuth
/// handshake (issue #124). Distinct from `CalendarConnectError` — this is
/// the narrow HTTP-mechanics failure set; `GoogleCalendarConnectService`
/// maps these into `CalendarConnectError` at the boundary.
///
/// Deliberately NOT a typealias of the shared `APIError` (#345, unlike
/// `BandUploadError` et al.): the extra `malformedResponse` case makes the
/// shapes differ, and collapsing it would churn the seam this client's
/// service and tests pattern-match on. The three shared cases delegate
/// their user-facing copy to `APIError` so the wording has one source.
public enum GoogleConnectClientError: Error, Equatable, LocalizedError {
    case notAuthenticated
    case network(String)
    case server(statusCode: Int)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return APIError.notAuthenticated.errorDescription
        case .network(let detail):
            return APIError.network(detail).errorDescription
        case .server(let statusCode):
            return APIError.server(statusCode: statusCode).errorDescription
        case .malformedResponse:
            return "Unexpected response from the server."
        }
    }
}

/// Abstraction over "how the app talks to the backend's Google connection
/// endpoints." Kept as a protocol (same pattern as `BandUploading`/
/// `PreferencesSyncing`) so `GoogleCalendarConnectService` and
/// `DataPrivacyViewModel` are unit-testable against a fake, with no live
/// network dependency.
public protocol GoogleConnecting: AnyObject, Sendable {
    /// Calls `GET /v1/connect/google` with `Accept: application/json` and
    /// the caller's Firebase ID token, returning the `authUrl` to open in
    /// `ASWebAuthenticationSession` (docs/16_CALENDAR_INTEGRATION.md §1 —
    /// the JSON branch of that route exists specifically "for API
    /// clients," which is exactly what this is).
    func fetchAuthorizationURL() async throws -> URL

    /// Calls `DELETE /v1/connect/google` — the server-side *revoke* (issue
    /// #213). This is the half of "disconnect" that actually stops Kairos
    /// reading the calendar: the backend revokes the refresh token with
    /// Google and flips `connections.status` to `revoked`
    /// (`apps/api/src/services/calendar/revokeGoogleConnection.ts`,
    /// docs/04_DATA_PRIVACY_SECURITY.md §2).
    ///
    /// Before #213 this route existed, worked, and was called by no client
    /// at all — `DataPrivacyViewModel.disconnectCalendar()` did three local
    /// writes, displayed "Not connected," and left the backend holding a
    /// live token that kept querying free/busy every day. That directly
    /// contradicted docs/00_FOUNDATION.md §8's "independent, *revocable*
    /// opt-in," which is why this is a P0 privacy defect rather than a
    /// missing feature.
    ///
    /// Returns normally only on a 2xx. Every failure throws, because the
    /// one thing the caller must never do is report success it didn't get.
    func disconnect() async throws
}

/// Real implementation: `GET {baseURL}/v1/connect/google` with a Firebase
/// Auth JWT bearer token, mirroring `HTTPBandUploadClient`/
/// `HTTPPreferencesClient`'s construction exactly (`baseURL` always
/// injected by the caller — `AppEnvironment.apiBaseURL` — never a literal
/// of this type's own, per issue #71's "one configuration point" rule).
public final class HTTPGoogleConnectClient: GoogleConnecting, @unchecked Sendable {
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

    public func fetchAuthorizationURL() async throws -> URL {
        let data = try await send(method: "GET")

        guard
            let decoded = try? JSONDecoder().decode(AuthorizationURLResponse.self, from: data),
            let url = URL(string: decoded.authUrl)
        else {
            throw GoogleConnectClientError.malformedResponse
        }
        return url
    }

    /// Issue #213. The response body (`{ ok: true }`) is deliberately *not*
    /// decoded: the route sends that shape unconditionally after
    /// `revokeGoogleConnection` returns, so a 2xx already carries the whole
    /// signal, and decoding it would only add a `malformedResponse` failure
    /// mode that could make a revoke the server genuinely performed look
    /// like it failed. Erring toward "we say it failed when it succeeded"
    /// is the safe direction here (the user retries, the backend no-ops on
    /// an already-revoked connection) — but only because a 2xx is a real
    /// server-side revoke, which is why anything else must throw.
    public func disconnect() async throws {
        _ = try await send(method: "DELETE")
    }

    /// Shared transport for both `/v1/connect/google` calls, so the DELETE
    /// added in #213 cannot drift from the GET's auth/error handling — the
    /// bearer token, the `notAuthenticated` mapping, the non-HTTP-response
    /// guard and the 2xx check are all defined exactly once.
    private func send(method: String) async throws -> Data {
        let token: String
        do {
            token = try await idTokenProvider()
        } catch {
            throw GoogleConnectClientError.notAuthenticated
        }

        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("v1/connect/google"))
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch {
            throw GoogleConnectClientError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw GoogleConnectClientError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw GoogleConnectClientError.server(statusCode: http.statusCode)
        }
        return data
    }

    private struct AuthorizationURLResponse: Decodable {
        let ok: Bool
        let authUrl: String
    }
}

/// In-memory `GoogleConnecting` for unit tests and previews.
public final class FakeGoogleConnectClient: GoogleConnecting, @unchecked Sendable {
    public var nextURL: URL = URL(string: "https://accounts.google.com/o/oauth2/v2/auth?mock=1")!
    public var nextError: GoogleConnectClientError?
    public private(set) var fetchCallCount = 0

    /// Separate from `nextError` (issue #213) so a test can fail the
    /// disconnect while leaving connect working, and vice versa — the two
    /// directions have genuinely different failure consequences and are
    /// asserted independently.
    public var nextDisconnectError: GoogleConnectClientError?
    public private(set) var disconnectCallCount = 0

    public init() {}

    public func fetchAuthorizationURL() async throws -> URL {
        fetchCallCount += 1
        if let nextError {
            throw nextError
        }
        return nextURL
    }

    public func disconnect() async throws {
        disconnectCallCount += 1
        if let nextDisconnectError {
            throw nextDisconnectError
        }
    }
}
