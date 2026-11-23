/**
 * Bounded, abort-aware request gate for the E-Hentai family hosts.
 *
 * E-Hentai documents at most one search request per ~3 seconds and enforces
 * image-view quotas (HTTP 509 when exhausted). This gate makes those limits
 * structural for every workflow that touches the family hosts (settings
 * access tests, search, metadata, page resolution, previews, downloads):
 *
 * - requests on a lane start at least `minGapMs` apart, even when many
 *   callers race;
 * - at most `maxConcurrent` requests are in flight per lane;
 * - `setCooldown` pushes out every future start (Retry-After, quota, bans);
 * - an AbortSignal rejects the wait and releases nothing — queued work is
 *   cancelled, never parked forever, and pacing slots already reserved are
 *  not "reused" (conservative: a cancelled request still costs pacing).
 *
 * User settings may lower load (fewer concurrent images, larger delay) but
 * may not bypass a lane's floor: callers combine their own limits with the
 * gate's, taking the stricter of the two.
 */

export class RequestAbortedError extends Error {
  constructor() {
    // Deliberately not matched by the transient-error patterns in
    // requests.ts: an abort is an intentional stop, not a network blip.
    super('Request cancelled');
    this.name = 'AbortError';
  }
}

export interface GateLane {
  /** Minimum pacing gap between consecutive starts on this lane (ms). */
  readonly minGapMs: number;
  /**
   * Wait for permission to start one request on this lane. Resolves with a
   * release function that MUST be called exactly once when the request
   * completes (success, failure, or abort after the start).
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Defer every future start until `untilMs` (epoch ms). */
  setCooldown(untilMs: number): void;
  /** Milliseconds remaining on the current cooldown (0 when none). */
  cooldownRemainingMs(): number;
}

const abortError = (): Error => new RequestAbortedError();

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface SlotWaiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

interface HeadWaiter {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function createLane(minGapMs: number, maxConcurrent: number): GateLane {
  const queue: HeadWaiter[] = [];
  const slotWaiters: SlotWaiter[] = [];
  let active = 0;
  let lastStartAt = 0;
  let cooldownUntil = 0;
  let scheduling = false;

  function wakeSlotWaiters(): void {
    for (;;) {
      const head = slotWaiters[0];
      if (!head) return;
      if (head.signal?.aborted) {
        slotWaiters.shift();
        try {
          head.signal?.removeEventListener('abort', head.onAbort);
        } catch { /* already detached */ }
        head.reject(abortError());
        continue;
      }
      slotWaiters.shift();
      head.resolve();
      return;
    }
  }

  function releaseSlot(): void {
    active--;
    wakeSlotWaiters();
  }

  function waitForSlot(signal?: AbortSignal): Promise<void> {
    if (active < maxConcurrent) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      const entry: SlotWaiter = {
        signal,
        resolve: (): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error: Error): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        onAbort,
      };
      slotWaiters.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function pump(): void {
    if (scheduling) return;
    scheduling = true;
    void (async () => {
      try {
        for (;;) {
          let head = queue[0];
          while (head && head.signal?.aborted) {
            queue.shift();
            // The settlement closure owns the settled flag; a pre-assignment
            // here would make the closure no-op and strand the promise.
            if (!head.settled) head.reject(abortError());
            head = queue[0];
          }
          if (!head) break;

          // Pacing: the head may start no earlier than minGap after the last
          // start and never during a cooldown.
          let now = Date.now();
          let earliest = Math.max(now, lastStartAt + minGapMs, cooldownUntil);
          if (earliest > now) {
            await abortableSleep(earliest - now, head.signal);
            if (head.signal?.aborted) {
              queue.shift();
              if (!head.settled) head.reject(abortError());
              continue;
            }
          }

          // Concurrency: park until a lane slot is free.
          if (active >= maxConcurrent) {
            await waitForSlot(head.signal);
            if (head.signal?.aborted) {
              queue.shift();
              if (!head.settled) head.reject(abortError());
              continue;
            }
            // Time may have passed while waiting for the slot; re-check pacing
            // so the gap guarantee holds against other lane activity.
            now = Date.now();
            earliest = Math.max(now, lastStartAt + minGapMs, cooldownUntil);
            if (earliest > now) {
              await abortableSleep(earliest - now, head.signal);
              if (head.signal?.aborted) {
                queue.shift();
                if (!head.settled) head.reject(abortError());
                continue;
              }
            }
          }

          queue.shift();
          active++;
          lastStartAt = Date.now();
          if (!head.settled) head.resolve(releaseSlot);
        }
      } catch {
        // Expected: a parked head's abort rejected the pacing/slot wait. The
        // re-pump below settles the head; this IIFE's own promise must not
        // surface as an unhandled rejection.
      } finally {
        scheduling = false;
        // A slot release may have queued a start while the loop was idle.
        if (queue.length > 0) pump();
      }
    })();
  }

