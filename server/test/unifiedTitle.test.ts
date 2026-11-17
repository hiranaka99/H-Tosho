import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unifiedTitleKey } from '../src/services/unifiedTitle.js';

const key = (title: string) => unifiedTitleKey(title, ['Sample Artist'], 'english');

test('catalogue prefixes match within the same censorship edition', () => {
  const expected = key('Sample Story 2 [Uncensored]');
  for (const title of [
    '[Sample Artist] Sample Story 2 [English] [Uncensored]',
    '(C103) [Sample Artist] Sample Story 2 [Digital] [Decensored]',
    'Sample Story 2 - Uncensored Version',
    'Sample Story 2 【Decensored】', 'Sample Story 2 [De-censored by Sample Group]',
  ]) assert.equal(key(title), expected, title);
  assert.equal(key('Ｓａｍｐｌｅ Story 2 [English Translation]'), key('Sample Story 2'));
  assert.equal(key('[Sample Artist] Sample Story 2 (Censored)'), key('Sample Story 2 [Censored]'));
});

test('unmarked, censored, and uncensored or decensored editions cannot mix', () => {
  const unmarked = key('Sample Story 2');
  const censored = key('Sample Story 2 [Censored]');
  const uncensored = key('Sample Story 2 [Uncensored]');
  const decensored = key('Sample Story 2 [Decensored]');
  assert.notEqual(unmarked, censored);
  assert.notEqual(unmarked, uncensored);
  assert.notEqual(unmarked, decensored);
  assert.notEqual(censored, uncensored);
  assert.notEqual(censored, decensored);
  assert.equal(uncensored, decensored);
  assert.notEqual(key('Sample Story 2 [Censored] [Uncensored]'), uncensored);
  assert.notEqual(key('Sample Story 2 [Censored] [Uncensored]'), censored);
});

test('meaningful titles, chapters, and other editions are preserved', () => {
  for (const title of [
    'Sample Story 3', 'Sample Story 2 [Chapter 1]', 'Sample Story 2 [Full Color]',
    'Sample Story 2 [Rewrite]', 'Sample Story 2 [Translator A]', '[Different Artist] Sample Story 2',
    'Sample Story 2 [French]', 'Uncensored Sample Story 2',
  ]) assert.notEqual(key(title), key('Sample Story 2'), title);
  assert.notEqual(key('Café'), key('Caf'));
  assert.equal(key('[Uncensored] [English]'), '', 'annotation-only titles cannot identify a work');
});
