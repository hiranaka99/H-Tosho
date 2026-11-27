import { fetchJson, sleep, type HttpResponse } from "../lib/http.js";

export const ANILIST_API_URL = "https://graphql.anilist.co";
// Keep below AniList's documented degraded 30/minute limit, including burst spacing.
const MIN_INTERVAL_MS = 2_100;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 4;

/** One queue covers searches, metadata, artist browsing and every retry. */
export class AniListClient {
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  private cooldownUntil = 0;
  private intervalMs = MIN_INTERVAL_MS;
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    timing: {
      now?: () => number;
      wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {}
  ) {
    this.now = timing.now ?? (() => Date.now());
    this.wait = timing.wait ?? sleep;
  }

  async post<T>(body: unknown, signal?: AbortSignal): Promise<HttpResponse<T>> {
    signal?.throwIfAborted();
    const run = this.tail.then(() => this.perform<T>(body, signal));
    this.tail = run.then(
      () => {},
      () => {}
    );
    if (!signal) return run;
    // A cancelled queued caller can leave immediately. Its reserved turn stays
    // in the chain and skips the request, so later callers cannot bypass pacing.
    return new Promise((resolve, reject) => {
      const abort = () => {
        const reason: unknown = signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(
                typeof reason === "string" && reason ? reason : "Aborted"
              )
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      void run.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
      if (signal.aborted) abort();
    });
  }

  private cooldown(headers: Headers | undefined): number {
    const delays: number[] = [];
    const serverDate = Date.parse(headers?.get("date") ?? "");
    const base = Number.isFinite(serverDate) ? serverDate : this.now();
    const retry = headers?.get("retry-after")?.trim();
    if (retry) {
      const seconds = Number(retry);
      if (Number.isFinite(seconds)) {
        if (seconds >= 0 && Number.isFinite(seconds * 1_000))
          delays.push(seconds * 1_000);
      } else {
        const date = Date.parse(retry);
        if (Number.isFinite(date)) delays.push(Math.max(0, date - base));
      }
    }
    const reset = headers?.get("x-ratelimit-reset")?.trim();
    const seconds = reset ? Number(reset) : NaN;
    if (
      Number.isFinite(seconds) &&
      seconds > 0 &&
      Number.isFinite(seconds * 1_000)
    )
      delays.push(Math.max(0, seconds * 1_000 - base));
    // No 15-second cap: retrying before AniList's reset prolongs its timeout.
    return (delays.length ? Math.max(...delays) : DEFAULT_COOLDOWN_MS) + 250;
  }

  private async perform<T>(
    body: unknown,
    signal?: AbortSignal
  ): Promise<HttpResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let delay: number;
      while (
        (delay = Math.max(this.nextAt, this.cooldownUntil) - this.now()) > 0
      ) {
        await this.wait(Math.min(delay, 60_000), signal);
      }
      signal?.throwIfAborted();
      const startedAt = this.now();
      this.nextAt = startedAt + this.intervalMs;
      let response: HttpResponse<T>;
      try {
        response = await fetchJson<T>(
          ANILIST_API_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          },
          15_000,
          { raw: true }
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt + 1 >= MAX_ATTEMPTS) throw error;
        await this.wait(Math.min(500 * 2 ** attempt, 4_000), signal);
        continue;
      }
      const limit = Number(response.headers?.get("x-ratelimit-limit"));
      if (Number.isFinite(limit) && limit > 0)
        this.intervalMs = Math.max(
          MIN_INTERVAL_MS,
          Math.ceil(60_000 / limit) + 100
        );
      this.nextAt = Math.max(this.nextAt, startedAt + this.intervalMs);
      const errors = (
        response.data as {
          errors?: { status?: number; message?: string }[];
        } | null
      )?.errors;
      const limited =
        response.status === 429 ||
        (Array.isArray(errors) &&
          errors.some(
            (error) =>
              error.status === 429 ||
              /too many requests/i.test(error.message ?? "")
          ));
      if (
        limited ||
        response.headers?.get("x-ratelimit-remaining")?.trim() === "0"
      ) {
        this.cooldownUntil = Math.max(
          this.cooldownUntil,
          this.now() + this.cooldown(response.headers)
        );
      }
      if (attempt + 1 < MAX_ATTEMPTS) {
        if (limited) continue;
        if ([502, 503, 504].includes(response.status)) {
          await this.wait(Math.min(500 * 2 ** attempt, 4_000), signal);
          continue;
        }
      }
      return response;
    }
  }
}

export const anilistClient = new AniListClient();
