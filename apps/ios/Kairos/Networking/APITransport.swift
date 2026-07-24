import Foundation

// The shared HTTP plumbing every backend client in this app sits on
// (kairos-devotional #345). `APITransport` began life as `DashboardTransport`
// inside DashboardClients.swift (issue #252); once the legacy hand-rolled
// clients (slots, bands, distress check-in, account deletion, preferences)
// migrated onto it, "Dashboard" stopped describing what it is, so it lives
// here under the name that does. The protocol seams and Fake clients around
// it are untouched — only the HTTP implementations funnel through this.
//
// `baseURL` is always injected from AppEnvironment.apiBaseURL and auth is the
// Firebase-ID-token bearer; no client in this app carries a URL literal of
// its own (issue #71's "one configuration point" rule).

/// The one error shape every HTTP client here surfaces (kairos-devotional
/// #345 — previously seven byte-identical per-client enums). The per-client
/// names (`SlotsUploadError`, `BandUploadError`, …) survive as typealiases so
/// protocol seams, Fakes, and tests keep their exact shapes. The
/// `LocalizedError` copy below is UI-facing and test-pinned — byte-identical
/// to what each per-client enum carried.
public enum APIError: Error, Equatable, LocalizedError {
    case notAuthenticated
    case network(String)
    case server(statusCode: Int)

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Not signed in."
        case .network(let detail): return "Network problem: \(detail)"
        case .server(let statusCode): return "Server error (\(statusCode))."
        }
    }
}

/// The common token → request → status-check → decode flow, factored out so
/// each client stays a thin, declarative wrapper.
struct APITransport: Sendable {
    let baseURL: URL
    let session: URLSession
    let idTokenProvider: @Sendable () async throws -> String

    /// `timeoutInterval` is nil for the URLSession default; the distress
    /// check-in / generate-now route overrides it (see that client's note on
    /// kairos-devotional #296 — the server-side generation takes ~60-90s).
    private func makeRequest(path: String, query: [URLQueryItem], method: String, jsonBody: Data?, timeoutInterval: TimeInterval?) async throws -> URLRequest {
        let token: String
        do { token = try await idTokenProvider() }
        catch { throw APIError.notAuthenticated }

        var url = baseURL.appendingPathComponent(path)
        if !query.isEmpty, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = query
            if let u = comps.url { url = u }
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let jsonBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = jsonBody
        }
        if let timeoutInterval {
            request.timeoutInterval = timeoutInterval
        }
        return request
    }

    /// Returns the decoded body, or throws APIError. `notFoundReturnsNil`
    /// lets probe-style endpoints (search) treat 404 as "unavailable".
    func send<T: Decodable>(
        path: String,
        query: [URLQueryItem] = [],
        method: String = "GET",
        jsonBody: Data? = nil,
        timeoutInterval: TimeInterval? = nil,
        as type: T.Type
    ) async throws -> T {
        let request = try await makeRequest(path: path, query: query, method: method, jsonBody: jsonBody, timeoutInterval: timeoutInterval)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.network(error.localizedDescription) }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(statusCode: http.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.network("Malformed response body.") }
    }

    /// For mutations whose response body carries nothing the caller needs
    /// (`{ ok: true }`, or nothing at all) — a 2xx is the whole signal.
    func sendNoContent(path: String, method: String, jsonBody: Data?) async throws {
        let request = try await makeRequest(path: path, query: [], method: method, jsonBody: jsonBody, timeoutInterval: nil)
        let response: URLResponse
        do { (_, response) = try await session.data(for: request) }
        catch { throw APIError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(statusCode: http.statusCode)
        }
    }

    /// GET that maps a 404 to nil — for endpoints where "not there" is a
    /// documented answer, not a failure (the search availability probe; a
    /// brand-new user's missing preferences row).
    func sendAllowing404<T: Decodable>(path: String, query: [URLQueryItem], as type: T.Type) async throws -> T? {
        let request = try await makeRequest(path: path, query: query, method: "GET", jsonBody: nil, timeoutInterval: nil)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw APIError.network("No HTTP response.") }
        if http.statusCode == 404 { return nil }
        guard (200..<300).contains(http.statusCode) else { throw APIError.server(statusCode: http.statusCode) }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.network("Malformed response body.") }
    }
}
