import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AniListClient } from "../src/providers/anilistClient.js";
import { AniListProvider } from "../src/providers/anilist.js";
import { fetchJson } from "../src/lib/http.js";
import { autoMatch } from "../src/match/autoMatcher.js";
import { getProvider } from "../src/providers/registry.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const epoch = 1_700_000_000_000;
const ok = () => Response.json({ data: { Page: { media: [] } } });
const limited = (headers?: HeadersInit, status = 429) =>
  Response.json(
    { data: null, errors: [{ status: 429, message: "Too Many Requests." }] },
    { status, headers }
  );
function fixture() {
  let now = epoch;
  const waits: number[] = [];
  const client = new AniListClient({
    now: () => now,
    wait: async (ms, signal) => {
      signal?.throwIfAborted();
      waits.push(ms);
      now += ms;
    },
  });
  return { client, waits, now: () => now };
}

test("concurrent search, metadata and artist requests share serialization and a safe default pace", async () => {
  const f = fixture(),
    starts: number[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    maximum = 0;
  globalThis.fetch = async () => {
    maximum = Math.max(maximum, ++active);
    starts.push(f.now());
    if (starts.length === 1) await first;
    active--;
    return ok();
  };
  const calls = ["search", "metadata", "artists", "works"].map((query) =>
    f.client.post({ query })
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts.length, 1);
  release();
  await Promise.all(calls);
  assert.equal(maximum, 1);
  assert.deepEqual(
    starts.map((at) => at - epoch),
    [0, 2100, 4200, 6300]
  );
});

test("429 retries the same request after the full Retry-After rather than a 15-second cap", async () => {
  const f = fixture(),
    starts: number[] = [],
    bodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    starts.push(f.now());
    bodies.push(JSON.parse(String(init?.body)));
    return starts.length === 1 ? limited({ "Retry-After": "60" }) : ok();
  };
  const body = { query: "search", variables: { search: "Sample title" } };
  assert.equal((await f.client.post(body)).status, 200);
  assert.deepEqual(bodies, [body, body]);
  assert.ok(starts[1] - starts[0] >= 60_000);
});

test("reset timestamps and HTTP-date cooldowns use the later deadline and tolerate clock skew", async () => {
  const f = fixture(),
    starts: number[] = [];
  globalThis.fetch = async () => {
    starts.push(f.now());
    return starts.length === 1
      ? limited({
          Date: new Date(epoch + 120_000).toUTCString(),
          "Retry-After": new Date(epoch + 180_000).toUTCString(),
          "X-RateLimit-Reset": String((epoch + 245_000) / 1000),
        })
      : ok();
  };
  await f.client.post({ query: "search" });
  assert.ok(starts[1] - starts[0] >= 125_000);
  assert.ok(
    f.waits.every((ms) => ms <= 60_000),
    "long waits use cancellable timer-sized chunks without shortening the cooldown"
  );
});

test("missing or invalid cooldown headers use a conservative minute and HTTP 200 GraphQL rate errors also retry", async () => {
  for (const headers of [
    undefined,
    { "Retry-After": "invalid", "X-RateLimit-Reset": "not-a-time" },
    { "Retry-After": "-1" },
    { "Retry-After": "1e308", "X-RateLimit-Reset": "1e308" },
  ]) {
    const f = fixture(),
      starts: number[] = [];
    globalThis.fetch = async () => {
      starts.push(f.now());
      return starts.length === 1 ? limited(headers, 200) : ok();
    };
    await f.client.post({ query: "search" });
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 60_000);
  }
});

test("success headers preempt the next request when quota is exhausted and lower limits slow pacing", async () => {
  const f = fixture(),
    starts: number[] = [];
  globalThis.fetch = async () => {
    starts.push(f.now());
    return starts.length === 1
      ? Response.json(
          { data: {} },
          {
            headers: {
              "X-RateLimit-Limit": "10",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String((epoch + 30_000) / 1000),
            },
          }
        )
      : ok();
  };
  await Promise.all([
    f.client.post({ query: "first" }),
    f.client.post({ query: "second" }),
    f.client.post({ query: "third" }),
  ]);
  assert.ok(starts[1] - starts[0] >= 30_000);
  assert.ok(starts[2] - starts[1] >= 6100);
});

test("retries are bounded and a following request still honors the final cooldown", async () => {
  const f = fixture(),
    starts: number[] = [];
  globalThis.fetch = async () => {
    starts.push(f.now());
    return limited({ "Retry-After": "60" });
  };
  assert.equal((await f.client.post({ query: "first" })).status, 429);
  assert.equal(starts.length, 4);
  globalThis.fetch = async () => {
    starts.push(f.now());
    return ok();
  };
  await f.client.post({ query: "next gallery" });
  assert.ok(starts[4] - starts[3] >= 60_000);
});

