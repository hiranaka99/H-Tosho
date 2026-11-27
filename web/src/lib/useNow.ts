import * as React from "react";

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: number | null;
}

/** One timer per interval length, shared by every subscriber; paused while the tab is hidden. */
const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

function tick(clock: Clock) {
  clock.now = Date.now();
  clock.listeners.forEach((listener) => listener());
}

function start(intervalMs: number, clock: Clock) {
  if (clock.timer !== null || clock.listeners.size === 0 || document.hidden)
    return;
  clock.timer = window.setInterval(() => tick(clock), intervalMs);
}

function stop(clock: Clock) {
  if (clock.timer === null) return;
  window.clearInterval(clock.timer);
  clock.timer = null;
}

let visibilityBound = false;
function bindVisibility() {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    for (const [intervalMs, clock] of clocks) {
      if (document.hidden) stop(clock);
      else if (clock.listeners.size) {
        tick(clock);
        start(intervalMs, clock);
      }
    }
  });
}

/**
 * Current time, refreshed every `intervalMs` while `enabled`. Components using
 * the same interval share one timer, so leaf components (relative times,
 * elapsed counters) can tick without re-rendering their parents.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const subscribe = React.useCallback(
    (listener: () => void) => {
      if (!enabled) return () => {};
      bindVisibility();
      const clock = clockFor(intervalMs);
      if (clock.timer === null) clock.now = Date.now(); // Fresh value when a clock (re)starts.
      clock.listeners.add(listener);
      start(intervalMs, clock);
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0) stop(clock);
      };
    },
    [intervalMs, enabled]
  );
  const getSnapshot = React.useCallback(
    () => clockFor(intervalMs).now,
    [intervalMs]
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
