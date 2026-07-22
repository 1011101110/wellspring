import Foundation

/// Translates between the device's four `ConsentCategory` toggles and the
/// server's three consent columns (issue #225).
///
/// ## Why there are two representations at all
///
/// They gate different things, at different moments, and neither can be
/// deleted in favor of the other:
///
///  - **`ConsentStore` (device)** gates *derivation and collection*. It is
///    read before HealthKit is queried at all (`BandUploadService`, issue
///    #70): a category that is off means the sample is never read, never
///    turned into a band, and never leaves the phone. That is genuinely
///    device-only work — no server flag can prevent a read that happens on
///    the device — and it must keep working exactly as it does today.
///  - **`preferences.calendar_enabled` / `health_enabled` /
///    `communication_enabled` (server)** gate *use*. Since #201 the
///    generation pipeline consults them when loading bands and running the
///    calendar step, so a signal already stored can be suppressed at read
///    time (docs/03 §10.4).
///
/// Before #225 these were two disconnected representations of one user
/// decision, and iOS wrote only the first. This type is the bridge, so that
/// a toggle flipped on the phone reaches the gate that actually suppresses
/// the signal server-side, and a revocation performed on web reaches the
/// gate that stops the phone collecting in the first place.
///
/// ## The three-to-one collapse
///
/// `recovery`, `sleep`, and `activity` are three device toggles over one
/// server column. The mapping is asymmetric on purpose, and each direction
/// is chosen so that the *more restrictive* reading wins:
///
///  - **Device → server:** `healthEnabled` is the OR of the three. It means
///    "this device may send some health signal", which is exactly what the
///    server column gates. Sending `false` because one of three is off
///    would suppress the other two, which the user did not ask for.
///  - **Server → device:** a `false` turns **all three off**; a `true`
///    changes nothing. A false is an unambiguous revocation the user
///    performed on another surface, and the only faithful way to honor it
///    with a coarser flag is to revoke everything it covers. A true carries
///    no information about the finer-grained split — it only means "not
///    revoked at the coarse level" — so inferring three enabled categories
///    from it would manufacture consent the user never gave, and would
///    silently re-enable HealthKit reads on a phone where they were
///    deliberately turned off.
///
/// The consequence is that the collapse is lossy in exactly one harmless
/// direction: a user with only `sleep` enabled who visits web sees a single
/// "health" control reading enabled, and leaving it alone leaves their
/// device split intact. Only an explicit revocation crosses over, which is
/// the direction where being lossy would be a privacy defect rather than a
/// cosmetic one.
public enum ConsentSyncMapping {
    /// The three device categories backed by HealthKit, collapsed into the
    /// server's single `health_enabled`. `calendar` is deliberately absent —
    /// it maps 1:1 onto its own column.
    public static let healthCategories: [ConsentCategory] = [.recovery, .sleep, .activity]

    /// Builds the consent payload this device is entitled to write from the
    /// current device toggles. See the type doc for the OR.
    public static func writePayload(from store: any ConsentStore) -> RemoteConsentWrite {
        RemoteConsentWrite(
            calendarEnabled: store.isEnabled(.calendar),
            healthEnabled: healthCategories.contains { store.isEnabled($0) }
        )
    }

    /// Applies a pulled server snapshot to the device store.
    ///
    /// Revocation-only, in both cases, per the type doc: a server `false`
    /// turns the corresponding device categories off, and a server `true` is
    /// a no-op. `communicationEnabled` is read from the snapshot but has no
    /// device category to apply to, so it is intentionally ignored here —
    /// it exists on `RemoteConsentFlags` so the value is *visible*, not so
    /// that it is acted upon.
    ///
    /// Returns the categories actually changed, so callers can log or test
    /// the effect rather than re-deriving it.
    @discardableResult
    public static func applyRevocations(
        _ flags: RemoteConsentFlags,
        to store: any ConsentStore
    ) -> [ConsentCategory] {
        var changed: [ConsentCategory] = []

        if !flags.calendarEnabled, store.isEnabled(.calendar) {
            store.setEnabled(false, for: .calendar)
            changed.append(.calendar)
        }

        if !flags.healthEnabled {
            for category in healthCategories where store.isEnabled(category) {
                store.setEnabled(false, for: category)
                changed.append(category)
            }
        }

        return changed
    }
}
