import * as React from 'react';
export function useDownloaderTransitions(state: string, selector = '[data-download-id], [data-gallery-motion-id], [data-gallery-shortlist-id]') {
  const ref = React.useRef<HTMLDivElement>(null);
  const previous = React.useRef<Map<string, { x: number; y: number }> | null>(null);
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches || document.hidden) {
      previous.current = null;
      return;
    }
    const origin = container.getBoundingClientRect();
    const positions = new Map<string, { x: number; y: number }>();
    const animations: Animation[] = [];
    // Read every rectangle before starting animations, which write visual state.
    const rows = Array.from(container.querySelectorAll<HTMLElement>(selector))
      .filter(row => !row.closest('[inert]'))
      .map(row => ({ row, bounds: row.getBoundingClientRect() }));
    rows.forEach(({ row, bounds }) => {
      // Hidden desktop/mobile shortlist copies never participate in motion.
      if (!bounds.width || !bounds.height) return;
      const id = row.dataset.galleryMotionId ? `gallery:${row.dataset.galleryMotionId}` : row.dataset.galleryShortlistId ? `shortlist:${row.dataset.galleryShortlistId}` : row.dataset.watchedSearchId ? `watch:${row.dataset.watchedSearchId}` : `task:${row.dataset.downloadId}`;
      const position = { x: bounds.left - origin.left, y: bounds.top - origin.top };
      positions.set(id, position);
      if (!previous.current || preference.matches || document.hidden || bounds.bottom < 0 || bounds.top > window.innerHeight || typeof row.animate !== 'function') return;
      const old = previous.current.get(id);
      const dx = old ? old.x - position.x : 0;
      const dy = old ? old.y - position.y : 6;
      if (old && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const nearby = old && Math.abs(dx) < bounds.width * 2 && Math.abs(dy) < bounds.height * 2;
      animations.push(row.animate(
        nearby ? [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]
          : id.startsWith('shortlist:') ? [{ opacity: 0.5, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }]
            : [{ opacity: 0.65 }, { opacity: 1 }],
        { duration: nearby ? 240 : 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      ));
    });
    previous.current = positions;
    const cancel = () => animations.forEach((animation) => animation.cancel());
    const onPreferenceChange = () => { if (preference.matches) cancel(); };
    const onVisibilityChange = () => { if (document.hidden) cancel(); };
    preference.addEventListener('change', onPreferenceChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancel();
      preference.removeEventListener('change', onPreferenceChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [state, selector]);
  return ref;
}

/** Format an ISO 8601 date string for display, or undefined when absent/invalid. */
