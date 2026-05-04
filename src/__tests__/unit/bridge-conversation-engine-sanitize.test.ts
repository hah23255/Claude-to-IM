/**
 * Unit tests for sanitizeModelName.
 *
 * Prevents recurrence of the data-corruption issue where the Claude Code
 * CLI's reported model name (e.g. "claude-opus-4-7[1m]" for the 1M-context
 * tier) was being persisted verbatim, then passed back as a `--model` arg
 * on the next turn, where the CLI rejected it as unknown.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelName } from '../../lib/bridge/conversation-engine';

describe('sanitizeModelName', () => {
  it('strips the [1m] context-tier suffix from Claude model names', () => {
    assert.equal(sanitizeModelName('claude-opus-4-7[1m]'), 'claude-opus-4-7');
    assert.equal(sanitizeModelName('claude-opus-4-6[1m]'), 'claude-opus-4-6');
    assert.equal(sanitizeModelName('claude-sonnet-4-7[1m]'), 'claude-sonnet-4-7');
  });

  it('strips arbitrary bracketed metadata suffixes (provider-agnostic)', () => {
    assert.equal(sanitizeModelName('gpt-4o[2024-08-06]'), 'gpt-4o');
    assert.equal(sanitizeModelName('deepseek-chat[v3]'), 'deepseek-chat');
  });

  it('leaves clean model names untouched', () => {
    assert.equal(sanitizeModelName('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.equal(sanitizeModelName('claude-opus-4-7'), 'claude-opus-4-7');
    assert.equal(sanitizeModelName('gpt-4o'), 'gpt-4o');
    assert.equal(sanitizeModelName(''), '');
  });

  it('only strips a trailing bracket pair, not embedded ones', () => {
    // Embedded brackets (unlikely in practice) are preserved; only the
    // trailing-suffix form is metadata.
    assert.equal(sanitizeModelName('weird[middle]name'), 'weird[middle]name');
    assert.equal(sanitizeModelName('weird[middle]name[suffix]'), 'weird[middle]name');
  });

  it('trims trailing whitespace introduced by the strip', () => {
    assert.equal(sanitizeModelName('claude-opus-4-7 [1m]'), 'claude-opus-4-7');
    assert.equal(sanitizeModelName('claude-opus-4-7[1m]   '), 'claude-opus-4-7');
  });

  it('safely returns non-string input as-is (defensive)', () => {
    // The SSE handler caller already null-checks, but we defend against
    // surprises (e.g. CLI emitting a number).
    // @ts-expect-error — testing runtime defensive path
    assert.equal(sanitizeModelName(null), null);
    // @ts-expect-error — testing runtime defensive path
    assert.equal(sanitizeModelName(undefined), undefined);
  });
});
