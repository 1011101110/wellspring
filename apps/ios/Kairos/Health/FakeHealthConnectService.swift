import Foundation

/// In-memory `HealthConnectService` for previews, unit tests, and Demo
/// Mode. Never touches HealthKit.
public final class FakeHealthConnectService: HealthConnectService, @unchecked Sendable {
    /// When set, `requestAuthorization` reports every requested category as
    /// `.denied` instead of `.requested` — used to test the denied-permission
    /// path (docs/05_UX_FLOWS.md §3.1 "Denied permission" column) without a
    /// real device.
    public var simulatesDenial: Bool
    public var nextError: HealthConnectError?
    public private(set) var lastRequestedCategories: Set<HealthCategory> = []

    public init(simulatesDenial: Bool = false) {
        self.simulatesDenial = simulatesDenial
    }

    public func requestAuthorization(for categories: Set<HealthCategory>) async throws -> [HealthCategory: HealthAuthState] {
        if let nextError {
            self.nextError = nil
            throw nextError
        }
        lastRequestedCategories = categories
        var result: [HealthCategory: HealthAuthState] = [:]
        for category in categories {
            result[category] = simulatesDenial ? .denied : .requested
        }
        return result
    }
}
