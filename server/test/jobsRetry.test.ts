import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';

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

function historyJob(status: string, result?: unknown): number {
  const row = getDb().insert(schema.jobs).values({
    type: 'scan-new', status, resultJson: result === undefined ? null : JSON.stringify(result),
  }).run();
  const id = Number(row.lastInsertRowid);
  jobQueue.log(id, 'info', `History for ${status}`);
  return id;
}

test('DELETE /jobs/:id removes only a failed job and its logs', async () => {
  const failed = historyJob('failed');
  const retained = historyJob('completed');
  const response = await api.request(`/jobs/${failed}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 1 });
  assert.equal(jobQueue.get(failed), null);
  assert.deepEqual(jobQueue.logs(failed), []);
  assert.ok(jobQueue.get(retained));
  assert.equal(jobQueue.logs(retained).length, 1);
  assert.equal((await api.request(`/jobs/${failed}`, { method: 'DELETE' })).status, 404);
  for (const id of ['bad', '0', '-1', '1.5', '9007199254740992']) {
    assert.equal((await api.request(`/jobs/${id}`, { method: 'DELETE' })).status, 400);
  }
});

test('failed-job clearing rejects queued, running, completed, warning, and cancelled rows', async () => {
  for (const status of ['queued', 'running', 'completed', 'cancelled']) {
    const id = historyJob(status, { warnings: ['Keep this warning'] });
    assert.equal(jobQueue.clearFailed(id), 0);
    assert.equal((await api.request(`/jobs/${id}`, { method: 'DELETE' })).status, 409);
    assert.equal(jobQueue.get(id)?.status, status);
    assert.equal(jobQueue.logs(id).length, 1);
  }
});

test('bulk clearing includes failed jobs beyond loaded history and preserves other statuses', async () => {
  const oldFailure = historyJob('failed');
  const completed = Array.from({ length: 105 }, () => historyJob('completed'));
  assert.equal(jobQueue.list(100).some((job) => job.id === oldFailure), false);
  const db = getDb();
  const failedIds = db.select().from(schema.jobs).all().filter((job) => job.status === 'failed').map((job) => job.id);
  const keptJobs = db.select().from(schema.jobs).all().filter((job) => job.status !== 'failed');
  const keptLogs = db.select().from(schema.jobLogs).all().filter((log) => !failedIds.includes(log.jobId));
  const response = await api.request('/jobs/failed', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: failedIds.length });
  assert.deepEqual(db.select().from(schema.jobs).all(), keptJobs);
  assert.deepEqual(db.select().from(schema.jobLogs).all(), keptLogs);
  for (const id of completed) assert.equal(jobQueue.get(id)?.status, 'completed');
  assert.deepEqual(await (await api.request('/jobs/failed', { method: 'DELETE' })).json(), { removed: 0 });
});

test('failed-job clearing rolls log removal back if history deletion fails', () => {
  const id = historyJob('failed');
  const db = getDb();
  db.run(sql`CREATE TRIGGER reject_job_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
  try {
    assert.throws(() => jobQueue.clearFailed(id), /test rollback/);
    assert.equal(jobQueue.get(id)?.status, 'failed');
    assert.equal(jobQueue.logs(id).length, 1);
  } finally {
    db.run(sql`DROP TRIGGER reject_job_delete`);
  }
});

test('clearing job history requires authentication', async () => {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  for (const route of ['/api/jobs/failed', '/api/jobs/1']) {
    assert.equal((await app.request(route, { method: 'DELETE' })).status, 403, 'setup is required');
  }
  const setup = await app.request('/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
  });
  assert.equal(setup.status, 201);
  for (const route of ['/api/jobs/failed', '/api/jobs/1']) {
    assert.equal((await app.request(route, { method: 'DELETE' })).status, 401);
  }
});