  return {
    minGapMs,
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(abortError());
      const waiter: HeadWaiter = { signal, settled: false, resolve: () => undefined, reject: () => undefined };
      // The executor runs synchronously, so settlement functions are bound
      // before the pump can observe the waiter.
      const promise = new Promise<() => void>((resolve, reject) => {
        waiter.resolve = (release) => {
          if (waiter.settled) return;
          waiter.settled = true;
          resolve(release);
        };
        waiter.reject = (error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          reject(error);
        };
      });
      queue.push(waiter);
      pump();
      return promise;
    },
    setCooldown(untilMs: number): void {
      if (Number.isFinite(untilMs) && untilMs > cooldownUntil) cooldownUntil = untilMs;
    },
    cooldownRemainingMs(): number {
      return Math.max(0, cooldownUntil - Date.now());
    },
  };
}

export interface EhentaiGate {
  /** Search/gallery HTML and page-resolution requests on the family hosts. */
  html: GateLane;
  /** api.e-hentai.org metadata requests (batched gdata). */
  api: GateLane;
  /** Viewer image byte transfers across all active family downloads. */
  image: GateLane;
}

/** Defaults per the documented limits: >=3s between HTML/API request starts,
 *  one concurrent HTML resolution, and image starts at least 3s apart with at
 *  most two in flight (a sustainable rate under the default 250-images/10min
 *  quota even when several galleries download concurrently). */
export const EHENTAI_GATE_DEFAULTS = {
  html: { minGapMs: 3000, maxConcurrent: 1 },
  api: { minGapMs: 3000, maxConcurrent: 1 },
  image: { minGapMs: 3000, maxConcurrent: 2 },
} as const;

export interface LaneConfig {
  minGapMs: number;
  maxConcurrent: number;
}

let gate: EhentaiGate | null = null;
let laneOverride: { html?: LaneConfig; api?: LaneConfig; image?: LaneConfig } | null = null;

/** The shared gate across every E-Hentai-family workflow in this process. */
export function getEhentaiGate(): EhentaiGate {
  if (!gate) {
    const html = laneOverride?.html ?? EHENTAI_GATE_DEFAULTS.html;
    const api = laneOverride?.api ?? EHENTAI_GATE_DEFAULTS.api;
    const image = laneOverride?.image ?? EHENTAI_GATE_DEFAULTS.image;
    gate = {
      html: createLane(html.minGapMs, html.maxConcurrent),
      api: createLane(api.minGapMs, api.maxConcurrent),
      image: createLane(image.minGapMs, image.maxConcurrent),
    };
  }
  return gate;
}

/** Replace the shared gate (tests). Drops all pacing/cooldown state.
 *  `override` temporarily narrows per-lane pacing for fast tests; omitted
 *  lanes keep the production defaults. */
export function resetEhentaiGate(override?: { html?: LaneConfig; api?: LaneConfig; image?: LaneConfig }): void {
  gate = null;
  laneOverride = override ?? null;
}
