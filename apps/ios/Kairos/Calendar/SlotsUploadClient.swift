import Foundation

/// Error cases for `SlotsUploadClient.uploadSlots` — the shared `APIError`
/// under the name this client's seam and tests were written against
/// (kairos-devotional #345).
public typealias SlotsUploadError = APIError

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
/// The HTTP mechanics live in the shared `APITransport` (#345); `baseURL` is
/// always injected (from `AppEnvironment.apiBaseURL`) — this client has no
/// URL literal of its own, exactly like `HTTPBandUploadClient`.
public final class SlotsUploadClient: SlotsUploading, @unchecked Sendable {
    private let transport: APITransport

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        getIdToken: @escaping @Sendable () async throws -> String
    ) {
        transport = APITransport(baseURL: baseURL, session: session, idTokenProvider: getIdToken)
    }

    public func uploadSlots(date: String, freeWindows: [FreeWindow]) async throws {
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

        try await transport.sendNoContent(path: "v1/slots", method: "POST", jsonBody: encoded)
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
