/**
 * Dashboard accessibility, measured in a browser (N5, issue #264).
 *
 * ## Why this suite exists at all
 *
 * All four of #264's findings were live in `main` while 183 unit tests
 * passed, lint was clean and the build was green — because every one of
 * them is a property of the *rendered* page:
 *
 * - the focus ring's painted position depended on an ancestor's
 *   `overflow: hidden` three rules away
 * - the busy-block label's worst-case contrast depended on where a
 *   repeating gradient's stripe happened to cross a glyph
 * - the outside-month day number's contrast depended on an `opacity`
 *   composite, not on any colour written anywhere
 * - the view pills were `<label>`s, so `button { min-height: 44px }`
 *   never applied to them
 *
 * Not one of those is visible in the source of the rule that causes it.
 * This is the #253 lesson in a different medium: a check that reads the
 * same declarations the author wrote agrees with the author. So every
 * assertion below reads `getBoundingClientRect()` or `getComputedStyle()`
 * off the live layout, and none of them parses CSS.
 *
 * ## Scoped axe, deliberately
 *
 * The colour-contrast run is scoped to the calendar card rather than the
 * whole page. `preview.html` renders every card in every state at once —
 * including four copies of some — so a page-wide run reports the same
 * finding many times and tempts the next person to add a disable comment.
 * A narrow rule set that fails loudly beats a broad one that gets muted.
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PREVIEW = '/preview.html';

/** WCAG 1.4.11 / 2.4.13: non-text contrast, and focus appearance. */
const NON_TEXT_MIN = 3;
/** The bar every other control in this app already holds. */
const TARGET_MIN = 44;

test.beforeEach(async ({ page }) => {
  await page.goto(PREVIEW);
  await page.waitForSelector('.cal-modes');
});

test('A1 — the focus ring on the selected view pill is painted outside the pill, not on its fill', async ({
  page,
}) => {
  const ring = await page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>('.cal-mode.is-selected')!;
    pill.querySelector<HTMLInputElement>('input[type=radio]')!.focus();
    const cs = getComputedStyle(pill);

    // Walk up looking for anything that would clip the ring. This is the
    // actual #264/A1 cause: `.cal-modes { overflow: hidden }` clipped it,
    // which forced a negative offset, which put a 1.56:1 ring on the
    // accent fill.
    let clipped = false;
    for (let n = pill.parentElement; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).overflow !== 'visible') clipped = true;
    }
    return {
      focusWithin: pill.matches(':focus-within'),
      offset: parseFloat(cs.outlineOffset),
      width: parseFloat(cs.outlineWidth),
      clipped,
    };
  });

  expect(ring.focusWithin, 'focusing the radio must style its label').toBe(true);
  expect(ring.width, 'a zero-width outline is no outline').toBeGreaterThan(0);
  // The assertion that matters. A negative offset draws the ring inside
  // the element — on the selected pill that is the accent fill, where
  // `--focus` measures 1.56:1 light and 1.22:1 dark against a 3:1 bar.
  expect(ring.offset, 'ring must sit outside the pill, on the card surface').toBeGreaterThan(0);
  expect(ring.clipped, 'an ancestor with overflow != visible will clip the ring').toBe(false);
});

test('A5 — the calendar controls meet the same 44px target as every other control', async ({
  page,
}) => {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.cal-mode, .cal-nav .quiet')].map((el) => ({
      label: el.textContent?.trim().slice(0, 12) ?? '?',
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
    })),
  );

  expect(boxes.length, 'expected three view pills and two arrows').toBeGreaterThanOrEqual(5);
  for (const box of boxes) {
    expect(box.h, `"${box.label}" height`).toBeGreaterThanOrEqual(TARGET_MIN);
    expect(box.w, `"${box.label}" width`).toBeGreaterThanOrEqual(TARGET_MIN);
  }
});

test('A2 — busy-block labels are legible at the worst point, not the average', async ({ page }) => {
  // The original defect measured 6.08:1 between stripes and 1.59:1 ON a
  // stripe. An average would have passed. The fix is a solid plate behind
  // the label, so what this asserts is that the label paints its own
  // opaque background rather than inheriting the hatched one.
  const labels = await page.evaluate(() => {
    const rows: { cls: string; bg: string; parentHasHatch: boolean }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      '.cal-block-busy .cal-block-kind, .cal-block-busy .cal-block-time',
    )) {
      const block = el.closest<HTMLElement>('.cal-block-busy')!;
      rows.push({
        cls: el.className,
        bg: getComputedStyle(el).backgroundColor,
        parentHasHatch: getComputedStyle(block).backgroundImage.includes('gradient'),
      });
    }
    return rows;
  });

  expect(labels.length, 'no busy blocks rendered — fixture regression').toBeGreaterThan(0);
  for (const label of labels) {
    expect(label.parentHasHatch, 'the hatch is the block’s identity and should stay').toBe(true);
    expect(
      label.bg,
      `${label.cls} must have its own opaque plate, or a stripe crosses its glyphs`,
    ).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
});

