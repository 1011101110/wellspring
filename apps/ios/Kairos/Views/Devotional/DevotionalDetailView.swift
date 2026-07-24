import SwiftUI

/// Normalized content the reader renders, so the same view serves both the
/// demo fixture (`DemoFixtureSnapshot`) and a live devotional
/// (`DevotionalDetail`) fetched from `GET /v1/devotionals/:id` (issue #3).
struct DevotionalReaderContent: Equatable {
    /// Identified by `reference` — a devotional never quotes the same
    /// passage twice, and a stable id keeps SwiftUI's identity tied to the
    /// verse rather than its position (S4 #345; was `ForEach(id: \.offset)`).
    struct ReaderVerse: Equatable, Identifiable {
        let reference: String
        let text: String
        let attribution: String
        var id: String { reference }
    }
    let theme: String
    let verses: [ReaderVerse]
    let body: String
    let prayer: String
    let actionStep: String?
}

/// docs/05_UX_FLOWS.md §3.1 "Devotional detail": full transcript, verse text
/// + attribution, prayer, action step if present, play/complete controls.
/// Reachable from the Home dashboard's Today card and History rows (#3), and
/// fed directly from a fixture in demo mode (#41).
struct DevotionalDetailView: View {
    let content: DevotionalReaderContent
    /// Runs the real "mark complete" mutation (POST /v1/devotionals/:id/
    /// complete). Defaults to a no-op so the fixture/preview `init(content:)`
    /// path stays offline (#3).
    private let onComplete: () async throws -> Void
    @State private var isPlaying = false
    @State private var isCompleted: Bool
    @State private var isCompleting = false
    @State private var completeError: String?

    init(content: DevotionalReaderContent) {
        self.content = content
        self.onComplete = {}
        _isCompleted = State(initialValue: false)
    }

