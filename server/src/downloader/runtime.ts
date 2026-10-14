import type { DownloadTask } from '../contracts/downloads.js';
/** A cancellation token checked between each image request. */
export interface RunContext {
  cancelled: boolean;
  controller: AbortController;
  stopped: boolean;
  committing: boolean;
  pauseSignal: {
    paused: boolean;
    /** Resolvers of workers parked on the pause gate; resume()/cancel() settle them. */
    waiters: (() => void)[];
  };
}

/** Wake every worker parked on the pause gate (resume, cancel, and run teardown). */
export function wakePaused(run: RunContext): void {
  for (const w of run.pauseSignal.waiters.splice(0)) w();
}

/** Volatile progress fields that update faster than the throttled DB write. */
type LiveFieldKeys = 'progressCurrent' | 'progressTotal' | 'speed' | 'currentFile' | 'bytesCurrent' | 'bytesTotal' | 'revision' | 'phase';
export type LiveFields = Partial<Pick<DownloadTask, LiveFieldKeys>>;
