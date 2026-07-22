/**
 * When this devotional's audio goes away, said BEFORE it does (N4, #263).
 *
 * ## What this story asked for, and why only half of it is here
 *
 * #263 asked that audio be kept for devotionals the user actually
 * completed — search is built precisely for "there was one about rest, a
 * few weeks ago", and the devotional most worth replaying is by
 * definition an older one.
 *
 * That half is not implementable in this repository alone. The 14-day
 * window is not only `DEVOTIONAL_AUDIO_RETENTION_DAYS` in the purge job:
 * it is also a **GCS bucket lifecycle rule** (`06_DEPLOYMENT_CI_CD.md`
 * §1.4, `{"action":{"type":"Delete"},"condition":{"age":14}}`) and a
 * published commitment in `04_DATA_PRIVACY_SECURITY.md`. Raising the
 * constant alone would leave the bucket deleting objects on schedule
 * while the database went on holding a reference to them — a row that
 * confidently claims audio exists, and a player that 404s. That is the
 * exact failure this epic exists to stop making.
 *
 * Extending it properly means changing a retention promise made to users,
 * which is a decision for the product owner and not a refactor. Tracked
 * on #263.
 *
 * ## The half that is real, and is here
 *
 * #263's fallback: *"if storage genuinely constrains this, say so BEFORE
 * day 14 rather than after."* A user who knows the audio expires on the
 * 3rd can listen again on the 2nd. A user who finds out on the 15th can
 * do nothing at all, and the product has silently taken something from
 * them. Same retention, opposite experience — and it needs no schema
 * change, because the date is a pure function of the devotional's own
 * date and a constant that is already published.
 */

/**
 * Mirrors `DEVOTIONAL_AUDIO_RETENTION_DAYS` in
 * `apps/api/src/services/retention/purgeJobs.ts`.
 *
 * Duplicated rather than imported: the web client does not depend on the
 * API package, and inventing a dependency for one integer would be worse
 * than the duplication. `audioRetention.test.ts` asserts the two agree,
 * so a change to one that forgets the other fails the build rather than
 * quietly telling users the wrong date.
 */
export const AUDIO_RETENTION_DAYS = 14;

/** How the audio's remaining life should be described, or `null` for silence. */
export type AudioLifetime =
  /** Comfortably in future — saying nothing is kinder than a countdown. */
  | { kind: 'silent' }
  /** Close enough that a user might want to act. */
  | { kind: 'expiring'; on: string }
  /** Already gone; the detail view has its own copy for this. */
  | { kind: 'expired' };

/**
 * How many days before expiry we start saying anything.
 *
 * Not the full 14. A notice that appears the moment a devotional is
 * created would sit under every single one, which turns a courtesy into
 * furniture and — per docs/14 §5.10 — starts to read as a deadline the
 * user is being measured against. Three days is enough to act on and
 * short enough that seeing it means something.
 */
export const NOTICE_WINDOW_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `devotionalDate` is a CALENDAR DAY (`'2026-07-19'`), not an instant —
 * the distinction that rendered a Postgres `date` a day early in #209.
 * Parsed as UTC midnight deliberately: the retention sweep is a global
 * job on a UTC cutoff, so the date shown must be derived the same way the
 * deletion actually happens, not from the reader's local midnight.
 */
export function audioLifetime(devotionalDate: string, now: Date): AudioLifetime {
  const created = Date.parse(`${devotionalDate}T00:00:00Z`);
  if (Number.isNaN(created)) return { kind: 'silent' };

  const expiresAt = created + AUDIO_RETENTION_DAYS * MS_PER_DAY;
  const daysLeft = Math.ceil((expiresAt - now.getTime()) / MS_PER_DAY);

  if (daysLeft <= 0) return { kind: 'expired' };
  if (daysLeft > NOTICE_WINDOW_DAYS) return { kind: 'silent' };

  return { kind: 'expiring', on: new Date(expiresAt).toISOString().slice(0, 10) };
}

/**
 * The sentence itself.
 *
 * States a fact and stops. Not "hurry", not "don't lose this", and no
 * count of how many days remain — a number here would be a small clock
 * over a devotional, which is the accounting §9 rules out. The date is
 * the actionable part; the urgency is the user's to feel or not.
 */
export function audioExpiryNotice(lifetime: AudioLifetime, formatDate: (d: string) => string): string | null {
  if (lifetime.kind !== 'expiring') return null;
  return `The audio for this one is kept until ${formatDate(lifetime.on)}. The words stay.`;
}
