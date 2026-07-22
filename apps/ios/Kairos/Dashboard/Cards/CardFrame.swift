import SwiftUI

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
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.headline)
                Spacer(minLength: 8)
                headerAction
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
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
