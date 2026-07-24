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
    @State private var isPlaying = false
    @State private var isCompleted = false

    init(content: DevotionalReaderContent) {
        self.content = content
    }

    init(detail: DevotionalDetail) {
        self.content = DevotionalReaderContent(
            theme: detail.theme,
            verses: detail.verses.map {
                .init(reference: $0.reference, text: $0.fetchedText, attribution: $0.attribution)
            },
            body: detail.devotionalBody,
            prayer: detail.prayer,
            actionStep: detail.actionStep
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(content.theme.capitalized)
                    .font(.title2)
                    .bold()
                    .accessibilityIdentifier("devotionalDetail.theme")

                ForEach(content.verses) { verse in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verse.reference)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("devotionalDetail.verseReference")

                        Text(verse.text)
                            .font(.body)
                            .italic()
                            .accessibilityIdentifier("devotionalDetail.verseText")

                        Text(verse.attribution)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("devotionalDetail.attribution")
                    }
                    .padding()
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                }

                playbackControl

                Divider()

                Text("Transcript")
                    .font(.headline)
                Text(content.body)
                    .font(.body)
                    .accessibilityIdentifier("devotionalDetail.transcript")

                Divider()

                Text("Prayer")
                    .font(.headline)
                Text(content.prayer)
                    .font(.body)
                    .italic()
                    .accessibilityIdentifier("devotionalDetail.prayer")

                if let actionStep = content.actionStep {
                    Divider()
                    Text("Action step")
                        .font(.headline)
                    Text(actionStep)
                        .font(.body)
                        .accessibilityIdentifier("devotionalDetail.actionStep")
                }

                completeButton
            }
            .padding()
        }
        .navigationTitle("Devotional")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// docs/05_UX_FLOWS.md §4 "Main": large play/pause control. No real audio
    /// asset ships at this stage (no live TTS pipeline yet), so tapping only
    /// flips the local `isPlaying` state — the "audio plays" beat's UI without
    /// pretending a real MP3 is being decoded.
    private var playbackControl: some View {
        Button {
            isPlaying.toggle()
        } label: {
            Label(isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.circle.fill" : "play.circle.fill")
                .font(.title2)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("devotionalDetail.playButton")
    }

    /// docs/05_UX_FLOWS.md §4 "Amen — mark complete"; becomes a quiet
    /// "Completed check" once tapped, zero-guilt (P2).
    private var completeButton: some View {
        Button {
            isCompleted = true
        } label: {
            Text(isCompleted ? "Completed \u{2713}" : "Amen \u{2014} mark complete")
        }
        .buttonStyle(.bordered)
        .disabled(isCompleted)
        .accessibilityIdentifier("devotionalDetail.completeButton")
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
