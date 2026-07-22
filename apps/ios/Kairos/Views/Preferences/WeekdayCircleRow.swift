import SwiftUI

/// The day-selection rule, extracted from the view so it can be tested
/// without driving a simulator (K3, #189).
///
/// The interesting behavior of this control is a single pure question — given
/// these days and this tap, what is the new set? — and leaving it inside a
/// `private func` on a `View` would have made the last-day guard reachable
/// only through a UI test. It is the rule most likely to be broken by a
/// future refactor and the one whose failure mode is a 400 from the API, so
/// it gets a unit test rather than a slow, flaky end-to-end one.
enum WeekdaySelection {
    /// The set produced by tapping `day`, or `nil` if the tap is refused.
    ///
    /// `nil` means "this would have emptied the selection" — see
    /// `WeekdayCircleRow.toggle(_:)` for why that is refused at the tap
    /// rather than repaired afterwards by `OnboardingPreferences.validated()`.
    static func toggling(_ day: Weekday, in days: Set<Weekday>) -> Set<Weekday>? {
        guard days.contains(day) else {
            var next = days
            next.insert(day)
            return next
        }
        guard days.count > 1 else { return nil }
        var next = days
        next.remove(day)
        return next
    }
}

/// The day-of-week selector: a compact row of circles — M T W T F S S —
/// tapped to toggle (K3, issue #189, replacing seven stacked `Toggle` rows).
///
/// Shared verbatim by onboarding (`PreferencesCaptureView`) and settings
/// (`PreferencesView`) rather than written twice: the two screens had already
/// grown two private copies of the day-ordering switch, and this control
/// carries enough accessibility behavior that a second copy would inevitably
/// become the stale one.
///
/// Lives under `Views/Preferences/` rather than a new `Views/Components/`
/// group deliberately: `Kairos.xcodeproj/project.pbxproj` is checked in and
/// `apple-ci.yml` builds it directly without running `xcodegen`, so every new
/// file is hand-added to the project. Reusing an existing group keeps that
/// edit to a single file reference instead of a new group object.
///
/// ## Why circles instead of toggles
/// Seven `Toggle` rows dominated a screen that also has to fit window,
/// cadence, duration, tradition, translation, voice, and stillness. The
/// tradeoff is real and worth naming: a `Toggle` is a *system* control, so it
/// inherits VoiceOver, Switch Control, Full Keyboard Access, Dynamic Type,
/// and Increase Contrast for free. Every one of those is re-earned by hand
/// below, and each is a place this control can regress in a way the toggles
/// could not. That is the actual cost of this issue, and the reason the
/// accessibility handling here is load-bearing rather than polish.
struct WeekdayCircleRow: View {
    /// The selected days. Bound straight through to
    /// `OnboardingPreferences.days`, which since #188 is the single source of
    /// truth the backend daily run actually gates on — so a tap here changes
    /// when devotionals generate, and `cadence` (a computed label over this
    /// set) re-derives itself with no wiring in this file.
    @Binding var days: Set<Weekday>

    /// Namespaces the per-circle `accessibilityIdentifier`s, matching the
    /// existing `preferencesCapture.*` / `preferences.*` convention so the
    /// two screens stay separately addressable from UI tests.
    let identifierPrefix: String

    /// Hit target and drawn diameter scale together with the user's text
    /// size. `@ScaledMetric` rather than a constant because a 44pt target is
    /// only "accessible" relative to default text — at accessibility sizes
    /// the finger has not grown but the expectation of a larger, easier
    /// target has, and scaling is also what drives the row to wrap (see
    /// `body`).
    @ScaledMetric(relativeTo: .body) private var hitTarget: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 36

    /// Set when the user tries to turn off their only remaining day, to
    /// briefly emphasize the explanation below the row. Transient and purely
    /// presentational — the rule itself is enforced in `toggle(_:)`.
    @State private var didRefuseDeselect = false

    private let spacing: CGFloat = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Dynamic Type: seven 44pt targets plus gaps need ~350pt, which
            // already does not fit a Form row on a small phone at the DEFAULT
            // text size — let alone at AX5, where `hitTarget` has scaled past
            // 100pt. A single `HStack` here would clip or squeeze below the
            // minimum target, which is exactly the failure this issue calls
            // out.
            //
            // `ViewThatFits` picks the first layout that actually fits the
            // available width, so the row degrades 7 across -> 4+3 -> 3+3+1
            // -> 2 per row as either the screen narrows or the text grows.
            // Columns are `.fixed(hitTarget)` rather than `.adaptive` on
            // purpose: `ViewThatFits` can only reject a candidate that
            // reports an intrinsic width, and an adaptive/flexible grid
            // always claims to fit, which would silently defeat the whole
            // mechanism.
            ViewThatFits(in: .horizontal) {
                grid(columns: 7)
                grid(columns: 4)
                grid(columns: 3)
                grid(columns: 2)
            }
            // Reads to VoiceOver as one "Days" group containing seven
            // controls, rather than seven orphaned buttons stranded between
            // "Cadence" and "Duration" — matching the grouping posture
            // already used in `CalendarConnectView`. `.contain` (not
            // `.combine`) keeps each circle individually focusable and
            // actionable; combining them would flatten the row into a single
            // unusable label.
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Days")

