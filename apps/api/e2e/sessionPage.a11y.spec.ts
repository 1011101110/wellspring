/**
 * Browser-rendered accessibility suite for the session page (issue #67,
 * follow-up on #31's original acceptance criteria). Covers the same
 * ground as apps/api/tests/routes/session.integration.test.ts's
 * `GET /session/:token` assertions (audio present/absent, HTML-escaping,
 * completed state), but rendered in a real browser engine — plus the
 * automated axe-core WCAG AA pass that a Fastify `app.inject()` test
 * structurally cannot perform (there is no browser involved there at all).
 *
 * Deliberately does NOT boot a live server + Postgres + seeded session.
 * `renderSessionPage(data: SessionPageData): string` (apps/api/src/services/
 * session/renderSessionPage.ts) is a pure function — no DB, no network, no
 * Fastify request in its signature — so calling it directly with realistic
 * fixture data and loading the result via `page.setContent()` produces
 * byte-identical markup/CSS to what a real `GET /session/:token` response
 * would render, without any of the live-dependency setup (real Postgres,
 * GLOO_CLIENT_ID/YOUVERSION_API_KEY env vars just to satisfy constructors,
 * a seeded session token) a real HTTP round-trip would require.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  renderSessionPage,
  renderSessionCompletePage,
  renderGoneOrUnknownPage,
  type SessionPageData,
} from '../src/services/session/renderSessionPage.js';

function baseData(overrides: Partial<SessionPageData> = {}): SessionPageData {
  return {
    devotional: {
      theme: 'Rest for the weary',
      format: 'short',
      verses: [
        {
          usfm: 'MAT.11.28',
          reference: 'Matthew 11:28',
          fetchedText: 'Come to Me, all you who are weary and burdened, and I will give you rest.',
          attribution: 'Berean Standard Bible',
        },
      ],
      devotionalBody: 'A short devotional body about rest.',
      prayer: 'Lord, grant me rest.',
      journalingPrompt: null,
      actionStep: null,
    },
    audioUrl: 'https://storage.googleapis.com/kairos-audio/devotionals/example.mp3?signed=1',
    completed: false,
    token: '00000000-0000-0000-0000-000000000001', // obviously-fake fixture token, never a real session
    ...overrides,
  };
}

test.describe('session page — WCAG AA (axe-core)', () => {
  test('main state (audio present, not yet completed) has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData()));
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('AUDIO_UNAVAILABLE state has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData({ audioUrl: null })));
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('completed state has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData({ completed: true })));
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('with journaling prompt and action step present has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(
      renderSessionPage(
        baseData({
          devotional: {
            ...baseData().devotional,
            journalingPrompt: 'What burden could you hand over today?',
            actionStep: 'Take one slow breath before your next task.',
          },
        }),
      ),
    );
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('the "gone or unknown" 404 page has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(renderGoneOrUnknownPage());
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  // #321: the post-Amen page in both of its states — the feedback form
  // (radio fieldsets, note input, Send) and the thanked state. Contrast
  // and labeling per #264's bar, same axe pass as every other state.
  test('post-Amen page with the feedback form has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(
      renderSessionCompletePage({
        token: '00000000-0000-0000-0000-000000000001',
        feedbackSubmitted: false,
      }),
    );
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('post-Amen page in the thanked state has zero WCAG AA violations', async ({ page }) => {
    await page.setContent(
      renderSessionCompletePage({
        token: '00000000-0000-0000-0000-000000000001',
        feedbackSubmitted: true,
      }),
    );
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  // #321's tap-target criterion, checked against the LAID-OUT page (the
  // #264 lesson: geometry only exists after layout). Every radio pill and
  // the Send button must meet the 44px minimum.
  test('every feedback tap target is at least 44px tall once laid out', async ({ page }) => {
    await page.setContent(
      renderSessionCompletePage({
        token: '00000000-0000-0000-0000-000000000001',
        feedbackSubmitted: false,
      }),
    );
    const targets = page.locator('.feedback-option, .feedback-form button');
    const count = await targets.count();
    expect(count).toBe(11); // 2 + 2 + 3 + 3 radio pills, plus Send
    for (let i = 0; i < count; i += 1) {
      const box = await targets.nth(i).boundingBox();
      expect(box, `target ${i} should render`).not.toBeNull();
      expect(box!.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('session page — structural/DOM assertions (browser-rendered)', () => {
  test('renders a native <audio> element with the signed URL when audio is present', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData()));
    const audio = page.locator('audio');
    await expect(audio).toHaveCount(1);
    await expect(audio).toHaveAttribute('aria-label', 'Devotional audio');
    await expect(page.locator('audio source')).toHaveAttribute(
      'src',
      'https://storage.googleapis.com/kairos-audio/devotionals/example.mp3?signed=1',
    );
  });

  test('shows the AUDIO_UNAVAILABLE message and no <audio> element when audioUrl is null', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData({ audioUrl: null })));
    await expect(page.locator('audio')).toHaveCount(0);
    await expect(page.getByText('The audio is resting today')).toBeVisible();
  });

  test('shows the completed badge and no completion form when completed is true', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData({ completed: true })));
    await expect(page.locator('.completed-badge')).toBeVisible();
    await expect(page.locator('form.complete-form')).toHaveCount(0);
  });

  test('shows the completion form (with a labeled prayer-intention input) when not yet completed', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData({ completed: false })));
    const form = page.locator('form.complete-form');
    await expect(form).toBeVisible();
    const input = page.locator('#prayerIntention');
    await expect(input).toBeVisible();
    // The <label for="prayerIntention"> / <input id="prayerIntention"> pairing
    // is exactly what makes this an accessible-name match, not just visual proximity.
    await expect(page.locator('label[for="prayerIntention"]')).toBeVisible();
  });

  test('HTML-escapes untrusted devotional content — a script-tag payload never executes and renders as literal text', async ({ page }) => {
    let dialogFired = false;
    page.on('dialog', () => {
      dialogFired = true;
    });

    await page.setContent(
      renderSessionPage(
        baseData({
          devotional: {
            ...baseData().devotional,
            devotionalBody: '<script>alert("xss")</script>',
          },
        }),
      ),
    );

    expect(dialogFired).toBe(false);
    // The literal, escaped text must be visible as content — not silently dropped.
    await expect(page.getByText('alert("xss")')).toBeVisible();
    // And there must be no *actual* injected <script> element beyond Playwright's own.
    const scriptCount = await page.locator('script').count();
    expect(scriptCount).toBe(0);
  });

  test('journaling prompt and action step sections are present only when provided', async ({ page }) => {
    await page.setContent(renderSessionPage(baseData()));
    await expect(page.locator('.journaling-prompt')).toHaveCount(0);
    await expect(page.locator('.action-step')).toHaveCount(0);

    await page.setContent(
      renderSessionPage(
        baseData({
          devotional: {
            ...baseData().devotional,
            journalingPrompt: 'A prompt',
            actionStep: 'A step',
          },
        }),
      ),
    );
    await expect(page.locator('.journaling-prompt')).toBeVisible();
    await expect(page.locator('.action-step')).toBeVisible();
  });
});
