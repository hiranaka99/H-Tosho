import * as React from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { cn } from './utils';

export type ToastTone = 'success' | 'danger' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: number;
  description?: string;
}

/**
 * Minimal, dependency-free toast system. `toast()` can be called from anywhere
 * (including non-React code such as the downloads provider); the `<Toaster />`
 * component renders the stack and auto-dismisses items.
 */
let listeners: ((t: ToastItem) => void)[] = [];
let seq = 0;

export function toast(input: ToastInput): void {
  const item: ToastItem = { id: ++seq, title: input.title, tone: input.tone ?? 'info', description: input.description };
  for (const l of listeners) l(item);
}

const TONE_STYLE: Record<ToastTone, { border: string; icon: React.ReactNode }> = {
  success: { border: 'border-l-success', icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> },
  danger: { border: 'border-l-danger', icon: <XCircle className="h-4 w-4 shrink-0 text-danger" /> },
  info: { border: 'border-l-primary', icon: <Info className="h-4 w-4 shrink-0 text-primary" /> },
};

/** Danger toasts carry error details people need time to read — keep them up longer. */
const TONE_LIFETIME_MS: Record<ToastTone, number> = { success: 5000, info: 5000, danger: 10000 };

export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    const on = (t: ToastItem) => {
      setItems((prev) => [...prev.slice(-4), t]); // keep at most ~5 visible
      window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== t.id));
      }, TONE_LIFETIME_MS[t.tone]);
    };
    listeners.push(on);
    return () => {
      listeners = listeners.filter((l) => l !== on);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto relative flex animate-slide-in-right items-start gap-3 overflow-hidden rounded-md border border-border bg-surface p-3 shadow-lg',
            'border-l-4',
            TONE_STYLE[t.tone].border,
          )}
          role={t.tone === 'danger' ? 'alert' : 'status'}
        >
          {TONE_STYLE[t.tone].icon}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.title}</p>
            {t.description && <p className={cn('mt-0.5 text-xs text-muted', t.tone === 'danger' ? 'line-clamp-4' : 'truncate')} title={t.description}>{t.description}</p>}
          </div>
          <button
            type="button"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
            aria-label={`Dismiss ${t.title}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          {/* Auto-dismiss countdown (matches the per-tone timeout above). */}
          <div className={cn('absolute bottom-0 left-0 h-0.5 w-full origin-left animate-toast-progress', t.tone === 'success' ? 'bg-success/50' : t.tone === 'danger' ? 'bg-danger/50' : 'bg-primary/40')} style={{ animationDuration: TONE_LIFETIME_MS[t.tone] + 'ms' }} />
        </div>
      ))}
    </div>
  );
}