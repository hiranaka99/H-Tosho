import * as React from 'react';
import { CheckSquare, Star } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui';

/**
 * One results header for every search scope: a real heading for screen-reader
 * navigation, the live count, the same Watch and Select actions, and an
 * optional status row (per-source chips in All sources).
 */
export function SearchResultsHeader({ status, actions, children }: { status: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="text-base font-semibold">Results</h2>
          <p role="status" className="min-w-0 text-sm text-muted">{status}</p>
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** Watch reads the same in every scope; a disabled Watch always says why. */
export function WatchSearchButton({ watching, pending = false, disabledReason, title, onToggle }: { watching: boolean; pending?: boolean; disabledReason?: string; title: string; onToggle: () => void }) {
  const noteId = React.useId();
  return <>
    {disabledReason && <span id={noteId} className="text-xs text-muted">{disabledReason}</span>}
    <Button
      type="button"
      size="sm"
      aria-label="Watch this search"
      aria-describedby={disabledReason ? noteId : undefined}
      aria-pressed={watching}
      variant={watching ? 'secondary' : 'outline'}
      onClick={onToggle}
      disabled={!!disabledReason || pending}
      title={title}
    >
      <Star className={cn('h-4 w-4', watching && 'fill-current')} /> {watching ? 'Watching' : 'Watch'}
    </Button>
  </>;
}

export function SelectModeButton({ selectMode, onToggle }: { selectMode: boolean; onToggle: () => void }) {
  return (
    <Button size="sm" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={onToggle} title="Select galleries to download together or merge into a series">
      <CheckSquare className="h-3.5 w-3.5" /> {selectMode ? 'Done selecting' : 'Select galleries'}
    </Button>
  );
}
