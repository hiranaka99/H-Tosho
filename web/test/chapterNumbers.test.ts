import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterErrors, chapterNumber } from '../src/lib/chapterNumbers.js';

test('optional chapters and positive decimal numbering have explicit boundaries', () => {
  for (const value of ['', ' ', '0', '-1', '1e3', 'Infinity', 'abc', '9007199254740991']) assert.equal(chapterNumber(value), null);
  assert.equal(chapterNumber(' 12.5 '), 12.5);
  assert.equal(chapterNumber('01'), 1);
  assert.deepEqual(chapterErrors([{ key: 'a', value: ' ', changed: true }]), {});
});

test('new chapters conflict with numerically equivalent existing numbers', () => {
  const errors = chapterErrors([{ key: 'old', value: '01', changed: false }, { key: 'new', value: '1.0', changed: true }]);
  assert.match(errors.new, /used more than once/);
  assert.match(errors.old, /used more than once/);
});

test('untouched legacy numbering remains usable, but new invalid edits are rejected', () => {
  assert.deepEqual(chapterErrors([{ key: 'a', value: 'Special', changed: false }, { key: 'b', value: '1', changed: false }, { key: 'c', value: '1', changed: false }]), {});
  assert.match(chapterErrors([{ key: 'a', value: 'Special', changed: true }]).a, /greater than 0/);
});

test('the same archive appearing twice is not a collision', () => {
  assert.deepEqual(chapterErrors([{ key: 'same', value: '1', changed: true }, { key: 'same', value: '1', changed: true }]), {});
});
