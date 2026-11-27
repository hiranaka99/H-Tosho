import { sleep } from "../lib/http.js";

export type ScanOutcome = "completed" | "timed-out" | "status-unavailable";
interface ScanClient {
  isTaskRunning(): Promise<boolean>;
}

/** A newly queued scan may remain invisible briefly; do not accept immediate idle. */
export async function waitForScan(
  client: ScanClient,
  options: {
    deadline: number;
    pollMs?: number;
    graceMs?: number;
    checkCancelled?: () => void;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }
): Promise<ScanOutcome> {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const graceUntil = now() + (options.graceMs ?? 15_000);
  const basePollMs = options.pollMs ?? 5_000;
  let observed = false;
  let pollsAfterGrace = 0;
  for (;;) {
    options.checkCancelled?.();
    if (now() >= options.deadline) return "timed-out";
    let running: boolean;
    try {
      running = await client.isTaskRunning();
    } catch {
      options.checkCancelled?.();
      return "status-unavailable";
    }
    options.checkCancelled?.();
    if (running) observed = true;
    else if (observed || now() >= graceUntil) return "completed";
    const nextPollMs =
      basePollMs >= 1000 && now() >= graceUntil
        ? Math.min(
            Math.max(basePollMs, 15_000),
            Math.round(basePollMs * Math.pow(1.5, pollsAfterGrace++))
          )
        : basePollMs;
    await wait(
      Math.min(nextPollMs, Math.max(0, options.deadline - now())),
      options.signal
    );
  }
}
