import SwiftUI

/// The card system's shared metrics (S4 #345 — previously repeated literals
/// scattered across the card files). Two corner radii on purpose: the card
/// surface itself, and the smaller radius for insets *within* a card (text
/// fields, highlighted rows), so the nesting reads as one system.
enum CardLayout {
    /// Corner radius of the card surface (`CardFrame`) — `--ws-radius-card`
    /// (T5 #352).
    static let cornerRadius: CGFloat = WSTheme.radiusCard
    /// Corner radius for inset surfaces inside a card (text editors, the
    /// invite-address well, highlighted timeline rows), kept concentric with
    /// the 24pt card surface.
    static let insetCornerRadius: CGFloat = WSTheme.radiusInset
    /// The card's outer padding.
    static let padding: CGFloat = 18
    /// The standard vertical rhythm between elements in a card body.
    static let contentSpacing: CGFloat = 12
}

/// The visual container every dashboard card sits in — a titled, rounded
/// surface, matching the web `CardFrame` (a labelled section with an h2 and an
/// optional header action). Keeps the Home screen visually one system.
struct CardFrame<Content: View, HeaderAction: View>: View {
    let title: String
    let headerAction: HeaderAction
    let content: Content

    init(
        _ title: String,
        @ViewBuilder headerAction: () -> HeaderAction = { EmptyView() },
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.headerAction = headerAction()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: CardLayout.contentSpacing) {
            HStack(alignment: .firstTextBaseline) {
                // The card's title wears the design's serif title role
                // (Spectral 400 — §03); all chrome inside stays Hanken.
                Text(title)
                    .font(WSTheme.title(size: 20))
                    .foregroundStyle(WSTheme.ink)
                Spacer(minLength: 8)
                headerAction
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CardLayout.padding)
        .wsCardSurface()
    }
}

// MARK: - Shared card sub-states

/// A short loading line for a card body.
struct CardLoading: View {
    var label: String = "Loading…"
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(label)
                .font(WSTheme.ui(size: 15))
                .foregroundStyle(WSTheme.mutedInk)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The empty-but-fine state — a quiet, reassuring line (never an error tone).
struct CardEmpty: View {
    let message: String
    var body: some View {
        Text(message)
            .font(WSTheme.ui(size: 15))
            .foregroundStyle(WSTheme.mutedInk)
            .lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A recoverable failure with a Try again affordance.
struct CardError: View {
    let message: String
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(WSTheme.ui(size: 15))
                .foregroundStyle(WSTheme.mutedInk)
            Button("Try again", action: retry)
                .font(WSTheme.ui(.semibold, size: 15))
                .foregroundStyle(WSTheme.clayDeep)
                .frame(minHeight: 44)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A small, secondary "hint" line used across cards.
struct CardHint: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(WSTheme.ui(size: 13))
            .foregroundStyle(WSTheme.mutedInk)
    }
}
