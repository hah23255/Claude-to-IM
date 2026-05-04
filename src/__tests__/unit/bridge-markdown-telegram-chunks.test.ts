/**
 * Regression test for the "single-letter Telegram message" bug.
 *
 * Symptom: messages from the bridge to Telegram arrived fragmented into many
 * tiny messages, sometimes one character per message.
 *
 * Root cause: `splitTelegramChunkByHtmlLimit` computed `proportionalLimit`
 * by dividing text-length × HTML-limit ÷ rendered-HTML-length. When markdown
 * rendered to a much larger HTML payload than its source (e.g., heavy
 * formatting, many HTML escapes, or nested inline styles), that ratio
 * drove the split limit toward zero. The recursive splitter then produced
 * 1-character `MarkdownIR` chunks, each becoming its own `TelegramChunk`
 * and thus its own Telegram message.
 *
 * Fix: enforce `MIN_CHUNK_TEXT_LENGTH` (256) as a floor everywhere the
 * splitter decides on a chunk size.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToTelegramChunks,
  MIN_CHUNK_TEXT_LENGTH,
} from '../../lib/bridge/markdown/telegram';

describe('markdownToTelegramChunks — chunk size floor', () => {
  it('exports a sensible MIN_CHUNK_TEXT_LENGTH', () => {
    assert.ok(MIN_CHUNK_TEXT_LENGTH >= 100, 'floor too low — would still allow tiny chunks');
    assert.ok(MIN_CHUNK_TEXT_LENGTH <= 1024, 'floor too high — would prevent legitimate splits');
  });

  it('never produces a chunk shorter than MIN_CHUNK_TEXT_LENGTH (when a split happens at all)', () => {
    // Construct markdown that renders to disproportionately large HTML:
    // every character wrapped in nested bold + italic, with HTML-escape
    // characters salted in to expand each "a" into roughly 30+ HTML chars.
    const noisy = Array.from({ length: 4000 }, () => '***<&>***').join('');
    const chunks = markdownToTelegramChunks(noisy, 4096);

    // Either the whole text fits in one chunk, or every chunk is large
    // enough that no Telegram user would call it "broken into one letter".
    if (chunks.length > 1) {
      for (const c of chunks) {
        assert.ok(
          c.text.length >= MIN_CHUNK_TEXT_LENGTH,
          `chunk text was ${c.text.length} chars (< ${MIN_CHUNK_TEXT_LENGTH}); ` +
            `splitter regressed to producing tiny chunks`,
        );
      }
    }
  });

  it('does not produce single-character chunks for any pathological mix', () => {
    // Three different inputs that historically triggered runaway splitting:
    // 1. Heavy code-fence content with many escape characters.
    // 2. Deeply nested inline formatting with links.
    // 3. Pure HTML-escape soup (each char must escape).
    const inputs = [
      '```\n' + '<script>alert("x")</script>'.repeat(300) + '\n```',
      '**[' + '_text_'.repeat(500) + '](https://example.com/very/long/path)**',
      '&lt;'.repeat(2000),
    ];

    for (const input of inputs) {
      const chunks = markdownToTelegramChunks(input, 4096);
      const tinies = chunks.filter((c) => c.text.length < 32);
      assert.equal(
        tinies.length,
        0,
        `chunker produced ${tinies.length} chunks of <32 chars on input: ` +
          `"${input.slice(0, 50)}…" (${input.length} chars total). ` +
          `These would render as fragmented Telegram messages.`,
      );
    }
  });

  it('still chunks correctly for normal long-form content', () => {
    // Sanity: a long but plain markdown document should still get split
    // into multiple reasonably-sized chunks (not just held as one giant chunk).
    const para = 'This is a normal paragraph of text. '.repeat(50);
    const longDoc = Array.from({ length: 30 }, (_, i) => `## Heading ${i}\n\n${para}`).join('\n\n');
    const chunks = markdownToTelegramChunks(longDoc, 4096);

    assert.ok(chunks.length >= 2, `expected at least 2 chunks, got ${chunks.length}`);
    for (const c of chunks) {
      assert.ok(
        c.html.length <= 4096 || c.text.length <= MIN_CHUNK_TEXT_LENGTH,
        `chunk html was ${c.html.length} chars; either should fit limit ` +
          `or be at the floor (${MIN_CHUNK_TEXT_LENGTH})`,
      );
    }
  });
});
