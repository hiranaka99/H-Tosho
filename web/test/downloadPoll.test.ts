import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDownloadPoll } from "../src/lib/downloadPoll.js";
import type { DownloadTask } from "../src/lib/api.js";
const task = (attempt: number, revision: number, status = "downloading") =>
  ({
    id: 1,
    attempt,
    revision,
    status,
    currentFile: "Arbitrary translated display label",
  }) as DownloadTask;
test("late polls and events cannot overwrite a newer snapshot or a new attempt", () => {
  const newest = task(2, 8);
  assert.equal(mergeDownloadPoll([newest], [task(2, 7)])[0], newest);
  assert.equal(mergeDownloadPoll([newest], [task(1, 999)])[0], newest);
  const retry = task(3, 1);
  assert.equal(mergeDownloadPoll([newest], [retry])[0], retry);
  const completed = task(2, 9, "completed");
  assert.equal(mergeDownloadPoll([newest], [completed])[0], completed);
});
