import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

/** Retain content through the closing animation, then release lazy subtrees. */
export function WatchedReveal({ open, id, children, className, lazy = false }: {
  open: boolean;
  id: string;
  children: React.ReactNode | (() => React.ReactNode);
  className?: string;
  lazy?: boolean;
}) {
  const [clipping, setClipping] = React.useState(true);
  const [mounted, setMounted] = React.useState(!lazy || open);
  React.useLayoutEffect(() => {
    setClipping(true);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!open) {
      if (!lazy) return;
      const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : 220);
      return () => window.clearTimeout(timer);
    }
    setMounted(true);
    // Release clipping after expansion so autocomplete can extend past the panel.
    const duration = reduced ? 0 : 260;
    const timer = window.setTimeout(() => setClipping(false), duration);
    return () => window.clearTimeout(timer);
  }, [open, lazy]);
  return (
    <div id={id} className="watched-reveal" data-open={open} data-clipping={!open || clipping}
      aria-hidden={!open} inert={!open}
      onTransitionEnd={event => {
        if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return;
        if (open) setClipping(false);
        else if (lazy) setMounted(false);
      }}>
      <div className="watched-reveal-inner"><div className={className}>{(open || mounted) && (typeof children === 'function' ? children() : children)}</div></div>
    </div>
  );
}

export function WatchedDisclosure({ open, onOpenChange, label, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: React.ReactNode | (() => React.ReactNode);
}) {
  const id = React.useId();
  return (
    <div className="min-w-0">
      <button type="button" className="watched-disclosure flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 text-left text-sm font-medium text-foreground"
        aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}>
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      <WatchedReveal id={id} open={open} lazy>{children}</WatchedReveal>
    </div>
  );
}
