import * as React from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { cn } from './utils';
import { Button } from '../components/ui';
import { useMediaQuery } from './useMediaQuery';

export type ToastTone = 'success' | 'danger' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Optional single recovery action such as Undo. Dismisses the toast when used. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: number;
  description?: string;
  action?: ToastInput['action'];
}

/**
 * Minimal, dependency-free toast system. `toast()` can be called from anywhere
 * (including non-React code such as the downloads provider); the `<Toaster />`
 * component renders the stack and auto-dismisses items.
 */
let listeners: ((t: ToastItem) => void)[] = [];
let seq = 0;

export function toast(input: ToastInput): void {
  const item: ToastItem = { id: ++seq, title: input.title, tone: input.tone ?? 'info', description: input.description, action: input.action };
  for (const l of listeners) l(item);
}

const TONE_STYLE: Record<ToastTone, { border: string; icon: React.ReactNode }> = {
  success: { border: 'border-l-success', icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> },
  danger: { border: 'border-l-danger', icon: <XCircle className="h-4 w-4 shrink-0 text-danger" /> },
  info: { border: 'border-l-primary', icon: <Info className="h-4 w-4 shrink-0 text-primary" /> },
};

/** Danger toasts carry error details people need time to read — keep them up longer. */
const TONE_LIFETIME_MS: Record<ToastTone, number> = { success: 5000, info: 5000, danger: 10000 };

/** Keep dismissal and its countdown together so interruption never resets time. */
function ToastCard({ item: t, hidden, dismiss }: { item: ToastItem; hidden: boolean; dismiss: (id: number) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const remaining = React.useRef(TONE_LIFETIME_MS[t.tone]);
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const paused = hovered || focused || hidden;

  React.useEffect(() => {
    if (paused || closing) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setClosing(true), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [paused, closing]);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!closing || !node) return;
    node.inert = true;
    if (typeof node.animate !== 'function') { dismiss(t.id); return; }
    const animation = node.animate(
      reducedMotion
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(12px)' }],
      { duration: reducedMotion ? 80 : 140, easing: 'ease-in', fill: 'forwards' },
    );
    animation.onfinish = () => dismiss(t.id);
    return () => animation.cancel();
  }, [closing, reducedMotion, dismiss, t.id]);

  return (
    <div
      ref={ref}
      data-paused={paused}
      data-closing={closing}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      className={cn('ui-toast pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-lg border border-border border-l-4 bg-surface p-3 shadow-lg', TONE_STYLE[t.tone].border)}
      role={t.tone === 'danger' ? 'alert' : 'status'}
    >
      {TONE_STYLE[t.tone].icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t.title}</p>
        {t.description && <p className={cn('mt-0.5 text-xs text-muted', t.tone === 'danger' ? 'line-clamp-4' : 'line-clamp-2')} title={t.description}>{t.description}</p>}
        {t.action && <Button size="sm" variant="outline" className="mt-2 max-lg:min-h-11 pointer-coarse:min-h-11" onClick={() => { t.action?.onClick(); setClosing(true); }}>{t.action.label}</Button>}
      </div>
      <Button size="icon" variant="ghost" onClick={() => setClosing(true)} className="shrink-0" aria-label={`Dismiss ${t.title}`}>
        <X className="h-3.5 w-3.5" />
      </Button>
      <div aria-hidden="true" className={cn('absolute bottom-0 left-0 h-0.5 w-full origin-left animate-toast-progress', t.tone === 'success' ? 'bg-success/50' : t.tone === 'danger' ? 'bg-danger/50' : 'bg-primary/40')} style={{ animationDuration: TONE_LIFETIME_MS[t.tone] + 'ms' }} />
    </div>
  );
}

export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const [hidden, setHidden] = React.useState(document.hidden);
  const dismiss = React.useCallback((id: number) => setItems((prev) => prev.filter((item) => item.id !== id)), []);

  React.useEffect(() => {
    const on = (t: ToastItem) => {
      setItems((prev) => [...prev.slice(-4), t]); // keep at most ~5 visible
    };
    const onVisibilityChange = () => {
      setHidden(document.hidden);
      document.documentElement.toggleAttribute('data-motion-paused', document.hidden);
    };
    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);
    listeners.push(on);
    return () => {
      listeners = listeners.filter((l) => l !== on);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.documentElement.removeAttribute('data-motion-paused');
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((t) => <ToastCard key={t.id} item={t} hidden={hidden} dismiss={dismiss} />)}
    </div>
  );
}
