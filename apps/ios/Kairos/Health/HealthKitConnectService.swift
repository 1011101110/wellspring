import Foundation
import HealthKit

/// Real implementation of `HealthConnectService` backed by `HKHealthStore`.
/// Requests only the read types needed for the toggled-on categories
/// (docs/04_DATA_PRIVACY_SECURITY.md §3: "independent toggle" per
/// category) and nothing else — Kairos never requests write access, and
/// never requests a category the user did not explicitly turn on.
///
/// Sample fetching + band derivation (via the existing `BandDeriver`
/// package) is a separate concern from authorization and is out of scope
/// here; this type's only job is the priming-gated permission request
/// itself (docs/05_UX_FLOWS.md §2 screen 4).
public final class HealthKitConnectService: HealthConnectService, @unchecked Sendable {
    private let store = HKHealthStore()

    public init() {}

    private static func readTypes(for category: HealthCategory) -> Set<HKObjectType> {
        switch category {
        case .recovery:
            var types: Set<HKObjectType> = []
            if let hrv = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN) {
                types.insert(hrv)
            }
            if let restingHR = HKObjectType.quantityType(forIdentifier: .restingHeartRate) {
                types.insert(restingHR)
            }
            return types
        case .sleepQuality:
            if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
                return [sleep]
            }
            return []
        case .activity:
            var types: Set<HKObjectType> = []
            if let steps = HKObjectType.quantityType(forIdentifier: .stepCount) {
                types.insert(steps)
            }
            if let energy = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) {
                types.insert(energy)
            }
            types.insert(HKObjectType.workoutType())
            return types
        }
    }

    public func requestAuthorization(for categories: Set<HealthCategory>) async throws -> [HealthCategory: HealthAuthState] {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw HealthConnectError.unavailable
        }

        var result: [HealthCategory: HealthAuthState] = [:]
        for category in categories {
            let types = Self.readTypes(for: category)
            guard !types.isEmpty else {
                result[category] = .denied
                continue
            }
            do {
                try await store.requestAuthorization(toShare: [], read: types)
                // HealthKit read-authorization status is deliberately opaque
                // to the requesting app for privacy-sensitive types (Apple
                // never reveals "denied" vs "granted" for read access) —
                // `.sharingAuthorized`/`.sharingDenied` only reflect
                // whether the *prompt itself* was shown/answered, which is
                // the best signal available. We treat a completed request
                // as "requested" (category may still yield no data if the
                // user denied at the OS sheet); an explicit throw is the
                // only way to observe a hard failure.
                result[category] = .requested
            } catch {
                result[category] = .denied
            }
        }
        return result
    }
}