            // Always visible, not an error that appears on failure. The
            // constraint is part of what this control *is*, so stating it up
            // front is cheaper than letting someone discover it by tapping
            // something that then refuses to respond.
            Text("Wellspring needs at least one day.")
                .font(.caption)
                .foregroundStyle(didRefuseDeselect ? Color.accentColor : Color.secondary)
                .fontWeight(didRefuseDeselect ? .semibold : .regular)
                .animation(.easeInOut(duration: 0.2), value: didRefuseDeselect)
                .accessibilityIdentifier("\(identifierPrefix).days.minimumNotice")
        }
        .padding(.vertical, 4)
    }

    private func grid(columns count: Int) -> some View {
        LazyVGrid(
            columns: Array(
                repeating: GridItem(.fixed(hitTarget), spacing: spacing),
                count: count
            ),
            spacing: spacing
        ) {
            ForEach(Weekday.mondayFirst) { day in
                circle(for: day)
            }
        }
    }

    private func circle(for day: Weekday) -> some View {
        let isSelected = days.contains(day)
        let isOnlySelection = isSelected && days.count == 1

        return Button {
            toggle(day)
        } label: {
            Text(day.initial)
                // Selected state carries THREE signals, only one of which is
                // color (docs/07 §2's `session-a11y` bar is WCAG AA, and
                // 1.4.1 Use of Color applies to this row as squarely as it
                // does to the web session page):
                //   1. fill      — solid accent vs. empty
                //   2. weight    — semibold vs. regular
                //   3. border    — none vs. a visible stroked ring
                // Filled-vs-outlined is a luminance inversion, not a hue
                // change, so it survives grayscale and every form of color
                // blindness; the ring means an unselected circle is still a
                // visible, obviously-tappable object rather than bare text.
                .font(.callout.weight(isSelected ? .semibold : .regular))
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .frame(width: diameter, height: diameter)
                .background(Circle().fill(isSelected ? Color.accentColor : Color.clear))
                .overlay(
                    Circle().strokeBorder(
                        isSelected ? Color.clear : Color.secondary,
                        lineWidth: 1.5
                    )
                )
                // The drawn circle stays visually smaller than the target it
                // answers to: `diameter` (36pt) is what you see, `hitTarget`
                // (44pt) is what you can hit. `contentShape` is required for
                // that padding ring to actually receive taps — without it the
                // button's hit region collapses back to the rendered circle
                // and the 44pt guarantee is decorative.
                .frame(width: hitTarget, height: hitTarget)
                .contentShape(Rectangle())
        }
        // `.plain` because the default Form button style would tint the
        // label and swallow the fill/stroke distinction above — and, in a
        // `Form`, would also make the whole row tappable rather than the
        // seven circles individually.
        .buttonStyle(.plain)
        // A real control with a real label, not a shape wearing a tap
        // gesture: this is a `Button`, so it is reachable by Switch Control
        // and Full Keyboard Access and announces itself as actionable.
        //
        // The state is carried by the `.isSelected` TRAIT rather than
        // appended to the label. #189 writes the requirement as the string
        // "Monday, selected" — which is exactly what the trait makes
        // VoiceOver speak, but localized, and without the double-speak
        // ("Monday selected, selected") that hardcoding it into the label
        // would produce on any OS version that also honors the trait.
        .accessibilityLabel(day.fullName)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : [.isButton])
        .accessibilityHint(hint(isSelected: isSelected, isOnlySelection: isOnlySelection))
        .accessibilityIdentifier("\(identifierPrefix).day.\(day.rawValue)")
    }

    private func hint(isSelected: Bool, isOnlySelection: Bool) -> String {
        if isOnlySelection {
            return "This is your only selected day. Choose another day before turning this one off."
        }
        return isSelected ? "Double-tap to turn this day off." : "Double-tap to turn this day on."
    }

    /// The last-day rule (#189, and #188's empty-`activeDays` 400).
    ///
    /// Turning off the only remaining day is refused here rather than left to
    /// `OnboardingPreferences.validated()`. `validated()` does repair an empty
    /// set — it falls back to Mon–Fri — but that is a *storage* safety net,
    /// correct for a corrupt or legacy blob and wrong as an interaction:
    /// `PreferencesViewModel` persists on every change and applies the
    /// validated result straight back to the bound state, so a user whose
    /// only day was Wednesday would tap Wednesday once and watch five circles
    /// light up, Wednesday among them. One tap, six things change, and the
    /// thing they asked to remove is still on. There is no reading of that
    /// which looks deliberate.
    ///
    /// Since #188 the empty set is not merely untidy either: `activeDays: []`
    /// is a 400 from the API, because it means "never generate again,
    /// silently". Refusing at the tap keeps the invalid state from existing
    /// at all, instead of creating it and repairing it.
    ///
    /// Refusal is announced rather than silent. A control that simply ignores
    /// a tap is indistinguishable from a broken one, so the caption below the
    /// row briefly emphasizes for sighted users, and VoiceOver gets the same
    /// information through an announcement — the failure feedback should not
    /// be the one part of this control that is visual-only.
    private func toggle(_ day: Weekday) {
        guard let next = WeekdaySelection.toggling(day, in: days) else {
            didRefuseDeselect = true
            AccessibilityNotification.Announcement(
                "\(day.fullName) is your only selected day. Choose another day before turning this one off."
            ).post()
            return
        }
        days = next
        didRefuseDeselect = false
    }
}

#Preview("Default (Mon–Fri)") {
    Form {
        Section("Days") {
            WeekdayCircleRow(days: .constant(Weekday.weekdays), identifierPrefix: "preview")
        }
    }
}

#Preview("Single day — deselection refused") {
    Form {
        Section("Days") {
            WeekdayCircleRow(days: .constant([.wednesday]), identifierPrefix: "preview")
        }
    }
}

#Preview("Accessibility text size") {
    Form {
        Section("Days") {
            WeekdayCircleRow(days: .constant(Weekday.weekdays), identifierPrefix: "preview")
        }
    }
    .environment(\.dynamicTypeSize, .accessibility5)
}
