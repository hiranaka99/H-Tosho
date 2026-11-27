import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEta } from "../src/lib/format.js";
import { downloadErrorHelp } from "../src/lib/downloadErrors.js";

test("formatEta formats remaining time cleanly and ignores invalid inputs", () => {
  assert.equal(formatEta(0, 1000), "");
  assert.equal(formatEta(-50, 1000), "");
  assert.equal(formatEta(1000, 0), "");
  assert.equal(formatEta(1000, null), "");
  assert.equal(formatEta(1000, -10), "");

  assert.equal(formatEta(15_000, 1000), "~15s left");
  assert.equal(formatEta(60_000, 1000), "~1m left");
  assert.equal(formatEta(130_000, 1000), "~2m 10s left");
  assert.equal(formatEta(3_600_000, 1000), "~1h left");
  assert.equal(formatEta(3_900_000, 1000), "~1h 5m left");
  // 1h 59m 59s rounds up to 2h left, never 1h 60m left.
  assert.equal(formatEta(7_199_000, 1000), "~2h left");
});

test("downloadErrorHelp handles quota and disk-full codes and legacy messages", () => {
  const quota = downloadErrorHelp("HTTP 509", "quota", "E-Hentai");
  assert.match(quota.message, /E-Hentai/i);
  assert.match(quota.message, /quota/i);
  assert.equal(quota.settings, undefined);

  const diskFull = downloadErrorHelp("ENOSPC", "disk-full", "Hitomi.la");
  assert.match(diskFull.message, /disk space/i);
  assert.equal(diskFull.settings, true);

  // Legacy untyped message fallbacks
  assert.match(
    downloadErrorHelp("ENOSPC: no space left on device").message,
    /disk space/i
  );
  assert.equal(downloadErrorHelp("EDQUOT").settings, true);
  assert.match(
    downloadErrorHelp("HTTP 509 image quota exhausted", null, "E-Hentai")
      .message,
    /E-Hentai/i
  );
});
