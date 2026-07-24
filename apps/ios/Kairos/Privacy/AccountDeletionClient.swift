import Foundation

/// Errors an `AccountDeletionClient` conformance can surface — the shared
/// `APIError` under the name this client's seam and tests were written
/// against (kairos-devotional #345).
public typealias AccountDeletionError = APIError

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
/// JWT bearer token, on the shared `APITransport` (#345). Kept deliberately
/// simple (no request body — the verified bearer token *is* the account
/// identifier, matching every other authenticated route's "userId from the
/// verified token, never from the request body" rule,
/// 04_DATA_PRIVACY_SECURITY §5.1).
public final class HTTPAccountDeletionClient: AccountDeletionClient, @unchecked Sendable {
    private let transport: APITransport

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        idTokenProvider: @escaping @Sendable () async throws -> String
    ) {
        transport = APITransport(baseURL: baseURL, session: session, idTokenProvider: idTokenProvider)
    }

    public func deleteAccount() async throws {
        try await transport.sendNoContent(path: "v1/account", method: "DELETE", jsonBody: nil)
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
