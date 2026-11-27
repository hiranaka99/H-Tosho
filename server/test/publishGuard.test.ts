import assert from "node:assert/strict";
import { test } from "node:test";
// Deliberately never imports `src/merge/`: this file runs in its own process,
// so no Protected Merge guard is installed.
import { guardDownloadPublication } from "../src/downloader/publishGuard.js";

test("without an installed guard, plain downloads publish and merge-linked downloads fail closed", async () => {
  assert.equal(
    await guardDownloadPublication(
      { downloadId: 1, targetDir: "/library/Plain" },
      async () => "published"
    ),
    "published"
  );

  let published = false;
  const publish = async () => {
    published = true;
  };
  await assert.rejects(
    guardDownloadPublication(
      { downloadId: 2, targetDir: "/library/Merged", mergeJobId: 9 },
      publish
    ),
    /Protected Merge/
  );
  await assert.rejects(
    guardDownloadPublication(
      {
        downloadId: 3,
        targetDir: "/library/Legacy",
        legacyMergeFolder: "Legacy",
      },
      publish
    ),
    /Protected Merge/
  );
  assert.equal(published, false);
});
