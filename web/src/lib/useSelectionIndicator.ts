import * as React from 'react';

/** Measure the selected control in scrollable tab and choice groups. */
export function useSelectionIndicator(value: string | number | null, items: readonly { id: string | number; label: string }[]) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = React.useState({ left: 0, width: 0 });
  const itemKey = items.map((item) => `${item.id}:${item.label}`).join('\0');

  React.useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const measure = () => {
      const selected = group.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"]');
      const next = selected ? { left: selected.offsetLeft, width: selected.offsetWidth } : { left: 0, width: 0 };
      setBounds((previous) => previous.left === next.left && previous.width === next.width ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    group.querySelectorAll('button').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [value, itemKey]);

  const indicatorStyle: React.CSSProperties = {
    transform: `translateX(${bounds.left}px)`,
    width: bounds.width,
    opacity: bounds.width > 0 ? 1 : 0,
  };
  return { ref, indicatorStyle };
}