    init(detail: DevotionalDetail, onComplete: @escaping () async throws -> Void = {}) {
        self.content = DevotionalReaderContent(
            theme: detail.theme,
            verses: detail.verses.map {
                .init(reference: $0.reference, text: $0.fetchedText, attribution: $0.attribution)
            },
            body: detail.devotionalBody,
            prayer: detail.prayer,
            actionStep: detail.actionStep
        )
        self.onComplete = onComplete
        // A re-opened, already-completed devotional shows "Completed" straight
        // away rather than inviting a second Amen.
        _isCompleted = State(initialValue: detail.completedAt != nil)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // The reader per §06: Spectral scripture hero, Hanken chrome.
                Text(content.theme.capitalized)
                    .font(WSTheme.title(size: 30))
                    .foregroundStyle(WSTheme.ink)
                    .accessibilityIdentifier("devotionalDetail.theme")

                ForEach(content.verses) { verse in
                    // §05 verse block: eyebrow reference, Spectral 300 quote,
                    // Hanken reference line, on the soft dawn gradient.
                    VStack(alignment: .leading, spacing: 10) {
                        Text(verse.reference)
                            .wsEyebrow()
                            .accessibilityIdentifier("devotionalDetail.verseReference")

                        Text(verse.text)
                            .font(WSTheme.scripture(size: 26))
                            .foregroundStyle(WSTheme.ink)
                            .lineSpacing(10)
                            .accessibilityIdentifier("devotionalDetail.verseText")

                        Text(verse.attribution)
                            .font(WSTheme.reference())
                            .foregroundStyle(WSTheme.mutedInk)
                            .accessibilityIdentifier("devotionalDetail.attribution")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                    .background(
                        RoundedRectangle(cornerRadius: WSTheme.radiusCard, style: .continuous)
                            .fill(WSTheme.verseGradient)
                            .shadow(
                                color: WSTheme.shadowColor,
                                radius: WSTheme.shadowRadius,
                                y: WSTheme.shadowY
                            )
                    )
                }

                playbackControl

                sectionHeader("Transcript")
                Text(content.body)
                    .font(WSTheme.ui(size: 16))
                    .foregroundStyle(WSTheme.ink)
                    .lineSpacing(7)
                    .accessibilityIdentifier("devotionalDetail.transcript")

                sectionHeader("Prayer")
                Text(content.prayer)
                    .font(WSTheme.prayer(size: 22))
                    .foregroundStyle(WSTheme.ink)
                    .lineSpacing(8)
                    .accessibilityIdentifier("devotionalDetail.prayer")

                if let actionStep = content.actionStep {
                    sectionHeader("Action step")
                    Text(actionStep)
                        .font(WSTheme.ui(size: 16))
                        .foregroundStyle(WSTheme.ink)
                        .lineSpacing(7)
                        .accessibilityIdentifier("devotionalDetail.actionStep")
                }

                completeButton
            }
            .padding()
        }
        .background(WSTheme.canvas)
        .navigationTitle("Devotional")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Section chrome in the eyebrow role over a soft dawn rule — quieter
    /// than a system headline + divider, and never serif (§03).
    private func sectionHeader(_ label: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Rectangle()
                .fill(WSTheme.dawn)
                .frame(height: 1)
            Text(label)
                .wsEyebrow()
        }
    }

    /// docs/05_UX_FLOWS.md §4 "Main": large play/pause control. No real audio
    /// asset ships at this stage (no live TTS pipeline yet), so tapping only
    /// flips the local `isPlaying` state — the "audio plays" beat's UI without
    /// pretending a real MP3 is being decoded.
    private var playbackControl: some View {
        Button {
            isPlaying.toggle()
        } label: {
            Label(isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.fill" : "play.fill")
        }
        .buttonStyle(WSPillButtonStyle())
        .accessibilityIdentifier("devotionalDetail.playButton")
    }

    /// docs/05_UX_FLOWS.md §4 "Amen — mark complete"; posts to the server
    /// (which writes the YouVersion highlight) and becomes a quiet "Completed
    /// check" once done, zero-guilt (P2, #3). A failed post leaves the button
    /// tappable again and shows a quiet retryable line — it never lies that
    /// the session was saved.
    private var completeButton: some View {
        VStack(spacing: 8) {
            Button {
                Task { await runComplete() }
            } label: {
                Text(completeLabel)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(WSQuietPillButtonStyle())
            .disabled(isCompleted || isCompleting)
            .accessibilityIdentifier("devotionalDetail.completeButton")

            if let completeError {
                Text(completeError)
                    .font(WSTheme.ui(size: 13))
                    .foregroundStyle(WSTheme.mutedInk)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("devotionalDetail.completeError")
            }
        }
    }

    private var completeLabel: String {
        if isCompleted { return "Completed \u{2713}" }
        if isCompleting { return "Marking\u{2026}" }
        return "Amen \u{2014} mark complete"
    }

    private func runComplete() async {
        guard !isCompleted, !isCompleting else { return }
        isCompleting = true
        completeError = nil
        defer { isCompleting = false }
        do {
            try await onComplete()
            isCompleted = true
        } catch {
            // Don't flip isCompleted — the tap can be retried.
            completeError = (error as? DashboardError)?.errorDescription ?? "Couldn't mark complete. Tap to try again."
        }
    }
}

// The preview renders the shared demo fixture (#41) through the same
// `DevotionalReaderContent` normalization the live path uses. The mapping
// lives here — the view itself no longer carries a fixture-specific init
// (its one runtime entry point is `init(detail:)`; S4 #345).
#Preview {
    let output = (try! DemoFixtureLoader.load(bundle: .main)).devotionalOutput
    return NavigationStack {
        DevotionalDetailView(content: DevotionalReaderContent(
            theme: output.theme,
            verses: output.verses.map {
                .init(reference: $0.reference, text: $0.fetchedText, attribution: $0.attribution)
            },
            body: output.devotionalBody,
            prayer: output.prayer,
            actionStep: output.actionStep
        ))
    }
}
