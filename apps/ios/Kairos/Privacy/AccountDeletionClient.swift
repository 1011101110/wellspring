import Foundation

/// Errors an `AccountDeletionClient` conformance can surface.
public enum AccountDeletionError: Error, Equatable, LocalizedError {
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

/// Abstraction over "how the app asks the backend to delete this account
/// and all its data" — docs/05_UX_FLOWS.md §3.1 "Data & Privacy" row:
/// "Delete account & all data (two-step confirm, immediate)"; backend
/// behavior specified by docs/04_DATA_PRIVACY_SECURITY.md §2's Retention
/// note: "Account deletion (in-app, one tap + confirm) hard-deletes all
/// rows and GCS objects within 24 h and revokes Google tokens."
///
/// `DELETE /v1/account` now exists on the backend (`apps/api/src/routes/userScoped.ts`)
/// and its response is contract-tested against
/// `AccountDeletionResponseSchema` (`packages/shared-contracts/src/api/account.ts`,
/// issue #83/#85) — `{ ok: true }`, no other fields. `HTTPAccountDeletionClient`
/// below deliberately still only checks the HTTP status code rather than
/// decoding that body: the schema carries no data this client needs, so
/// treating any 2xx as success is correct, not a shortcut.
public protocol AccountDeletionClient: AnyObject, Sendable {
    /// Requests immediate, irreversible deletion of the signed-in user's
    /// account and all associated data. Callers are responsible for the
    /// two-step confirmation UX (docs/05_UX_FLOWS.md) — by the time this is
    /// called, the user has already confirmed.
    func deleteAccount() async throws
}

/// Real implementation: `DELETE {baseURL}/v1/account` with a Firebase Auth
/// JWT bearer token, mirroring `HTTPBandUploadClient`'s auth pattern
/// exactly. Kept deliberately simple (no request body — the verified
/// bearer token *is* the account identifier, matching every other
/// authenticated route's "userId from the verified token, never from the
/// request body" rule, 04_DATA_PRIVACY_SECURITY §5.1).
public final class HTTPAccountDeletionClient: AccountDeletionClient, @unchecked Sendable {
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

    public func deleteAccount() async throws {
        let token: String
        do {
            token = try await idTokenProvider()
        } catch {
            throw AccountDeletionError.notAuthenticated
        }

        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("v1/account"))
        urlRequest.httpMethod = "DELETE"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (_, response): (Data, URLResponse)
        do {
            (_, response) = try await session.data(for: urlRequest)
        } catch {
            throw AccountDeletionError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw AccountDeletionError.network("No HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AccountDeletionError.server(statusCode: http.statusCode)
        }
    }
}

/// In-memory `AccountDeletionClient` for unit tests, previews, and Demo
/// Mode — records whether deletion was requested without any live network
/// dependency, matching `FakeBandUploadClient`'s pattern.
public final class FakeAccountDeletionClient: AccountDeletionClient, @unchecked Sendable {
    public var nextError: AccountDeletionError?
    public private(set) var deleteAccountCallCount = 0

    public init(nextError: AccountDeletionError? = nil) {
        self.nextError = nextError
    }

    public func deleteAccount() async throws {
        deleteAccountCallCount += 1
        if let nextError {
            throw nextError
        }
    }
}
