import XCTest

extension XCUIElement {
    /// Waits for the element to become **hittable**, then taps it. Prevents two
    /// distinct flakes seen under simulator load on the onboarding sign-in flow:
    ///   1. "No matches found" — a bare `.tap()` on an element that only appears
    ///      after an async navigation push (welcome→sign-in).
    ///   2. A silent no-op tap on an element that *exists* but isn't yet hittable
    ///      (mid launch/transition animation), so the expected next screen never
    ///      loads and a later step times out.
    /// Waiting for `isHittable` (not just existence) covers both.
    @discardableResult
    func tapWhenReady(timeout: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let hittable = XCTWaiter().wait(
            for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: self)],
            timeout: timeout
        ) == .completed
        XCTAssertTrue(hittable, "\(self) never became hittable within \(timeout)s", file: file, line: line)
        if hittable { tap() }
        return hittable
    }
}
