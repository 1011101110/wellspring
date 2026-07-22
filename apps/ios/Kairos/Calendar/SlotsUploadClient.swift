import Foundation

/// Error cases for `SlotsUploadClient.uploadSlots`.
public enum SlotsUploadError: Error, Equatable, LocalizedError {
    case notAuthenticated
    case network(String)
    case server(statusCode: Int)

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated:  return "Not signed in."
        case .network(let msg):  return "Network problem: \(msg)"
        case .server(let code):  return "Server error (\(code))."
        }
    }
}

/// Protocol seam for `POST /v1/slots`, so callers (including
/// `BackgroundBandRefreshScheduler`) and tests can depend on the abstraction
/// rather than the concrete HTTP implementation.
public protocol SlotsUploading: AnyObject, Sendable {
    /// Uploads a set of candidate free windows for the given ISO date
    /// (YYYY-MM-DD).  Throws `SlotsUploadError` on any failure.
    func uploadSlots(date: String, freeWindows: [FreeWindow]) async throws
}

/// HTTP client for `POST /v1/slots`
/// (packages/shared-contracts/src/api/slots.ts `SlotsUploadRequestSchema`).
///
/// Request body shape:
/// ```json
/// { "date": "2026-07-04", "slots": [{ "startIso": "...", "endIso": "..." }] }
/// ```
/// Header: `Authorization: Bearer <id_token>`.
///
/// `baseURL` is always injected (from `AppEnvironment.apiBaseURL`) — this
/// client has no URL literal of its own, exactly like `HTTPBandUploadClient`.
public final class SlotsUploadClient: SlotsUploading, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    /// Supplies a fresh Firebase Auth ID token for each request.
    private let getIdToken: @Sendable () async throws -> String

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        getIdToken: @escaping @Sendable () async throws -> String
    ) {
        self.baseURL = baseURL
        self.session = session
        self.getIdToken = getIdToken
    }

    public func uploadSlots(date: String, freeWindows: [FreeWindow]) async throws {
        let token: String
        do {
            token = try await getIdToken()
        } catch {
            throw SlotsUploadError.notAuthenticated
        }

        // Build the wire payload matching SlotsUploadRequestSchema exactly.
        // Only "date" and "slots" (each containing only "startIso"/"endIso")
        // are ever sent — no titles, attendees, or any calendar content.
        let body = SlotsUploadBody(date: date, slots: freeWindows)
        let encoded: Data
        do {
            encoded = try JSONEncoder().encode(body)
        } catch {
            throw SlotsUploadError.network("Encoding failed: \(error.localizedDescription)")
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/slots"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = encoded

        let (_, response): (Data, URLResponse)
        do {
            (_, response) = try await session.data(for: request)
        } catch {
            throw SlotsUploadError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw SlotsUploadError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw SlotsUploadError.server(statusCode: http.statusCode)
        }
    }

    // MARK: - Wire body

    /// Internal Encodable that matches the `SlotsUploadRequestSchema` wire
    /// shape exactly: `{ "date": "...", "slots": [...] }`.
    private struct SlotsUploadBody: Encodable {
        let date: String
        let slots: [FreeWindow]
    }
}

/// In-memory `SlotsUploading` for unit tests, previews, and Demo Mode.
public final class FakeSlotsUploadClient: SlotsUploading, @unchecked Sendable {
    public var nextError: SlotsUploadError?
    public private(set) var uploadedCalls: [(date: String, windows: [FreeWindow])] = []

    public init(nextError: SlotsUploadError? = nil) {
        self.nextError = nextError
    }

    public func uploadSlots(date: String, freeWindows: [FreeWindow]) async throws {
        if let nextError {
            throw nextError
        }
        uploadedCalls.append((date: date, windows: freeWindows))
    }
}
