import * as React from "react";

/** Mount-time style only: later positions are written straight to the node, so
 * this object never changes and React never overwrites them on re-render. */
const INITIAL_INDICATOR_STYLE: React.CSSProperties = {
  transform: "translateX(0px)",
  width: 0,
  opacity: 0,
};

/**
 * Measure the selected control in scrollable tab and choice groups and position
 * the indicator directly on the DOM (no state, so moving it never re-renders the
 * group). One ResizeObserver lives for the group's lifetime.
 *
 * Pass `indicatorRef` to the indicator element; without it, the group's first
 * direct `span[aria-hidden="true"]` child is used. `indicatorStyle` stays in the
 * return value for existing callers.
 */
export function useSelectionIndicator(
  value: string | number | null,
  items: readonly { id: string | number; label: string }[]
) {
  const ref = React.useRef<HTMLDivElement>(null);
  const indicatorRef = React.useRef<HTMLSpanElement>(null);
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const itemKey = items.map((item) => `${item.id}:${item.label}`).join("\0");

  const measure = React.useCallback(() => {
    const group = ref.current;
    if (!group) return;
    const indicator =
      indicatorRef.current ??
      group.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
    if (!indicator) return;
    const selected = group.querySelector<HTMLElement>(
      '[aria-selected="true"], [aria-checked="true"]'
    );
    const left = selected ? selected.offsetLeft : 0;
    const width = selected ? selected.offsetWidth : 0;
    indicator.style.transform = `translateX(${left}px)`;
    indicator.style.width = `${width}px`;
    indicator.style.opacity = width > 0 ? "1" : "0";
  }, []);

  React.useLayoutEffect(() => {
    const group = ref.current;
    if (!group || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [measure]);

  React.useLayoutEffect(() => {
    measure();
    const group = ref.current,
      observer = observerRef.current;
    if (!group || !observer) return;
    const buttons = Array.from(group.querySelectorAll("button"));
    buttons.forEach((button) => observer.observe(button));
    return () => buttons.forEach((button) => observer.unobserve(button));
  }, [value, itemKey, measure]);

  return { ref, indicatorRef, indicatorStyle: INITIAL_INDICATOR_STYLE };
}
