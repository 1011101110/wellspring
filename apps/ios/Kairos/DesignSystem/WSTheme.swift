import SwiftUI

/// The Wellspring Design System on iOS (T5 #352) — colors, radii, shadows,
/// motion, and type roles from the owner's approved design.
///
/// Values mirror `packages/shared-contracts/src/designTokens.ts` (the single
/// source of truth, T1 #348) — if this file and that literal disagree, the
/// shared contract wins. `WSThemeTests` pins the hex values against it.
///
/// Naming: the `--ws-*` handoff names, camel-cased. The light (morning) set
/// styles the app today; the dark (evening) set is carried for the future
/// evening variant and is not yet applied anywhere.
enum WSTheme {
    // MARK: - Color (light / morning set)

    /// `--ws-canvas` #FCF7F2 — the warm ground every screen sits on.
    static let canvas = Color(wsHex: 0xFCF7F2)
    /// `--ws-mist` #F7EADF.
    static let mist = Color(wsHex: 0xF7EADF)
    /// `--ws-dawn` #EFD9C8.
    static let dawn = Color(wsHex: 0xEFD9C8)
    /// `--ws-terracotta` #B4795A — the ONLY accent, used sparingly (§08).
    static let terracotta = Color(wsHex: 0xB4795A)
    /// `--ws-clay` #8A5F43.
    static let clay = Color(wsHex: 0x8A5F43)
    /// `--ws-ink` #3B322C — primary text.
    static let ink = Color(wsHex: 0x3B322C)
    /// `--ws-muted` #A2937F — NON-text uses only (2.81:1 on canvas).
    static let muted = Color(wsHex: 0xA2937F)

    // MARK: - Color (dark / evening set — future evening variant)

    /// `--ws-night` #171D2C.
    static let night = Color(wsHex: 0x171D2C)
    /// `--ws-dusk` #242C40.
    static let dusk = Color(wsHex: 0x242C40)
    /// `--ws-candle` #E7D7A6.
    static let candle = Color(wsHex: 0xE7D7A6)
    /// `--ws-paper` #EEEBE2.
    static let paper = Color(wsHex: 0xEEEBE2)

    // MARK: - Color (accessible derivations, #347 rule 2)

    /// `--ws-muted-ink` #6F614E — `muted`'s role for TEXT (5.64:1 on canvas).
    static let mutedInk = Color(wsHex: 0x6F614E)
    /// `--ws-muted-ink-dark` #B4AB9A — muted text on the dark set.
    static let mutedInkDark = Color(wsHex: 0xB4AB9A)
    /// `--ws-clay-deep` #7C5539 — focus rings / small accents on warm grounds.
    static let clayDeep = Color(wsHex: 0x7C5539)
    /// `--ws-terracotta-light` #D9A07F — the accent's role on the dark set.
    static let terracottaLight = Color(wsHex: 0xD9A07F)

    // MARK: - Gradients

    /// `--ws-grad-terracotta` 145deg #C98A63 → #B4795A — DECORATIVE fills
    /// only (brand mark, large glyphs): white small text fails AA on it.
    static let terracottaGradient = LinearGradient(
        colors: [Color(wsHex: 0xC98A63), Color(wsHex: 0xB4795A)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    /// `--ws-grad-cta` 145deg #96674B → #8A5F43 — the text-bearing pill CTA
    /// fill, deepened so white 15/600 label text passes AA at every point.
    static let ctaGradient = LinearGradient(
        colors: [Color(wsHex: 0x96674B), Color(wsHex: 0x8A5F43)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    /// `--ws-grad-verse` 180deg #FBF3EC → #F5E6DA — the verse block ground
    /// (§05 signature components).
    static let verseGradient = LinearGradient(
        colors: [Color(wsHex: 0xFBF3EC), Color(wsHex: 0xF5E6DA)],
        startPoint: .top, endPoint: .bottom
    )

    // MARK: - Radii

    /// `--ws-radius-card` 24px.
    static let radiusCard: CGFloat = 24
    /// Inset surfaces nested inside a card, kept concentric with the 24pt
    /// card surface (24 − 12pt padding).
    static let radiusInset: CGFloat = 12
    // The pill radius (`--ws-radius-pill` 999px) is `Capsule()` in SwiftUI.

    // MARK: - Shadows (warm-tinted, never gray — §08)

    /// `--ws-shadow` 0 12px 30px rgba(146,104,73,.12). CSS blur ≈ 2× SwiftUI
    /// radius, so 30px blur → radius 15.
    static let shadowColor = Color(wsHex: 0x926849).opacity(0.12)
    static let shadowRadius: CGFloat = 15
    static let shadowY: CGFloat = 12

    /// `--ws-shadow-cta` 0 10px 22px rgba(180,121,90,.3) — under the primary
    /// pill CTA (§05).
    static let ctaShadowColor = Color(wsHex: 0xB4795A).opacity(0.3)
    static let ctaShadowRadius: CGFloat = 11
    static let ctaShadowY: CGFloat = 10

    /// `--ws-shadow-hero` 0 22px 50px rgba(146,104,73,.16).
    static let heroShadowColor = Color(wsHex: 0x926849).opacity(0.16)
    static let heroShadowRadius: CGFloat = 25
    static let heroShadowY: CGFloat = 22

    // MARK: - Motion (§08: cross-fades, nothing springs or bounces)

    /// `--ws-dur` 900ms.
    static let duration: TimeInterval = 0.9
    /// `--ws-ease` cubic-bezier(.4,0,.2,1) at the standard duration.
    static let ease = Animation.timingCurve(0.4, 0, 0.2, 1, duration: duration)

    // MARK: - Type roles (§03)

    /// Scripture — Spectral 300, 26–36px band, NEVER sans (§03).
    static func scripture(size: CGFloat = 26) -> Font {
        Font.custom("Spectral-Light", size: size, relativeTo: .title2)
    }

    /// Prayer — Spectral 300 italic, 22–26px band.
    static func prayer(size: CGFloat = 22) -> Font {
        Font.custom("Spectral-LightItalic", size: size, relativeTo: .title3)
    }

    /// Title — Spectral 400 (screen and card titles).
    static func title(size: CGFloat = 26) -> Font {
        Font.custom("Spectral-Regular", size: size, relativeTo: .title2)
    }

    /// UI chrome — Hanken Grotesk 400/500/600. NEVER serif for chrome (§03).
    /// Weights map to the bundled statics; anything bolder clamps to 600 —
    /// the design never uses a heavier UI weight.
    static func ui(_ weight: Font.Weight = .regular, size: CGFloat = 15) -> Font {
        let name: String
        switch weight {
        case .medium: name = "HankenGrotesk-Medium"
        case .semibold, .bold, .heavy, .black: name = "HankenGrotesk-SemiBold"
        default: name = "HankenGrotesk-Regular"
        }
        return Font.custom(name, size: size, relativeTo: .body)
    }

    /// Eyebrow — Hanken 600 · 12px · uppercase · letter-spacing .22em (§03).
    /// Tracking is points here: 12px × 0.22em ≈ 2.6pt.
    static let eyebrowTracking: CGFloat = 2.6
    static func eyebrow() -> Font {
        Font.custom("HankenGrotesk-SemiBold", size: 12, relativeTo: .caption)
    }

    /// Reference line — Hanken 500 · 13px (§03).
    static func reference() -> Font {
        Font.custom("HankenGrotesk-Medium", size: 13, relativeTo: .footnote)
    }
}

private extension Color {
    /// Builds an sRGB color from a 24-bit hex literal (e.g. `0xFCF7F2`),
    /// keeping the token's hex readable at the call site.
    init(wsHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
