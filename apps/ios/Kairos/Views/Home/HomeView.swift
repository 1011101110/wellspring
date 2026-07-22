import SwiftUI
import BandDeriver

/// docs/05_UX_FLOWS.md §3.1 "Home" — next-devotional card + bands as
/// gentle phrases (never numbers, P5), plus the manual "Refresh now"
/// trigger for the morning band upload pipeline (issue #37 / EPIC E4).
struct HomeView: View {
    /// Non-nil only in demo mode (issue #41 / EPIC E8): the decoded
    /// `fixtures/snapshots/low_poor_heavy.json` snapshot, driving both the
    /// band phrases and the next-devotional card content per the
    /// judge-facing arc in docs/05_UX_FLOWS.md §8. Real bands/devotionals
    /// come from on-device HealthKit derivation + the backend scheduling
    /// run, wired in a later stage.
    var demoFixture: DemoFixtureSnapshot?

    /// `nil` in previews that don't need the refresh button wired up.
    @ObservedObject var bandUploadService: BandUploadService

    /// Backend contract for the "I could use a moment now" distress
    /// check-in front door (docs/14_IMPROVEMENT_REVIEW.md §5.8, issue #77).
    let distressCheckinClient: any DistressCheckinRequesting

    @Environment(\.openURL) private var openURL
    @State private var isCheckingIn = false
    @State private var checkinFailed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Spacer()

                if let demoFixture {
                    demoBandPhrasesView(demoFixture)
                    nextDevotionalCard(demoFixture)
                } else {
                    Image(systemName: "sparkles")
                        .font(.largeTitle)
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    Text("Nothing scheduled yet — your next devotional lands tomorrow morning.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 32)
                        .accessibilityIdentifier("home.emptyState")
                }

                bandStatusView
                    .accessibilityIdentifier("home.bandStatus")

                Button("Preview") {}
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("home.previewButton")

                Button {
                    Task { await bandUploadService.refreshAndUpload() }
                } label: {
                    if bandUploadService.isRefreshing {
                        ProgressView()
                    } else {
                        Text("Refresh now")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(bandUploadService.isRefreshing)
                .accessibilityIdentifier("home.refreshNowButton")

                Button {
                    Task { await checkInNow() }
                } label: {
                    if isCheckingIn {
                        ProgressView()
                    } else {
                        Text("I could use a moment now")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isCheckingIn)
                .accessibilityIdentifier("home.distressCheckinButton")

                if checkinFailed {
                    Text("Couldn't reach Kairos just now — please try again in a moment. If you need immediate help, call or text 988.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .accessibilityIdentifier("home.distressCheckinError")
                }

                Spacer()
            }
            .navigationTitle("Home")
        }
    }

    /// Bands as gentle phrases (P5), per docs/05_UX_FLOWS.md §8 t=0-5s:
    /// "Your body is asking for gentleness · sleep was short · today looks
    /// heavy." Uses the same `BandPhrase` mapping the real HealthKit path
    /// will use — demo mode exercises production copy, not a demo-only
    /// fork.
    private func demoBandPhrasesView(_ fixture: DemoFixtureSnapshot) -> some View {
        VStack(spacing: 4) {
            ForEach(
                BandPhrase.phrases(for: fixture.healthBands) + [BandPhrase.busynessPhrase(fixture.bands.busyness)],
                id: \.self
            ) { phrase in
                Text(phrase)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("home.bandPhrases")
    }

    /// "Next devotional" card (docs/05_UX_FLOWS.md §3.1 Home purpose):
    /// theme, card summary, and a tap target into the full devotional
    /// detail — the §8 t=12-28s beats ("open the calendar event" / "tap
    /// Join") collapsed into a single in-app card since this stage has no
    /// live calendar event or session page to deep-link into yet.
    private func nextDevotionalCard(_ fixture: DemoFixtureSnapshot) -> some View {
        NavigationLink {
            DevotionalDetailView(snapshot: fixture)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text("Kairos — a moment of rest")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(fixture.devotionalOutput.cardSummary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                Label("Join", systemImage: "arrow.right.circle.fill")
                    .font(.subheadline.bold())
                    .accessibilityIdentifier("home.joinButton")
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 24)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("home.nextDevotionalCard")
    }

    /// Fires the distress check-in (docs/14_IMPROVEMENT_REVIEW.md §5.8) and
    /// opens the returned session directly — this is "the moment the
    /// product exists for," so a failure is shown gently with a 988
    /// fallback rather than a raw error.
    private func checkInNow() async {
        isCheckingIn = true
        checkinFailed = false
        defer { isCheckingIn = false }

        do {
            let result = try await distressCheckinClient.checkInNow()
            openURL(result.sessionUrl)
        } catch {
            checkinFailed = true
        }
    }

    /// Gentle, non-alarming status copy for the most recent refresh
    /// outcome — mirrors docs/05_UX_FLOWS.md §3.1's "Bands section shows
    /// 'calendar-only today' without complaint" error-state guidance: a
    /// failed/denied HealthKit read is never shown as an error, only as a
    /// quiet fallback state.
    @ViewBuilder
    private var bandStatusView: some View {
        switch bandUploadService.lastOutcome {
        case .none:
            EmptyView()
        case .uploaded:
            Text("Today's bands are up to date.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .skippedNoHealthData:
            Text("Calendar-only today — no health data to include.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .uploadFailed:
            Text("Bands derived, but couldn't reach Kairos — we'll try again soon.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    HomeView(
        demoFixture: try? DemoFixtureLoader.load(bundle: .main),
        bandUploadService: BandUploadService(
            healthReader: FakeHealthSampleReader(nextInput: .demoFixture),
            uploadClient: FakeBandUploadClient(),
            consentStore: InMemoryConsentStore(initial: [.recovery: true, .sleep: true, .activity: true])
        ),
        distressCheckinClient: FakeDistressCheckinClient()
    )
}
