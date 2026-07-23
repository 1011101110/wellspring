import XCTest
@testable import Kairos

/// Issue #71 (docs/14_IMPROVEMENT_REVIEW.md §1.9): the API base URL must
/// never default to a real, externally-owned domain (`api.kairos.app`) that
/// this project doesn't control — it must point at the real staging host
/// behind a single configuration point, with any misconfigured/Release-shaped
/// fallback failing closed to a non-routable host rather than an unknown
/// third party.
@MainActor
final class AppEnvironmentTests: XCTestCase {

    func test_apiBaseURL_isNeverTheUnownedRoutableDomain() {
        XCTAssertNotEqual(
            AppEnvironment.apiBaseURL.host,
            "api.kairos.app",
            "The API base URL must never resolve to the real, externally-owned api.kairos.app domain"
        )
    }

    func test_apiBaseURL_isHTTPS() {
        XCTAssertEqual(AppEnvironment.apiBaseURL.scheme, "https")
    }

    func test_stagingAPIBaseURL_isTheDocumentedStagingHost() {
        // Pins the committed staging host (the #if DEBUG default for
        // AppEnvironment.apiBaseURL). This is a public, auth-gated Cloud Run
        // endpoint — not a secret — committed directly rather than injected;
        // system of record is kairos-devotional docs/10_CREDENTIALS_ACCESS.
        XCTAssertEqual(AppEnvironment.stagingAPIBaseURL.absoluteString, "https://kairos-api-staging-382100412938.us-central1.run.app")
    }

    #if DEBUG
    func test_apiBaseURL_debugBuildsResolveToARealHost_notThePlaceholder() {
        // In a DEBUG test-host build without an `API_BASE_URL` Info.plist
        // key (the common case for the unit-test bundle), `apiBaseURL` must
        // still resolve to a real, usable host (the staging fallback) — not
        // silently stay unconfigured.
        XCTAssertNotNil(AppEnvironment.apiBaseURL.host)
        XCTAssertFalse(AppEnvironment.apiBaseURL.absoluteString.isEmpty)
    }
    #endif

    // MARK: - Source-wide guard: no code path retains api.kairos.app

    func test_noSourceFileReferencesTheUnownedDomainAsALiteral() throws {
        // Defense-in-depth companion to the runtime assertions above: walks
        // every .swift file under the Kairos app target's source directory
        // and fails if the literal string `api.kairos.app` appears anywhere
        // outside of a comment explaining the historical fix (this file and
        // `AppEnvironment.swift` itself intentionally mention the string in
        // prose to document what was removed — both are excluded by name).
        let thisFile = URL(fileURLWithPath: #filePath)
        // apps/ios/KairosTests/AppEnvironmentTests.swift -> apps/ios/Kairos
        let iosRoot = thisFile
            .deletingLastPathComponent() // KairosTests
            .deletingLastPathComponent() // apps/ios
            .appendingPathComponent("Kairos")

        guard let enumerator = FileManager.default.enumerator(at: iosRoot, includingPropertiesForKeys: nil) else {
            throw XCTSkip("Could not enumerate \(iosRoot.path) in this environment; source-tree guard skipped.")
        }

        let excludedFiles: Set<String> = ["AppEnvironment.swift"]
        var offendingFiles: [String] = []

        for case let fileURL as URL in enumerator {
            guard fileURL.pathExtension == "swift", !excludedFiles.contains(fileURL.lastPathComponent) else { continue }
            guard let contents = try? String(contentsOf: fileURL, encoding: .utf8) else { continue }
            if contents.contains("api.kairos.app") {
                offendingFiles.append(fileURL.path)
            }
        }

        XCTAssertTrue(offendingFiles.isEmpty, "Found lingering references to the unowned api.kairos.app domain in: \(offendingFiles)")
    }
}
