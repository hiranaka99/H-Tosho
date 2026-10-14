import { sleep } from '../lib/http.js';

export type ScanOutcome = 'completed' | 'timed-out' | 'status-unavailable';
interface ScanClient { isTaskRunning(): Promise<boolean> }

/** A newly queued scan may remain invisible briefly; do not accept immediate idle. */
export async function waitForScan(client: ScanClient, options: {
  deadline: number;
  pollMs?: number;
  graceMs?: number;
  checkCancelled?: () => void;
}): Promise<ScanOutcome> {
  const graceUntil = Date.now() + (options.graceMs ?? 15_000);
  let observed = false;
  for (;;) {
    options.checkCancelled?.();
    if (Date.now() >= options.deadline) return 'timed-out';
    let running: boolean;
    try { running = await client.isTaskRunning(); }
    catch { options.checkCancelled?.(); return 'status-unavailable'; }
    options.checkCancelled?.();
    if (running) observed = true;
    else if (observed || Date.now() >= graceUntil) return 'completed';
    await sleep(Math.min(options.pollMs ?? 5_000, Math.max(0, options.deadline - Date.now())));
  }
}
