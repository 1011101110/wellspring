import SwiftUI

// Shared Wellspring Design System building blocks (T5 #352) — the pieces
// §05/§06 reuse across screens, kept here so the surfaces only carry layout.

/// The primary pill CTA (§05): capsule, deepened terracotta CTA gradient
/// (AA for the white 15/600 Hanken label), warm CTA shadow, ≥44pt target.
/// Pressed state dims gently — nothing springs or bounces (§08).
struct WSPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(WSTheme.ui(.semibold, size: 15))
            .foregroundStyle(.white)
            .padding(.horizontal, 24)
            .frame(minHeight: 50)
            .frame(maxWidth: .infinity)
            .background(WSTheme.ctaGradient, in: Capsule())
            .shadow(
                color: WSTheme.ctaShadowColor,
                radius: WSTheme.ctaShadowRadius,
                y: WSTheme.ctaShadowY
            )
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// The quiet secondary pill — clay text on a mist fill, for actions that
/// should never compete with the screen's one focal point (§08).
struct WSQuietPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(WSTheme.ui(.semibold, size: 15))
            .foregroundStyle(WSTheme.clayDeep)
            .padding(.horizontal, 20)
            .frame(minHeight: 44)
            .background(WSTheme.mist, in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

extension View {
    /// The card/glass surface (§08): white at .55 over the warm canvas, a
    /// hairline white border, radius 24, THE warm shadow — never gray.
    func wsCardSurface() -> some View {
        background(
            RoundedRectangle(cornerRadius: WSTheme.radiusCard, style: .continuous)
                .fill(Color.white.opacity(0.55))
                .overlay(
                    RoundedRectangle(cornerRadius: WSTheme.radiusCard, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.7), lineWidth: 1)
                )
                .shadow(
                    color: WSTheme.shadowColor,
                    radius: WSTheme.shadowRadius,
                    y: WSTheme.shadowY
                )
        )
    }

    /// The eyebrow role (§03): Hanken 600 12, uppercase, .22em tracking.
    /// `clayDeep` rather than raw terracotta — 12px text needs the
    /// AA-passing shade (designTokens.ts `accessible.clayDeep`).
    func wsEyebrow() -> some View {
        font(WSTheme.eyebrow())
            .textCase(.uppercase)
            .tracking(WSTheme.eyebrowTracking)
            .foregroundStyle(WSTheme.clayDeep)
    }
}

extension WSTheme {
    /// Styles the UIKit chrome SwiftUI can't reach directly: Spectral
    /// navigation titles on the warm canvas, a canvas tab bar. Called once
    /// from `KairosApp.init`.
    static func applyChromeAppearance() {
        let ink = UIColor(WSTheme.ink)
        let canvas = UIColor(WSTheme.canvas)

        let nav = UINavigationBarAppearance()
        nav.configureWithDefaultBackground()
        if let large = UIFont(name: "Spectral-Regular", size: 34) {
            nav.largeTitleTextAttributes = [.font: large, .foregroundColor: ink]
        }
        if let inline = UIFont(name: "Spectral-Regular", size: 20) {
            nav.titleTextAttributes = [.font: inline, .foregroundColor: ink]
        }
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = canvas
        tab.shadowColor = UIColor(WSTheme.dawn)
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }
}
