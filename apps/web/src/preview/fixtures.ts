/**
 * Fixture data for the states preview (L9, issue #245).
 *
 * Shapes are the wire shapes from `@kairos/shared-contracts`, so a
 * contract change breaks this file at compile time rather than leaving the
 * preview quietly showing a shape the server no longer sends.
 */
import type {
  Connection,
  DevotionalCard,
  MonthlyRecapResponseData,
  UpcomingCalendarEvent,
  Verse,
} from '@kairos/shared-contracts';

export const PREVIEW_ZONE = 'America/Chicago';

/**
 * The passage the Today card shows in the preview (N2, #261).
 *
 * **Copied byte-for-byte from `fixtures/snapshots/low_poor_heavy.json`,
 * and pinned to it by `test/previewScripture.test.ts`.** Every other value
 * in this file is invented, which is fine for a theme or a card summary
 * and is *not* fine for Scripture: docs/14 §5.10 treats the byte-exact
 * YouVersion rule as a theological position, and a plausible-looking verse
 * someone typed from memory into a fixture is the first place that rule
 * would quietly stop being true. The test reads the snapshot off disk and
 * fails if these two ever differ, so this cannot drift into an
 * approximation.
 *
 * `low_poor_heavy` because the preview's Today card is themed on rest and
 * this is that fixture's passage — the pairing is honest rather than
 * arbitrary.
 */
export const previewVerse: Verse = {
  usfm: 'MAT.11.28-MAT.11.30',
  versionId: 3034,
  reference: 'Matthew 11:28-30',
  fetchedText:
    'Come to Me, all you who labor and are heavy-laden, and I will give you rest. Take My yoke upon you and learn from Me, for I am gentle and humble in heart, and you will find rest for your souls. For My yoke is easy and My burden is light.',
  attribution: 'Berean Standard Bible (BSB). Public domain.',
};

/** Fixed so the preview is deterministic: a Wednesday afternoon in Chicago. */
export const PREVIEW_NOW = new Date('2026-07-22T18:00:00Z');

export const devotionalToday: DevotionalCard = {
  id: 'dev-today',
  date: '2026-07-22',
  theme: 'Rest is not a reward',
  cardSummary: 'A few minutes on why rest precedes work rather than paying for it.',
  format: 'short',
  createdAt: '2026-07-22T12:00:00Z',
  completedAt: null,
};

export const devotionalCompleted: DevotionalCard = {
  ...devotionalToday,
  id: 'dev-done',
  completedAt: '2026-07-22T13:05:00Z',
};

export const devotionalsPast: DevotionalCard[] = [
  devotionalCompleted,
  {
    id: 'dev-2',
    date: '2026-07-21',
    theme: 'The narrow gate',
    cardSummary: 'On choosing the harder road when it is also the truer one.',
    format: 'standard',
    createdAt: '2026-07-21T12:00:00Z',
    completedAt: '2026-07-21T12:30:00Z',
  },
  {
    id: 'dev-3',
    date: '2026-07-20',
    theme: 'Enough for today',
    cardSummary: 'Manna, and the discipline of not hoarding tomorrow’s portion.',
    format: 'micro',
    createdAt: '2026-07-20T12:00:00Z',
    // Deliberately never completed — the list must not shame this row.
    completedAt: null,
  },
];

export const upcomingEvents: UpcomingCalendarEvent[] = [
  {
    id: 'evt-1',
    gapStartAt: '2026-07-23T14:00:00Z',
    gapEndAt: '2026-07-23T14:15:00Z',
    meetUri: 'https://meet.google.com/abc-defg-hij',
    rescheduleCount: 0,
    devotional: {
      id: 'dev-4',
      theme: 'Still waters',
      cardSummary: 'Psalm 23, and what it means to be led rather than driven.',
    },
  },
  {
    id: 'evt-2',
    gapStartAt: '2026-07-24T15:30:00Z',
    gapEndAt: '2026-07-24T15:45:00Z',
    meetUri: null,
    // Exercises the "Wellspring moved this" admission (#240).
    rescheduleCount: 3,
    devotional: null,
  },
];

export const connectionActive: Connection = {
  provider: 'google_calendar',
  status: 'active',
  connectedAt: '2026-06-01T10:00:00Z',
  scopes: ['https://www.googleapis.com/auth/calendar.events'],
};

export const recap: MonthlyRecapResponseData = {
  year: 2026,
  month: 6,
  // Present in the payload and deliberately never rendered — see
  // RecapCardBody for why.
  sessionsCount: 14,
  recurringPassages: ['Psalm 23', 'Matthew 11'],
  heavyWeek: { label: 'The week of the 15th looked like a heavy one.' },
  narrative:
    'June was quieter than May. You came back to Psalm 23 more than once, and the sessions you kept were mostly in the late morning — a pattern that has been steady since spring.',
};
