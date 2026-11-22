import { Skeleton } from '../../components/ui';

/** Placeholder grid shared by every Discover results view, so loading looks the same everywhere. */
export function GallerySkeletonGrid({ label, count = 12 }: { label: string; count?: number }) {
  return (
    <div role="status" aria-label={label} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
          <Skeleton className="aspect-[3/4] w-full rounded-none" />
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex items-center justify-between gap-2 pt-1">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
