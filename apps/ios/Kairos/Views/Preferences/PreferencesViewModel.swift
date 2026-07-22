import Foundation
import SwiftUI

/// Drives the F7 Preferences screen (docs/01_PRD.md F7, docs/05_UX_FLOWS.md
/// §3.1 "Preferences" — "Everything from onboarding screen 5, editable any
/// time; changes apply to the *next* scheduled run").
///
/// Loads from `PreferencesStore` on init and writes through on every field
/// change (no separate "Save" button — matches the UX doc's "Inline save
/// spinner" / "Saved locally — will sync" states), so the source of truth
/// on screen is always exactly what is persisted.
@MainActor
public final class PreferencesViewModel: ObservableObject {
    @Published public var preferences: OnboardingPreferences {
        didSet {
            guard !isApplyingExternalUpdate else { return }
            persist()
        }
    }

    /// Drives the brief "Saved locally" confirmation the UX doc calls for.
    @Published public private(set) var didJustSave = false

    private let store: any PreferencesStore
    /// Guards against `didSet` re-persisting a value that just came back
    /// *from* `store.save` (e.g. the validated/clamped result), which would
    /// otherwise be redundant (harmless, but pointless extra writes/pushes).
    private var isApplyingExternalUpdate = false
    private var saveConfirmationTask: Task<Void, Never>?

    public init(store: any PreferencesStore) {
        self.store = store
        self.preferences = store.load()
    }

    private func persist() {
        let validated = store.save(preferences)
        if validated != preferences {
            isApplyingExternalUpdate = true
            preferences = validated
            isApplyingExternalUpdate = false
        }
        flashSaveConfirmation()
    }

    private func flashSaveConfirmation() {
        saveConfirmationTask?.cancel()
        didJustSave = true
        saveConfirmationTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            self?.didJustSave = false
        }
    }
}
