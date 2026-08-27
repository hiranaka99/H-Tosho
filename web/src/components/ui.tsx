import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva, type VariantProps } from 'class-variance-authority';
import { X, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn, PROVIDER_COLORS, PROVIDER_NAMES } from '../lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all duration-150 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none ' +
    'disabled:opacity-50 px-4 active:scale-[0.97]',
  {
    variants: {
      variant: {
        default: 'bg-primary text-white shadow-md shadow-primary/20 hover:bg-primary-hover',
        outline: 'border border-border-2 bg-transparent hover:bg-surface-2',
        ghost: 'bg-transparent hover:bg-surface-2',
        danger: 'bg-danger text-white hover:opacity-90',
        secondary: 'bg-surface-2 text-foreground hover:bg-border',
      },
      size: {
        default: 'min-h-11 px-4',
        sm: 'min-h-11 px-3 text-xs',
        lg: 'min-h-12 px-6',
        icon: 'h-11 w-11 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-surface transition-colors', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-4 border-b border-border', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex min-h-11 w-full rounded-lg border border-border-2 bg-surface-2 px-3 py-2 text-sm placeholder:text-muted',
        'transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-muted', className)} {...props} />;
}

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex min-h-11 w-full rounded-lg border border-border-2 bg-surface-2 px-3 text-sm',
        'transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: { checked: boolean; onCheckedChange: (c: boolean) => void } & Omit<
  React.ComponentProps<typeof SwitchPrimitive.Root>,
  'checked' | 'onCheckedChange'
>) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={props['aria-label'] ?? 'Toggle'}
      className={cn(
        'inline-flex h-7 w-12 items-center rounded-full transition-colors focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-primary/50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-border-2',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-6 w-6 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      default: 'bg-surface-2 text-foreground',
      success: 'bg-success/15 text-success',
      warning: 'bg-warning/15 text-warning',
      danger: 'bg-danger/15 text-danger',
      info: 'bg-info/15 text-info',
      muted: 'bg-surface-2 text-muted',
    },
  },
  defaultVariants: { tone: 'default' },
});

export function Badge({
  className,
  tone = 'default',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function ProviderBadge({ id, className, solid = false }: { id: string; className?: string; solid?: boolean }) {
  const color = PROVIDER_COLORS[id] ?? '#888';
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', className)}
      style={solid ? { backgroundColor: 'rgba(0, 0, 0, 0.75)', color } : { backgroundColor: color + '22', color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {PROVIDER_NAMES[id] ?? id}
    </span>
  );
}

const STATUS_TONE: Record<string, 'success' | 'muted' | 'warning' | 'danger'> = {
  matched: 'success',
  unmatched: 'muted',
  syncing: 'warning',
  failed: 'danger',
};

export function StatusBadge({ status, className, title }: { status: string; className?: string; title?: string }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <Badge tone={STATUS_TONE[status] ?? 'default'} className={className} title={title}>
      {status === 'syncing' && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </Badge>
  );
}

export function ProgressBar({ value, max, className, active = false, label = 'Progress' }: { value: number; max: number; className?: string; active?: boolean; label?: string }) {
  const determinate = max > 0;
  const p = determinate ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={determinate ? Math.min(max, value) : undefined}
      aria-valuetext={determinate ? `${p}%` : 'In progress'}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-2', className)}
    >
      <div className="relative h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: p + '%' }}>
        {active && p > 0 && p < 100 && <div className="progress-stripes absolute inset-0" />}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted', className)} />;
}

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </DialogPrimitive.Root>
  );
}

export function DialogContent({ children, className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'dialog-content fixed left-1/2 top-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(100vh-1.5rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close aria-label="Close dialog" className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-md bg-surface/90 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-base font-semibold', className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export function ErrorState({ title = 'Something went wrong', description, onRetry }: { title?: string; description?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <AlertTriangle className="h-7 w-7 text-danger" />
      <div>
        <p className="font-medium">{title}</p>
        {description && <p className="mt-1 max-w-lg break-words text-sm text-muted">{description}</p>}
      </div>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function SegmentedTabs<T extends string>({ items, value, onChange, label, panelId, className }: { items: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string; panelId: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cn('flex max-w-full gap-4 overflow-x-auto border-b border-border-2', className)}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          id={`${panelId}-tab-${item.id}`}
          aria-controls={panelId}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const index = items.findIndex((candidate) => candidate.id === value);
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowRight' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
            const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
            onChange(items[nextIndex].id);
            requestAnimationFrame(() => tabs?.[nextIndex]?.focus());
          }}
          className={cn(
            '-mb-px min-h-11 shrink-0 border-b-2 px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
            value === item.id ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ConfirmDialog({ open, title, description, confirmLabel, danger = false, pending = false, onConfirm, onOpenChange }: { open: boolean; title: string; description: string; confirmLabel: string; danger?: boolean; pending?: boolean; onConfirm: () => void; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="flex flex-col gap-4 p-5 pr-14">
          <div className="flex items-start gap-3">
            <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', danger ? 'bg-danger/15 text-danger' : 'bg-primary/15 text-primary')}>
              {danger ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            </div>
            <div>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-1">{description}</DialogDescription>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'default'} onClick={onConfirm} disabled={pending}>
              {pending && <Spinner />} {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function EmptyState({ icon, title, description }: { icon?: React.ReactNode; title: string; description?: string }) {
  return (
    <div className="flex animate-fade-in flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
    </div>
  );
}
/** Shimmering placeholder block for loading content. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}

/** Standard page heading: icon chip, title, subtitle, and an optional right-side action slot. */
export function PageHeader({
  icon,
  title,
  subtitle,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="flex items-center gap-3">
        {icon && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-gradient-to-br from-primary/25 to-transparent text-primary shadow-md shadow-black/20">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}