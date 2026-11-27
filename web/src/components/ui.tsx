import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn, PROVIDER_COLORS, PROVIDER_NAMES } from "../lib/utils";
import { useSelectionIndicator } from "../lib/useSelectionIndicator";

const buttonVariants = cva(
  "ui-button inline-flex min-w-0 select-none items-center justify-center gap-2 rounded-lg text-center text-sm font-medium leading-tight " +
    "disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "ui-button-raised bg-primary-button text-white hover:bg-primary-button-hover",
        outline:
          "ui-button-raised border border-border-2 bg-surface text-foreground hover:bg-surface-2",
        ghost: "text-muted hover:bg-surface-2 hover:text-foreground",
        danger:
          "ui-button-raised bg-danger text-white hover:opacity-90 dark:text-background",
        secondary:
          "ui-button-raised bg-surface-2 text-foreground hover:bg-border/60",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-9 px-2.5 text-xs",
        lg: "h-10 px-4",
        icon: "ui-button-icon h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "ui-card min-w-0 rounded-xl border border-border bg-surface",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-b border-border p-3 sm:p-4",
        className
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  as: Heading = "h3",
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Heading
      className={cn("min-w-0 text-sm font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-3 sm:p-4", className)} {...props} />;
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "ui-field flex h-9 w-full rounded-lg border border-border-2 bg-surface-2 px-3 text-base text-foreground placeholder:text-muted focus:border-primary focus:bg-surface aria-[invalid=true]:border-danger sm:text-sm",
      "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-xs font-medium text-muted", className)}
      {...props}
    />
  );
}

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "ui-field flex h-9 w-full rounded-lg border border-border-2 bg-surface-2 px-3 text-base text-foreground focus:border-primary focus:bg-surface sm:text-sm",
      "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-sans text-xs font-medium",
  {
    variants: {
      tone: {
        default: "bg-surface-2 text-foreground",
        success: "bg-success/15 text-success",
        warning: "bg-warning/15 text-warning",
        danger: "bg-danger/15 text-danger",
        info: "bg-info/15 text-info",
        muted: "bg-surface-2 text-muted",
      },
    },
    defaultVariants: { tone: "default" },
  }
);

export function Badge({
  className,
  tone = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function ProviderBadge({
  id,
  className,
  solid = false,
}: {
  id: string;
  className?: string;
  solid?: boolean;
}) {
  const color = PROVIDER_COLORS[id] ?? "#888";
  // The provider hue tints the chip and its dot; the label is the hue mixed into
  // the theme foreground so it stays readable on its own tint in both themes
  // (raw provider yellow/green on a pale tint measured 1.6–2.3:1).
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        className
      )}
      style={
        solid
          ? { backgroundColor: "var(--cover-scrim)", color }
          : {
              backgroundColor: `color-mix(in srgb, ${color} 16%, var(--surface))`,
              color: `color-mix(in srgb, ${color} 38%, var(--foreground))`,
            }
      }
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {PROVIDER_NAMES[id] ?? id}
    </span>
  );
}

const STATUS_TONE: Record<string, "success" | "muted" | "warning" | "danger"> =
  {
    matched: "success",
    unmatched: "muted",
    syncing: "warning",
    failed: "danger",
  };

export function StatusBadge({
  status,
  className,
  title,
}: {
  status: string;
  className?: string;
  title?: string;
}) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <Badge
      tone={STATUS_TONE[status] ?? "default"}
      className={className}
      title={title}
    >
      {status === "syncing" && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </Badge>
  );
}

export function ProgressBar({
  value,
  max,
  className,
  active = false,
  label = "Progress",
}: {
  value: number;
  max: number;
  className?: string;
  active?: boolean;
  label?: string;
}) {
  const determinate = max > 0;
  const p = determinate
    ? Math.max(0, Math.min(100, Math.round((value / max) * 100)))
    : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={
        determinate ? Math.max(0, Math.min(max, value)) : undefined
      }
      aria-valuetext={determinate ? `${p}%` : "In progress"}
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-surface-2",
        className
      )}
    >
      <div
        className={cn(
          "relative h-full origin-left rounded-full bg-primary",
          determinate
            ? "ui-progress-fill w-full"
            : "ui-progress-indeterminate w-1/3"
        )}
        style={determinate ? { transform: `scaleX(${p / 100})` } : undefined}
      >
        {active && p > 0 && p < 100 && (
          <div className="progress-stripes absolute inset-0" />
        )}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2 className={cn("h-4 w-4 animate-spin text-muted", className)} />
  );
}

/** Page numbers with ellipses: [1 … 4 5 6 … 42] style, capped to a sane width. */
function pageList(page: number, count: number): (number | "…")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const pages: (number | "…")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(count - 1, page + 1);
  if (lo > 2) pages.push("…");
  for (let p = lo; p <= hi; p++) pages.push(p);
  if (hi < count - 1) pages.push("…");
  pages.push(count);
  return pages;
}

