import SwiftUI

/// docs/05_UX_FLOWS.md §3.1 "Devotional detail": full transcript, verse
/// text + attribution, prayer, action step if present, Replay button.
///
/// In demo mode (issue #41 / EPIC E8) this view is fed directly from a
/// `DemoFixtureSnapshot` decoded from `fixtures/snapshots/low_poor_heavy.json`
/// — no network, no TTS, no session token — so the judge-facing arc (open
/// app -> see bands -> see calendar event -> tap join -> audio plays,
/// docs/05_UX_FLOWS.md §8) can render real fixture verse/attribution/body
/// content with zero live dependencies. No live TTS pipeline exists yet
/// (per this task's scope), so "audio plays" is represented honestly here
/// by a play/pause control that toggles local UI state over the full
/// transcript, rather than pretending to decode a real MP3 — functionally
/// the same transcript-first experience as the `AUDIO_UNAVAILABLE` state's
/// UI (§3.1), an acceptable substitute for a fixture stage that must stay
/// judge-safe and fully offline.
struct DevotionalDetailView: View {
    let snapshot: DemoFixtureSnapshot
    @State private var isPlaying = false
    @State private var isCompleted = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(snapshot.devotionalOutput.theme.capitalized)
                    .font(.title2)
                    .bold()
                    .accessibilityIdentifier("devotionalDetail.theme")

                ForEach(Array(snapshot.devotionalOutput.verses.enumerated()), id: \.offset) { _, verse in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verse.reference)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("devotionalDetail.verseReference")

                        Text(verse.fetchedText)
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
                Text(snapshot.devotionalOutput.devotionalBody)
                    .font(.body)
                    .accessibilityIdentifier("devotionalDetail.transcript")

                Divider()

                Text("Prayer")
                    .font(.headline)
                Text(snapshot.devotionalOutput.prayer)
                    .font(.body)
                    .italic()
                    .accessibilityIdentifier("devotionalDetail.prayer")

                if let actionStep = snapshot.devotionalOutput.actionStep {
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

    /// F4 web-session-page parity, docs/05_UX_FLOWS.md §4 "Main": large
    /// play/pause control. No real audio asset ships with this stage (no
    /// live TTS pipeline yet), so tapping only flips the local `isPlaying`
    /// state — this is the "tap join -> audio plays" beat's UI, without
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

    /// docs/05_UX_FLOWS.md §4 "Amen — mark complete" button; becomes a
    /// quiet "Completed check" once tapped, zero-guilt (P2).
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

#Preview {
    NavigationStack {
        DevotionalDetailView(snapshot: try! DemoFixtureLoader.load(bundle: .main))
    }
}
