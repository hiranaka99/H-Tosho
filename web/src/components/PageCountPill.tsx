import { cn } from "../lib/utils";

export function PageCountPill({
  pageCount,
  className,
}: {
  pageCount?: number | null;
  className?: string;
}) {
  if (
    typeof pageCount !== "number" ||
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0
  )
    return null;
  const label = `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 rounded-full bg-black/70 px-2 py-0.5 text-xs tabular-nums text-white",
        className
      )}
    >
      {pageCount}p
    </span>
  );
}
