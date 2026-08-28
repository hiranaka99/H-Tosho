import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-jobs-retry-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { jobQueue } = await import('../src/jobs/queue.js');
const { api } = await import('../src/routes/api.js');

initDb();

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

/** Wait until the job row reports the wanted status (pump is async). */
async function waitForStatus(id: number, status: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = jobQueue.get(id);
    if (job?.status === status) return;
    if (Date.now() > deadline) throw new Error(`Job ${id} did not reach ${status} (now ${job?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('retryJob copies a failed job into a NEW queued job with the same payload', async () => {
  let attempts = 0;
  jobQueue.registerHandler(async (job) => {
    // Fail once (the original), succeed on the retry.
    if (attempts++ === 0) throw new Error('intentional failure');
    return { echoed: job.payload.libraryId };
  });

  const originalId = jobQueue.enqueue('scan-new', { libraryId: 42 });
  await waitForStatus(originalId, 'failed');
  const original = jobQueue.get(originalId)!;
  assert.equal(original.status, 'failed');

  const newId = jobQueue.retryJob(originalId);
  assert.ok(newId !== null);
  assert.notEqual(newId, originalId);

  const retried = jobQueue.get(newId!)!;
  assert.equal(retried.type, 'scan-new');
  assert.deepEqual(retried.payload, { libraryId: 42 });
  // The original stays as history (still failed, untouched).
  assert.equal(jobQueue.get(originalId)!.status, 'failed');

  // The retry actually runs and completes through the normal pump.
  await waitForStatus(newId!, 'completed');
  assert.equal(jobQueue.get(newId!)!.result && (jobQueue.get(newId!)!.result as { echoed?: number }).echoed, 42);
});

test('retryJob rejects missing and non-failed jobs', async () => {
  assert.equal(jobQueue.retryJob(999_999), null, 'missing job');

  // Static rows are never pumped, so statuses stay exactly as inserted.
  const insert = (status: string, payload: Record<string, unknown>): number => {
    const res = getDb()
      .insert(schema.jobs)
      .values({ type: 'match-library', payloadJson: JSON.stringify(payload), status, libraryId: 7 })
      .run();
    return Number(res.lastInsertRowid);
  };
  const runningId = insert('running', { libraryId: 7 });
  const completedId = insert('completed', { libraryId: 7 });
  const cancelledId = insert('cancelled', { libraryId: 7 });
  assert.equal(jobQueue.retryJob(runningId), null, 'running job');
  assert.equal(jobQueue.retryJob(completedId), null, 'completed job');
  assert.equal(jobQueue.retryJob(cancelledId), null, 'cancelled job');
});

test('POST /api/jobs/:id/retry returns the new id; non-retryable gets 409', async () => {
  let attempts = 0;
  jobQueue.registerHandler(async () => {
    if (attempts++ === 0) throw new Error('boom');
    return {};
  });
  const failedId = jobQueue.enqueue('match-unmatched', {});
  await waitForStatus(failedId, 'failed');

  const res = await api.request(`/jobs/${failedId}/retry`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; id: number };
  assert.equal(body.ok, true);
  assert.ok(body.id > failedId);
  const retried = jobQueue.get(body.id)!;
  assert.equal(retried.type, 'match-unmatched');
  await waitForStatus(body.id, 'completed');

  const missing = await api.request('/jobs/999999/retry', { method: 'POST' });
  assert.equal(missing.status, 409);

  const bad = await api.request('/jobs/not-a-number/retry', { method: 'POST' });
  assert.equal(bad.status, 400);
});