test('A4 — outside-month day numbers survive their own opacity', async ({ page }) => {
  // #264/A4 was invisible in the CSS: no colour in the file fails. The
  // failure only exists after `opacity` composites the inherited colour
  // against the cell, which is a thing only a laid-out page knows.
  const contrast = await page.evaluate(() => {
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const parse = (s: string) => s.match(/[\d.]+/g)!.slice(0, 3).map(Number);

    const el = document.querySelector<HTMLElement>('.cal-month-cell.is-outside .cal-month-day')!;
    // Accumulate every ancestor opacity down to the first opaque
    // background — the composite the user's eye actually receives.
    let opacity = 1;
    let bg = [255, 255, 255];
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= parseFloat(cs.opacity);
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) {
        bg = parse(cs.backgroundColor);
        break;
      }
    }
    const fg = parse(getComputedStyle(el).color);
    const composited = fg.map((v, i) => v * opacity + bg[i]! * (1 - opacity));
    const [a, b] = [lum(composited), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });

  // 4.5:1 — these are 12px day numbers, so the large-text exception does
  // not apply. The defect measured 3.89:1.
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});

test('the calendar card has no axe colour-contrast violations', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .include('.dash-card')
    .withRules(['color-contrast'])
    .analyze();

  // Print the offending markup rather than just a count — a bare
  // `toHaveLength(0)` failure tells the next person nothing about where.
  const detail = results.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1] ?? ''}`),
  );
  expect(detail).toEqual([]);
});

/**
 * The workday window's actual purpose, measured (N6, issue #265).
 *
 * #265's premise was that 58% of the calendar was empty night, and that
 * the resulting compression — not `overflow: hidden` by itself — was what
 * sheared block labels in half. That is a claim about rendered geometry,
 * so it gets a rendered check. The unit tests in `timeWindow.test.ts`
 * assert the zoom arithmetic; only this can assert that the arithmetic
 * bought what it was supposed to buy.
 */
test('N6 — a short block is tall enough for its label once the day is windowed', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const windowed = document.querySelectorAll<HTMLElement>('.cal-timegrid')[0]!;
    const whole = document.querySelectorAll<HTMLElement>('.cal-timegrid')[1]!;

    const shortest = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>('.cal-block-busy')]
        .map((el) => el.getBoundingClientRect().height)
        .sort((a, b) => a - b)[0] ?? 0;

    return {
      zoom: getComputedStyle(windowed).getPropertyValue('--cal-zoom').trim(),
      windowedShortest: shortest(windowed),
      wholeDayShortest: shortest(whole),
      // The window must be a starting position, not a crop: the column is
      // taller than its viewport, so everything outside is still there.
      scrollable: windowed.scrollHeight > windowed.clientHeight + 1,
    };
  });

  expect(Number(result.zoom)).toBeGreaterThan(2);
  // The whole point: the same block, bigger, because the same height now
  // covers ten hours instead of twenty-four.
  expect(result.windowedShortest).toBeGreaterThan(result.wholeDayShortest);
  // Enough for one line of 0.7rem/1.25 text plus its padding. Below this
  // the label shears, which is the defect.
  expect(result.windowedShortest).toBeGreaterThanOrEqual(14);
  expect(result.scrollable, 'the window must scroll, never crop').toBe(true);
});

test('N6 — the hour axis stays put when the week view scrolls sideways', async ({ page }) => {
  // #265/C3: at 375px the week view shows ~2.4 of 7 days, and the axis
  // used to scroll away with the content — so scrolling to Thursday left
  // the blocks with no hour labels at all. macOS overlay scrollbars are
  // invisible, so nothing even signalled that the other days existed.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForSelector('.cal-axis');

  const stuck = await page.evaluate(() => {
    const grid = [...document.querySelectorAll<HTMLElement>('.cal-timegrid')].find(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    if (!grid) return null;
    const axis = grid.querySelector<HTMLElement>('.cal-axis')!;
    const before = axis.getBoundingClientRect().left;
    grid.scrollLeft = grid.scrollWidth - grid.clientWidth;
    const after = axis.getBoundingClientRect().left;
    return { moved: Math.abs(after - before), position: getComputedStyle(axis).position };
  });

  expect(stuck, 'no horizontally-scrollable grid found at 375px').not.toBeNull();
  expect(stuck!.position).toBe('sticky');
  expect(stuck!.moved, 'the axis must not scroll away with the columns').toBeLessThan(2);
});
