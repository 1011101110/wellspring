# BandDeriver

Pure-Swift package that turns HealthKit-shaped input data into the three
on-device health bands defined in `docs/00_FOUNDATION.md` §5:

- `recovery`: `low` · `moderate` · `high` — from HRV (SDNN) vs a personal
  rolling baseline, nudged by resting-HR trend.
- `sleepQuality`: `poor` · `fair` · `good` — from sleep duration + stage
  distribution (efficiency + deep/REM restorative fraction).
- `activity`: `sedentary` · `moderate` · `active` — from recent
  workouts/steps/active energy vs a personal rolling baseline.

**No `import HealthKit`, no Xcode project.** This target only depends on
Foundation. The iOS app (a separate Xcode target, not part of this package)
is responsible for querying real `HKSample`s and mapping them into the
plain-Swift input structs in `Sources/BandDeriver/HealthInputs.swift`
before calling `BandDeriver.deriveBands(from:)`.

## Privacy contract (docs/00_FOUNDATION.md §8)

Raw HealthKit samples/timelines must never leave the phone. The output type
`HealthBands` is declared so it **cannot structurally hold** a raw
numeric/Date/String value — its only three stored properties are the closed
band enums above. `HealthBandsShapeTests` verifies this via reflection and
a JSON round-trip, so any future change that accidentally adds a raw field
to `HealthBands` fails CI.

## Running tests

```sh
cd apps/ios/Packages/BandDeriver
swift test
```

On a machine where only the Command Line Tools are selected (no full Xcode
selected via `xcode-select`), `swift test` may fail with `XCTest not
available` even though Xcode.app is installed. Point `DEVELOPER_DIR` at the
full Xcode toolchain for the test run only:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
```

56 tests, 0 failures as of this package's initial implementation, covering:

- Boundary values for every threshold (HRV z-score ±0.5, resting-HR trend
  ±3bpm, sleep duration 5h/7h cutoffs, sleep efficiency 0.85, restorative
  fraction 0.30, activity baseline ratios 1.2/0.5, population fallback
  thresholds) at exactly-on and just-off-boundary values.
- Missing/insufficient baseline data (no HRV samples, no sleep session, zero
  baseline history, baseline below the 7-day trust minimum, zero standard
  deviation) all resolve to sensible non-verdict defaults (`moderate`,
  `fair`) rather than crashing or asserting an extreme band on thin
  evidence.
- Extreme outlier inputs (absurd HRV/HR/step/energy/sleep-duration values,
  negative values) are clamped to a plausible range rather than propagating
  garbage or crashing.
- `HealthBands` output-type shape: reflection + JSON-round-trip tests
  proving the type cannot carry a raw HealthKit value (defense in depth for
  the §8 privacy rule).
