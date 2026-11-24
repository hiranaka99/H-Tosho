import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTaskUpdates, isProgressOnlyUpdate, mergeDownloadSnapshot } from '../src/lib/downloadEventBuffer.js';
import type { DownloadTask } from '../src/lib/api.js';

const task = (overrides: Partial<DownloadTask> = {}) => ({
  id: 1, attempt: 1, revision: 1, status: 'downloading', phase: 'downloading', state: { type: 'downloading' },
  progressCurrent: 1, progressTotal: 10, bytesCurrent: 100, bytesTotal: 1000, speed: 5, currentFile: '1.webp',
  errorMessage: null, retryAt: null, title: 'A', ...overrides,
}) as DownloadTask;

test('byte/page ticks are progress-only; status, phase and state changes are not', () => {
  const base = task();
  assert.equal(isProgressOnlyUpdate(base, task({ revision: 2, progressCurrent: 2, bytesCurrent: 200, speed: 9, currentFile: '2.webp' })), true);
  assert.equal(isProgressOnlyUpdate(base, task({ revision: 2, state: { type: 'downloading' } })), true);
  assert.equal(isProgressOnlyUpdate(base, task({ revision: 2, status: 'paused', state: { type: 'paused' } })), false);
  assert.equal(isProgressOnlyUpdate(base, task({ revision: 2, phase: 'packing', state: { type: 'packing' } })), false);
  assert.equal(isProgressOnlyUpdate(base, task({ revision: 2, errorMessage: 'boom' })), false);
  assert.equal(isProgressOnlyUpdate(undefined, base), false, 'a task the cache has never seen flushes immediately');
});

test('applyTaskUpdates skips stale frames entirely and copies only on real changes', () => {
  const current = task({ revision: 5 });
  const list = [current, task({ id: 2 })];
  assert.equal(applyTaskUpdates(list, [task({ revision: 4 })]), undefined, 'stale revision is a no-op');
  const fresh = task({ revision: 6, progressCurrent: 3 });
  const next = applyTaskUpdates(list, [fresh]);
  assert.ok(next && next !== list);
  assert.equal(next[0], fresh);
  assert.equal(next[1], list[1]);
  assert.equal(list[0], current, 'the cached list is never mutated');
  const added = applyTaskUpdates(list, [task({ id: 3 })]);
  assert.deepEqual(added?.map((t) => t.id), [3, 1, 2]);
});

test('mergeDownloadSnapshot keeps the cached list identity when nothing changed', () => {
  const list = [task({ revision: 5 }), task({ id: 2 })];
  assert.equal(mergeDownloadSnapshot(list, [task({ revision: 5 }), task({ id: 2, revision: 1 })].map((t, i) => (i === 0 ? list[0] : t))), list);
  assert.equal(mergeDownloadSnapshot(list, [task({ revision: 4 }), task({ id: 2, revision: 0 })]), list, 'older snapshot rows keep the newer cached ones');
  const removed = mergeDownloadSnapshot(list, [list[0]]);
  assert.notEqual(removed, list);
  assert.equal(removed.length, 1);
});
