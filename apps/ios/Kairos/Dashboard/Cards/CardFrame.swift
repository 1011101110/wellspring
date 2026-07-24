import SwiftUI

/// The card system's shared metrics (S4 #345 — previously repeated literals
/// scattered across the card files). Two corner radii on purpose: the card
/// surface itself, and the smaller radius for insets *within* a card (text
/// fields, highlighted rows), so the nesting reads as one system.
enum CardLayout {
    /// Corner radius of the card surface (`CardFrame`).
    static let cornerRadius: CGFloat = 16
    /// Corner radius for inset surfaces inside a card (text editors, the
    /// invite-address well, highlighted timeline rows).
    static let insetCornerRadius: CGFloat = 8
    /// The card's outer padding.
    static let padding: CGFloat = 16
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
                Text(title)
                    .font(.headline)
                Spacer(minLength: 8)
                headerAction
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CardLayout.padding)
        .background(
            RoundedRectangle(cornerRadius: CardLayout.cornerRadius, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}

// MARK: - Shared card sub-states

/// A short loading line for a card body.
struct CardLoading: View {
    var label: String = "Loading…"
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(label).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The empty-but-fine state — a quiet, reassuring line (never an error tone).
struct CardEmpty: View {
    let message: String
    var body: some View {
        Text(message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
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
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Try again", action: retry)
                .font(.subheadline.weight(.semibold))
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
            .font(.footnote)
            .foregroundStyle(.secondary)
    }
}
