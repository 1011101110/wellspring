import XCTest
@testable import BandDeriver

/// Defense-in-depth tests asserting that `HealthBands` — the ONLY type
/// this package hands back to the app for onward transmission — cannot
/// structurally carry a raw HealthKit value. docs/00_FOUNDATION.md §8:
/// "raw HealthKit samples or timelines" must never be sent to Gloo or
/// YouVersion. If a future change accidentally adds a numeric/Date/String
/// field to `HealthBands`, these tests fail.
final class HealthBandsShapeTests: XCTestCase {

    func test_healthBands_hasExactlyThreeStoredProperties() {
        let bands = HealthBands(recovery: .low, sleepQuality: .poor, activity: .sedentary)
        let mirror = Mirror(reflecting: bands)
        XCTAssertEqual(
            mirror.children.count,
            3,
            "HealthBands must expose exactly the three band fields — no extra (raw-value) storage."
        )
    }

    func test_healthBands_everyStoredPropertyIsOneOfTheClosedBandEnums() {
        let bands = HealthBands(recovery: .high, sleepQuality: .good, activity: .active)
        let mirror = Mirror(reflecting: bands)

        let allowedTypeNames: Set<String> = [
            String(describing: RecoveryBand.self),
            String(describing: SleepQualityBand.self),
            String(describing: ActivityBand.self)
        ]

        for child in mirror.children {
            let typeName = String(describing: type(of: child.value))
            XCTAssertTrue(
                allowedTypeNames.contains(typeName),
                "HealthBands field '\(child.label ?? "?")' has type '\(typeName)', " +
                "which is not one of the closed band enums (\(allowedTypeNames)). " +
                "This would let a raw numeric/Date/String value leak through the output type."
            )
        }
    }

    func test_healthBands_reflectionRejectsPrimitiveTypes() {
        // Explicitly enumerate the primitive/raw types that must never
        // appear as a HealthBands field type, and confirm none of the
        // actual field types match them.
        let bands = HealthBands(recovery: .moderate, sleepQuality: .fair, activity: .moderate)
        let mirror = Mirror(reflecting: bands)

        let forbiddenTypeNames: Set<String> = [
            "Double", "Float", "Int", "Int64", "String", "Date",
            "Optional<Double>", "Optional<Date>", "Optional<String>",
            "Array<HRVSample>", "Array<RestingHRSample>", "[HRVSample]",
            "SleepStageDurations", "ActivitySummary", "PersonalBaseline"
        ]

        for child in mirror.children {
            let typeName = String(describing: type(of: child.value))
            XCTAssertFalse(
                forbiddenTypeNames.contains(typeName),
                "HealthBands field '\(child.label ?? "?")' has forbidden raw type '\(typeName)'."
            )
        }
    }

    func test_healthBands_jsonEncodingContainsOnlyEnumRawValueStrings() throws {
        // Round-trip through JSON (the shape that would actually cross the
        // network boundary to the backend) and assert every value present
        // is one of the pinned enum raw-value strings from §5 — nothing
        // numeric, no timestamps.
        let bands = HealthBands(recovery: .low, sleepQuality: .good, activity: .active)
        let data = try JSONEncoder().encode(bands)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let jsonObject = try XCTUnwrap(json)

        XCTAssertEqual(jsonObject.count, 3)

        let allowedValues: Set<String> = Set(
            RecoveryBand.allCases.map(\.rawValue)
                + SleepQualityBand.allCases.map(\.rawValue)
                + ActivityBand.allCases.map(\.rawValue)
        )

        for (key, value) in jsonObject {
            guard let stringValue = value as? String else {
                XCTFail("HealthBands JSON field '\(key)' is not a string (raw value leak?): \(value)")
                continue
            }
            XCTAssertTrue(
                allowedValues.contains(stringValue),
                "HealthBands JSON field '\(key)' has value '\(stringValue)' which is not a pinned band enum raw value."
            )
        }
    }

    func test_bandEnumRawValues_matchFoundationDocSpellings() {
        // Pin the exact string spellings from docs/00_FOUNDATION.md §5.
        XCTAssertEqual(Set(RecoveryBand.allCases.map(\.rawValue)), ["low", "moderate", "high"])
        XCTAssertEqual(Set(SleepQualityBand.allCases.map(\.rawValue)), ["poor", "fair", "good"])
        XCTAssertEqual(Set(ActivityBand.allCases.map(\.rawValue)), ["sedentary", "moderate", "active"])
    }
}
