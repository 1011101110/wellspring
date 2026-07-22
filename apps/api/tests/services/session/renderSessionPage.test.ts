import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../../src/services/session/html.js';
import {
  renderGoneOrUnknownPage,
  renderSessionPage,
  type SessionPageData,
} from '../../../src/services/session/renderSessionPage.js';

describe('escapeHtml', () => {
  it('escapes all five HTML-special characters', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'quote'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;',
    );
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Come to me, all who are weary.')).toBe('Come to me, all who are weary.');
  });
});

function basePage(overrides: Partial<SessionPageData> = {}): SessionPageData {
  return {
    token: 'abc-123',
    completed: false,
    audioUrl: 'https://example.com/signed-audio.mp3',
    devotional: {
      theme: 'Rest',
      format: 'short',
      verses: [
        {
          usfm: 'MAT.11.28',
          reference: 'Matthew 11:28',
          fetchedText: 'Come to me, all you who are weary.',
          attribution: 'Berean Standard Bible',
        },
      ],
      devotionalBody: 'A short devotional body about rest.',
      prayer: 'Lord, grant me rest.',
      journalingPrompt: null,
      actionStep: null,
    },
    ...overrides,
  };
}

describe('renderSessionPage', () => {
  it('renders verse text, attribution, transcript, prayer, and a complete form', () => {
    const html = renderSessionPage(basePage());

    expect(html).toContain('Come to me, all you who are weary.');
    expect(html).toContain('Berean Standard Bible');
    expect(html).toContain('A short devotional body about rest.');
    expect(html).toContain('Lord, grant me rest.');
    expect(html).toContain('Amen &mdash; mark complete');
    expect(html).toContain('action="/session/abc-123/complete"');
    expect(html).toContain('<audio controls');
  });

  it('renders the human-readable reference as the verse heading, not the raw USFM (docs/14 §5.1)', () => {
    const html = renderSessionPage(basePage());

    expect(html).toContain('<p class="verse-ref">Matthew 11:28</p>');
    expect(html).not.toContain('MAT.11.28');
  });

  it('HTML-escapes untrusted LLM output instead of injecting it (docs/04 §5.4)', () => {
    const html = renderSessionPage(
      basePage({
        devotional: {
          theme: '<img src=x onerror=alert(1)>',
          format: 'short',
          verses: [
            {
              usfm: 'MAT.11.28',
              reference: '<b>MAT 11:28</b>',
              fetchedText: `<script>alert('pwned')</script>`,
              attribution: `Berean & "Sons" <Bible>`,
            },
          ],
          devotionalBody: '<b onmouseover=alert(2)>bold body</b>',
          prayer: `Lord's <em>prayer</em>`,
          journalingPrompt: '<svg onload=alert(3)>',
          actionStep: '<a href="javascript:alert(4)">click</a>',
        },
      }),
    );

    // None of the raw dangerous markup should appear verbatim.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<b>MAT 11:28</b>');
    expect(html).not.toContain('<b onmouseover=alert(2)>');
    expect(html).not.toContain('<svg onload=alert(3)>');
    expect(html).not.toContain('<a href="javascript:alert(4)">');

    // Escaped forms should be present instead.
    expect(html).toContain('&lt;script&gt;alert(&#39;pwned&#39;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;MAT 11:28&lt;/b&gt;');
    expect(html).toContain('Berean &amp; &quot;Sons&quot; &lt;Bible&gt;');
    expect(html).toContain('&lt;b onmouseover=alert(2)&gt;bold body&lt;/b&gt;');
    expect(html).toContain('Lord&#39;s &lt;em&gt;prayer&lt;/em&gt;');
    expect(html).toContain('&lt;svg onload=alert(3)&gt;');
    expect(html).toContain('&lt;a href=&quot;javascript:alert(4)&quot;&gt;click&lt;/a&gt;');
  });

  it('shows AUDIO_UNAVAILABLE transcript-first state when audioUrl is null', () => {
    const html = renderSessionPage(basePage({ audioUrl: null }));

    expect(html).not.toContain('<audio');
    expect(html).toContain('The audio is resting today');
    // Transcript must still be fully present.
    expect(html).toContain('A short devotional body about rest.');
  });

  it('shows a quiet "Completed" badge instead of the form when already completed', () => {
    const html = renderSessionPage(basePage({ completed: true }));

    expect(html).toContain('Completed');
    expect(html).not.toContain('action="/session/abc-123/complete"');
  });

  it('renders journalingPrompt and actionStep when present', () => {
    const html = renderSessionPage(
      basePage({
        devotional: {
          ...basePage().devotional,
          journalingPrompt: 'What is God inviting you into today?',
          actionStep: 'Send one encouraging message.',
        },
      }),
    );

    expect(html).toContain('What is God inviting you into today?');
    expect(html).toContain('Send one encouraging message.');
  });
});

describe('renderGoneOrUnknownPage', () => {
  it('renders a gentle, generic message with no token-validity semantics leaked', () => {
    const html = renderGoneOrUnknownPage();
    expect(html).toContain("This link isn't active");
    expect(html).not.toMatch(/expired|invalid|not found|unknown/i);
  });
});
