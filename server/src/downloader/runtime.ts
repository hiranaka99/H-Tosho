import type { DownloadTask } from '../contracts/downloads.js';

/** Sentinel error thrown when an active download unwinds because the user paused it. */
export class DownloadPausedError extends Error {
  constructor() {
    super('Download paused');
    this.name = 'DownloadPausedError';
  }
}

/** Sentinel error thrown when an active download unwinds for a clean server shutdown. */
export class DownloadShutdownError extends Error {
  constructor() {
    super('Server shutting down');
    this.name = 'DownloadShutdownError';
  }
}

/** A cancellation/pause token checked across gallery resolution, image transfer, and packing. */
export interface RunContext {
  cancelled: boolean;
  paused?: boolean;
  shuttingDown?: boolean;
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