/** Previous/next and numbered pages share one navigation control. */
export function Pager({
  page,
  count,
  onPageChange,
}: {
  page: number;
  count: number;
  onPageChange: (p: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <nav
      aria-label="Pages"
      className="flex flex-wrap items-center justify-center gap-1"
    >
      <Button
        size="sm"
        variant="outline"
        className="max-lg:min-h-11 pointer-coarse:min-h-11"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Previous
      </Button>
      {pageList(page, count).map((p, i) =>
        p === "…" ? (
          <span key={`e${i}`} className="px-1 text-xs text-muted">
            …
          </span>
        ) : (
          <Button
            key={p}
            size="sm"
            variant="outline"
            className={cn(
              "max-lg:min-w-11 pointer-coarse:min-w-11 max-lg:min-h-11 pointer-coarse:min-h-11",
              p === page &&
                "border-primary/40 bg-primary/10 text-primary-hover hover:bg-primary/15"
            )}
            onClick={() => onPageChange(p)}
            aria-current={p === page ? "page" : undefined}
          >
            {p}
          </Button>
        )
      )}
      <Button
        size="sm"
        variant="outline"
        className="max-lg:min-h-11 pointer-coarse:min-h-11"
        disabled={page >= count}
        onClick={() => onPageChange(page + 1)}
      >
        Next <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </nav>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-w-0 flex-col items-center justify-center gap-3 px-3 py-12 text-center sm:py-16"
    >
      <AlertTriangle className="h-6 w-6 text-danger" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="mt-1 max-w-lg break-words text-sm text-muted">
            {description}
          </p>
        )}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  panelId,
  className,
}: {
  items: readonly {
    id: T;
    label: string;
    dirty?: boolean;
    count?: number;
    alert?: boolean;
  }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  panelId: string;
  className?: string;
}) {
  const { ref, indicatorStyle } = useSelectionIndicator(value, items);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={cn(
        "ui-tablist relative flex w-full max-w-full flex-nowrap overflow-x-auto border-b border-border p-1",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="ui-tab-indicator pointer-events-none absolute bottom-1 left-0 h-0.5 rounded-full bg-primary"
        style={indicatorStyle}
      />
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
            if (
              event.key !== "ArrowLeft" &&
              event.key !== "ArrowRight" &&
              event.key !== "Home" &&
              event.key !== "End"
            )
              return;
            event.preventDefault();
            const index = items.findIndex(
              (candidate) => candidate.id === value
            );
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowRight"
                    ? (index + 1) % items.length
                    : (index - 1 + items.length) % items.length;
            const tabs =
              event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                '[role="tab"]'
              );
            onChange(items[nextIndex].id);
            requestAnimationFrame(() => tabs?.[nextIndex]?.focus());
          }}
          className={cn(
            "ui-choice relative min-h-9 shrink-0 border-b-2 border-transparent px-1 text-xs font-medium transition-colors duration-150 min-[360px]:px-1.5 sm:px-3 sm:text-sm",
            value === item.id
              ? "text-primary"
              : "text-muted hover:text-foreground"
          )}
        >
          {item.label}
          {item.count !== undefined && (
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 text-xs tabular-nums",
                item.alert
                  ? "bg-danger/15 text-danger"
                  : value === item.id
                    ? "bg-primary/15 text-primary"
                    : "bg-surface-2 text-muted"
              )}
            >
              <span className="sr-only"> </span>
              {item.count}
            </span>
          )}
          {item.dirty && (
            <>
              <span
                aria-hidden="true"
                className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
              />
              <span className="sr-only">, unsaved changes</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** Animate content changes without remounting forms or losing their drafts. */
export function TabPanel({
  value,
  tabOrder,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  value: string;
  tabOrder?: readonly string[];
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const previousValue = React.useRef(value);
  React.useLayoutEffect(() => {
    const panel = ref.current;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const previous = previousValue.current;
    previousValue.current = value;
    if (
      !panel ||
      typeof panel.animate !== "function" ||
      (preference.matches && !tabOrder) ||
      (tabOrder && previous === value)
    )
      return;
    const direction =
      tabOrder && tabOrder.indexOf(value) < tabOrder.indexOf(previous) ? -1 : 1;
    const frames = preference.matches
      ? [{ opacity: 0.8 }, { opacity: 1 }]
      : tabOrder
        ? [
            { opacity: 0.65, transform: `translateX(${direction * 12}px)` },
            { opacity: 1, transform: "translateX(0)" },
          ]
        : [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ];
    const animation = panel.animate(frames, {
      duration: preference.matches ? 100 : tabOrder ? 240 : 220,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
    const onPreferenceChange = () => {
      if (preference.matches) animation.cancel();
    };
    preference.addEventListener("change", onPreferenceChange);
    return () => {
      animation.cancel();
      preference.removeEventListener("change", onPreferenceChange);
    };
  }, [value, tabOrder]);
  return (
    <div
      ref={ref}
      className={cn("ui-tab-panel flex min-w-0 flex-col gap-4", className)}
      {...props}
    />
  );
}

/** Mutually exclusive choices share one appearance and keyboard behavior. */
export function SegmentedControl<T extends string | number>({
  items,
  value,
  onChange,
  label,
  className,
  itemClassName,
}: {
  items: readonly {
    id: T;
    label: string;
    icon?: React.ReactNode;
    count?: number;
    alert?: boolean;
  }[];
  value: T | null;
  onChange: (id: T) => void;
  label: string;
  className?: string;
  itemClassName?: string;
}) {
  const selectedIndex = items.findIndex((item) => item.id === value);
  const { ref, indicatorStyle } = useSelectionIndicator(value, items);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative flex min-w-0 max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-surface-2 p-0.5",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="ui-tab-indicator pointer-events-none absolute bottom-0.5 left-0 top-0.5 rounded-md bg-surface shadow-sm"
        style={indicatorStyle}
      />
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={item.id === value}
          tabIndex={index === Math.max(0, selectedIndex) ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            if (
              ![
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : items.length - 1)) %
                    items.length;
            onChange(items[nextIndex].id);
            requestAnimationFrame(() => {
              const group = Array.from(
                document.querySelectorAll('[role="radiogroup"]')
              ).find((element) => element.getAttribute("aria-label") === label);
              group
                ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                [nextIndex]?.focus();
            });
          }}
          className={cn(
            "ui-choice relative z-10 flex min-h-8 shrink-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150",
            item.id === value
              ? "text-primary"
              : "text-muted hover:bg-surface/60 hover:text-foreground",
            itemClassName
          )}
        >
          {item.icon}
          {item.label}
          {item.count !== undefined && (
            <span
              className={cn(
                "rounded-full px-1.5 text-xs tabular-nums",
                item.alert
                  ? "bg-danger/15 text-danger"
                  : item.id === value
                    ? "bg-primary/15 text-primary"
                    : "bg-surface text-muted"
              )}
            >
              <span className="sr-only"> </span>
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Native disclosure with a consistent, visible open/closed indicator. */
export function Disclosure({
  label,
  children,
  className,
  summaryClassName,
  ...props
}: React.ComponentPropsWithoutRef<"details"> & {
  label: React.ReactNode;
  summaryClassName?: string;
}) {
  return (
    <details className={cn("group/disclosure min-w-0", className)} {...props}>
      <summary
        className={cn(
          "flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors duration-150 hover:text-foreground [&::-webkit-details-marker]:hidden",
          summaryClassName
        )}
      >
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform duration-150 group-open/disclosure:rotate-180"
          aria-hidden="true"
        />
      </summary>
      {children}
    </details>
  );
}

/** How long an inline destructive confirmation stays open before reverting. */
export const INLINE_CONFIRM_MS = 6000;

/**
 * Destructive confirmation in place, where the action started: a danger-tinted
 * group that says what is kept, focuses the safe choice, reverts on Escape, and
 * reverts by itself after six seconds (the bottom bar shows the time left).
 */
export function InlineConfirm({
  label,
  children,
  keepLabel,
  confirmLabel,
  icon,
  pending = false,
  onKeep,
  onConfirm,
  className,
  controlClassName,
}: {
  label: string;
  children: React.ReactNode;
  keepLabel: string;
  confirmLabel: string;
  icon?: React.ReactNode;
  pending?: boolean;
  onKeep: () => void;
  onConfirm: () => void;
  className?: string;
  controlClassName?: string;
}) {
  const keepRef = React.useRef<HTMLButtonElement>(null);
  const groupRef = React.useRef<HTMLDivElement>(null);
  const keep = React.useRef(onKeep);
  keep.current = onKeep;
  React.useEffect(() => {
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    keepRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => keep.current(), INLINE_CONFIRM_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      keep.current();
    };
    window.addEventListener("keydown", onKey, true);
    const group = groupRef.current;
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      // Hand keyboard focus back to the control that opened the confirmation.
      const active = document.activeElement;
      if (
        trigger?.isConnected &&
        (!active || active === document.body || group?.contains(active))
      )
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={label}
      className={cn(
        "relative space-y-3 overflow-hidden rounded-lg border border-danger/35 bg-danger/5 p-3",
        className
      )}
    >
      <p className="text-sm">{children}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={keepRef}
          variant="outline"
          size="sm"
          className={controlClassName}
          onClick={onKeep}
        >
          {keepLabel}
        </Button>
        <Button
          variant="danger"
          size="sm"
          className={controlClassName}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? <Spinner /> : icon} {confirmLabel}
        </Button>
      </div>
      <span
        aria-hidden="true"
        className="confirm-countdown absolute bottom-0 left-0 h-0.5 w-full bg-danger/70"
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  compact = false,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex animate-fade-in flex-col items-center justify-center gap-2 px-3 text-center",
        compact ? "py-8" : "py-12 sm:py-16"
      )}
    >
      {icon && (
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-muted">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-sm break-words text-sm text-muted">{description}</p>
      )}
    </div>
  );
}

/** Shimmering placeholder block for loading content. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
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
    <div
      className={cn(
        "flex min-w-0 flex-col items-start justify-between gap-3 sm:flex-row sm:flex-wrap sm:items-center",
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-3 sm:items-center">
        {icon && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 break-words text-sm text-muted">{subtitle}</p>
          )}
        </div>
      </div>
      {children ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {children}
        </div>
      ) : null}
    </div>
  );
}
