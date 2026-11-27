import { pathContains } from "./paths.js";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** FIFO ownership of resources. '*' conflicts with every resource. */
export class MutationCoordinator {
  private active = new Set<string>();
  private waiting: { keys: string[]; start: () => void }[] = [];

  run<T>(
    resources: readonly string[],
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const keys = [...new Set(resources.length ? resources : ["*"])];
    const abortError = () => {
      const reason: unknown = signal?.reason;
      return reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" && reason ? reason : "Aborted");
    };
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const entry = {
        keys,
        start: () => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) {
            reject(abortError());
            return;
          }
          keys.forEach((key) => this.active.add(key));
          void Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              keys.forEach((key) => this.active.delete(key));
              this.drain();
            });
        },
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          reject(abortError());
          this.drain();
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }

  private conflicts(a: readonly string[], b: readonly string[]): boolean {
    return (
      a.includes("*") ||
      b.includes("*") ||
      a.some((left) =>
        b.some(
          (right) =>
            left === right ||
            (path.isAbsolute(left) &&
              path.isAbsolute(right) &&
              (pathContains(left, right) || pathContains(right, left)))
        )
      )
    );
  }

  isBusy(resource: string): boolean {
    return (
      (this.active.size > 0 && this.conflicts([resource], [...this.active])) ||
      this.waiting.some((entry) => this.conflicts([resource], entry.keys))
    );
  }

  private drain(): void {
    const blocked: string[] = [];
    for (let index = 0; index < this.waiting.length;) {
      const next = this.waiting[index];
      if (
        (this.active.size && this.conflicts(next.keys, [...this.active])) ||
        (blocked.length && this.conflicts(next.keys, blocked))
      ) {
        blocked.push(...next.keys);
        index++;
      } else {
        this.waiting.splice(index, 1);
        next.start();
      }
    }
  }
}

export function archiveResource(file: string): string {
  let absolute = path.resolve(file);
  try {
    absolute = fs.realpathSync(absolute);
  } catch {
    /* New output is not published yet. */
  }
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

// fs.realpath (callback form) is the same JS resolver as fs.realpathSync, so
// both variants produce identical identities. fs.promises.realpath is the
// native resolver and can spell Windows paths differently; never mix them.
const realpathJs = promisify(fs.realpath);

/** Non-blocking archiveResource for large batches; identical results. */
export async function archiveResourceAsync(file: string): Promise<string> {
  let absolute = path.resolve(file);
  try {
    absolute = await realpathJs(absolute);
  } catch {
    /* New output is not published yet. */
  }
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export const libraryMutations = new MutationCoordinator();
export const archiveMutations = new MutationCoordinator();
