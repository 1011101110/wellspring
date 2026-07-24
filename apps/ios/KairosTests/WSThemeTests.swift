import XCTest
import SwiftUI
@testable import Kairos

/// Drift guard for the Wellspring Design System tokens (T5 #352).
///
/// The expected hex values are hardcoded here on purpose — they are the §08
/// handoff values as pinned in `packages/shared-contracts/src/designTokens.ts`
/// (the cross-platform source of truth). If a WSTheme color is ever "adjusted"
/// away from the shared contract, this fails loudly instead of the palette
/// silently forking from web/api.
final class WSThemeTests: XCTestCase {
    /// Resolves a SwiftUI Color to its 24-bit sRGB hex.
    private func hex(_ color: Color, file: StaticString = #filePath, line: UInt = #line) -> UInt32 {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else {
            XCTFail("Color is not convertible to RGB", file: file, line: line)
            return 0
        }
        func channel(_ v: CGFloat) -> UInt32 { UInt32((v * 255).rounded()) }
        return channel(r) << 16 | channel(g) << 8 | channel(b)
    }

    func testLightSetMatchesSharedContract() {
        // designTokens.ts `color.light`.
        XCTAssertEqual(hex(WSTheme.canvas), 0xFCF7F2)
        XCTAssertEqual(hex(WSTheme.mist), 0xF7EADF)
        XCTAssertEqual(hex(WSTheme.dawn), 0xEFD9C8)
        XCTAssertEqual(hex(WSTheme.terracotta), 0xB4795A)
        XCTAssertEqual(hex(WSTheme.clay), 0x8A5F43)
        XCTAssertEqual(hex(WSTheme.ink), 0x3B322C)
        XCTAssertEqual(hex(WSTheme.muted), 0xA2937F)
    }

    func testDarkSetMatchesSharedContract() {
        // designTokens.ts `color.dark` — carried for the evening variant.
        XCTAssertEqual(hex(WSTheme.night), 0x171D2C)
        XCTAssertEqual(hex(WSTheme.dusk), 0x242C40)
        XCTAssertEqual(hex(WSTheme.candle), 0xE7D7A6)
        XCTAssertEqual(hex(WSTheme.paper), 0xEEEBE2)
    }

    func testAccessibleDerivationsMatchSharedContract() {
        // designTokens.ts `color.accessible` (#347 rule 2 shades).
        XCTAssertEqual(hex(WSTheme.mutedInk), 0x6F614E)
        XCTAssertEqual(hex(WSTheme.mutedInkDark), 0xB4AB9A)
        XCTAssertEqual(hex(WSTheme.clayDeep), 0x7C5539)
        XCTAssertEqual(hex(WSTheme.terracottaLight), 0xD9A07F)
    }

    func testRadiiAndMotionMatchSharedContract() {
        // designTokens.ts `radius.card` (24px) and `motion` (900ms, .4/0/.2/1).
        XCTAssertEqual(WSTheme.radiusCard, 24)
        XCTAssertEqual(WSTheme.duration, 0.9, accuracy: 0.0001)
    }

    func testShadowParametersMatchSharedContract() {
        // designTokens.ts `shadow.card` = 0 12px 30px rgba(146,104,73,.12);
        // CSS blur ≈ 2× SwiftUI radius, so 30px → 15.
        XCTAssertEqual(WSTheme.shadowY, 12)
        XCTAssertEqual(WSTheme.shadowRadius, 15)
        // `shadow.cta` = 0 10px 22px rgba(180,121,90,.3).
        XCTAssertEqual(WSTheme.ctaShadowY, 10)
        XCTAssertEqual(WSTheme.ctaShadowRadius, 11)
    }

    /// The six bundled statics must resolve by PostScript name — a font that
    /// silently falls back to San Francisco would violate §03 ("scripture is
    /// NEVER sans") without any compile-time signal.
    func testBundledFontsResolve() {
        for name in [
            "Spectral-Light",
            "Spectral-LightItalic",
            "Spectral-Regular",
            "HankenGrotesk-Regular",
            "HankenGrotesk-Medium",
            "HankenGrotesk-SemiBold",
        ] {
            XCTAssertNotNil(UIFont(name: name, size: 16), "font \(name) did not register — check UIAppFonts / bundle resources")
        }
    }
}
