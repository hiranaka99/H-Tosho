import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTransientError,
  retryTransient,
} from "../src/downloader/requests.js";

test("isTransientError classifies CDN and network errors as retryable", () => {
  assert.ok(isTransientError(new Error("Download failed: HTTP 503")));
  assert.ok(isTransientError(new Error("Download failed: HTTP 502")));
  assert.ok(isTransientError(new Error("Download failed: HTTP 429")));
  assert.ok(isTransientError(new Error("fetch failed")));
  assert.ok(isTransientError(new Error("socket hang up")));
  assert.ok(isTransientError(new Error("Request timeout after 30s")));
});

test("isTransientError rejects permanent and local errors", () => {
  assert.ok(!isTransientError(new Error("Download failed: HTTP 404")));
  assert.ok(
    !isTransientError(
      new Error(
        "No download directory configured. Set an output folder in Settings first."
      )
    )
  );
  assert.ok(!isTransientError("not an error object"));
});

test("retryTransient retries transient failures until one succeeds", async () => {
  let calls = 0;
  const result = await retryTransient(
    async () => {
      calls++;
      if (calls < 3) throw new Error("Download failed: HTTP 503");
      return "ok";
    },
    4,
    [1, 2, 3]
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("retryTransient does not retry non-transient failures", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        calls++;
        throw new Error("Download failed: HTTP 404");
      },
      4,
      [1]
    ),
    /404/
  );
  assert.equal(calls, 1);
});

test("retryTransient rethrows the last error after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        calls++;
        throw new Error(`Download failed: HTTP 503 (attempt ${calls})`);
      },
      3,
      [1]
    ),
    /attempt 3/
  );
  assert.equal(calls, 3);
});