test("permanent HTTP and GraphQL failures are returned once; transient failures and network errors can recover", async () => {
  for (const status of [400, 401, 403, 404, 200]) {
    const f = fixture();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json(
        { errors: [{ status: 400, message: "Invalid query" }] },
        { status }
      );
    };
    assert.equal((await f.client.post({ query: "invalid" })).status, status);
    assert.equal(calls, 1);
  }
  const f = fixture();
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new Error("Network unavailable");
    return calls === 2 ? new Response("Unavailable", { status: 503 }) : ok();
  };
  assert.equal((await f.client.post({ query: "search" })).status, 200);
  assert.equal(calls, 3);
});

test("cancelling during a cooldown stops retries immediately and leaves the shared cooldown in place", async () => {
  let now = epoch,
    calls = 0;
  const controller = new AbortController(),
    reason = new Error("Cancelled");
  const client = new AniListClient({
    now: () => now,
    wait: async (ms, signal) => {
      if (signal) {
        controller.abort(reason);
        signal.throwIfAborted();
      }
      now += ms;
    },
  });
  globalThis.fetch = async () => {
    calls++;
    return limited({ "Retry-After": "60" });
  };
  await assert.rejects(
    client.post({ query: "cancel me" }, controller.signal),
    (error) => error === reason
  );
  assert.equal(calls, 1);
  globalThis.fetch = async () => {
    calls++;
    return ok();
  };
  await client.post({ query: "next request" });
  assert.ok(now - epoch >= 60_000);
});

test("cancelling a queued caller returns promptly without bypassing or poisoning the queue", async () => {
  const f = fixture();
  let calls = 0,
    release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    if (++calls === 1) await pending;
    return ok();
  };
  const first = f.client.post({ query: "first" });
  const controller = new AbortController(),
    reason = new Error("Cancelled queued request");
  const queued = f.client.post({ query: "cancelled" }, controller.signal);
  const next = f.client.post({ query: "next" });
  controller.abort(reason);
  await assert.rejects(queued, (error) => error === reason);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, next]);
  assert.equal(calls, 2);
});

test("the HTTP helper preserves caller cancellation during an in-flight request", async () => {
  const controller = new AbortController(),
    reason = new Error("Cancelled fetch");
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () =>
          reject(
            init!.signal!.reason instanceof Error
              ? init!.signal!.reason
              : new Error("aborted")
          ),
        { once: true }
      );
    });
  const request = fetchJson("https://example.test", {
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(request, (error) => error === reason);
});

test("a recovered rate limit returns matching candidates without recording a provider error", async () => {
  const f = fixture();
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? limited({ "Retry-After": "60" })
      : Response.json({
          data: {
            Page: {
              media: [
                { id: 42, title: { romaji: "Sample title" }, format: "MANGA" },
              ],
            },
          },
        });
  const provider = getProvider("anilist")!,
    originalSearch = provider.search;
  const actual = new AniListProvider(f.client);
  provider.search = actual.search.bind(actual);
  try {
    const result = await autoMatch(
      { id: 1, name: "Sample title" },
      {
        providerOrder: ["anilist"],
        enabledProviders: ["anilist"],
        credentials: {},
        searchAll: true,
      }
    );
    assert.equal(result.best?.providerSeriesId, "42");
    assert.deepEqual(result.errors, {});
  } finally {
    provider.search = originalSearch;
  }
});

test("match cancellation during rate-limit recovery propagates instead of becoming a provider warning", async () => {
  const controller = new AbortController(),
    reason = new Error("Job cancelled");
  const client = new AniListClient({
    now: () => epoch,
    wait: async (_ms, signal) => {
      controller.abort(reason);
      signal?.throwIfAborted();
    },
  });
  globalThis.fetch = async () => limited({ "Retry-After": "60" });
  const provider = getProvider("anilist")!,
    originalSearch = provider.search;
  const actual = new AniListProvider(client);
  provider.search = actual.search.bind(actual);
  try {
    await assert.rejects(
      autoMatch(
        { id: 1, name: "Sample title" },
        {
          providerOrder: ["anilist"],
          enabledProviders: ["anilist"],
          credentials: {},
          signal: controller.signal,
        }
      ),
      (error) => error === reason
    );
  } finally {
    provider.search = originalSearch;
  }
});
