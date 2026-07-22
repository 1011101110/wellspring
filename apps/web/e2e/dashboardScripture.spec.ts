/**
 * N2 (#261) + N10 (#269), asserted against the laid-out page.
 *
 * ## Why in a browser and not a unit test
 *
 * The unit tests prove `anchorForToday` picks the right devotional and
 * `seasonLine` renders the right words. Neither proves those words reach
 * the screen — the exact gap this epic exists to close (a component wired
 * but never mounted, a prop threaded to a card that drops it). #261's
 * acceptance is literally "Scripture visible on the Today card", which is
 * a property of pixels, not of a pure function. So this drives
 * `preview.html`, which renders every Today state at once with the
 * fixture verse and season, and reads the rendered DOM.
 *
 * ## Anchored to the fixture, not to a typed-in string
 *
 * The expected verse text is imported from `src/preview/fixtures.ts` —
 * the same `previewVerse` the card renders and that
 * `test/previewScripture.test.ts` pins byte-for-byte to a real generated
 * devotional. This spec therefore cannot pass against a page showing some
 * other, invented verse: the string it looks for is the one real passage
 * in the client (Test Plan §3.1 rule 3 — assert against the producer's
 * value, never a restatement of it).
 */
import { expect, test } from '@playwright/test';
import { previewVerse } from '../src/preview/fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/preview.html');
  await page.waitForSelector('#p-today-ready-heading');
});

test('N2 — the ready Today card shows Scripture, with attribution, and no "recent" caption', async ({
  page,
}) => {
  const card = page.locator('section.dash-card:has(#p-today-ready-heading)');
  const verse = card.locator('.verse');

  // The passage itself is on the card.
  await expect(verse.locator('p')).toHaveText(previewVerse.fetchedText);

  // Attribution travels with it (Foundation §4.3) — reference AND source,
  // in the same <cite> the session page uses.
  const cite = verse.locator('cite');
  await expect(cite).toContainText(previewVerse.reference);
  await expect(cite).toContainText(previewVerse.attribution);

  // Today's passage is presented as today's — the "from the last
  // devotional" caption must NOT appear, or the card would disclaim a
  // verse it did in fact choose for today (#196).
  await expect(card).not.toContainText('From the last devotional');
});

test('N2 — the open Today card, the emptiest state, still carries Scripture and says it is recent', async ({
  page,
}) => {
  // #261: "the emptiest state is where a single verse would do the most
  // work." A returning user with nothing scheduled must still see
  // Scripture without opening anything — and it must be labelled as the
  // last devotional's, not framed as today's.
  const card = page.locator('section.dash-card:has(#p-today-open-heading)');
  await expect(card.locator('.verse p')).toHaveText(previewVerse.fetchedText);
  await expect(card).toContainText('From the last devotional');
});

test('N2 — a first-run Today card shows no Scripture at all (no invented stand-in)', async ({
  page,
}) => {
  // The all-empty first-run section renders a Today card for a user with
  // no devotionals. There is no real Scripture for that user, so the card
  // shows none — absence, not a fixture verse dressed as theirs.
  const firstRunToday = page.locator('section.dash-card:has(#p-fr-today-heading)');
  await expect(firstRunToday.locator('.verse')).toHaveCount(0);
});

test('N10 — the season is named on the Today card, as orientation with no count', async ({
  page,
}) => {
  const card = page.locator('section.dash-card:has(#p-today-ready-heading)');
  // The preview is pinned to Lent. The line names the season...
  await expect(card).toContainText('It is Lent');
  // ...and carries no number or week — the countdown §9 forbids. Scoped to
  // the season line so the verse reference (which contains digits) does
  // not trip it.
  const seasonText = await card.locator('p.hint').first().innerText();
  expect(seasonText).toMatch(/It is Lent/);
  expect(seasonText).not.toMatch(/\d/);
  expect(seasonText).not.toMatch(/\bweek\b/i);
});
