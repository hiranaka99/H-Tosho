import * as React from 'react';
import { Copy, Sparkles } from 'lucide-react';
import { api, type DuplicateCheck, type DoujinSource } from '../lib/api';
import { Button, Badge } from './ui';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog';
import { sourceDisplayName } from '../lib/utils';

export function useDuplicateReview() {
  const [review, setReview] = React.useState<DuplicateCheck | null>(null);
  const resolveRef = React.useRef<((keys: Set<string> | null) => void) | null>(null);
  const finish = React.useCallback((approve: boolean) => {
    const keys = approve ? new Set(review?.reports.filter(report => report.matches.length).map(report => `${report.source}:${report.galleryId}`)) : null;
    resolveRef.current?.(keys);
    resolveRef.current = null;
    setReview(null);
  }, [review]);
  React.useEffect(() => () => { resolveRef.current?.(null); }, []);
  const reviewCheck = React.useCallback((check: DuplicateCheck): Promise<Set<string> | null> => {
    if (!check.reports.some(report => report.matches.length)) return Promise.resolve(new Set());
    // A new request never leaves an older confirmation waiting indefinitely.
    resolveRef.current?.(null);
    setReview(check);
    return new Promise(resolve => { resolveRef.current = resolve; });
  }, []);
  const checkDuplicates = React.useCallback(async (items: { source: DoujinSource; galleryId: string; url?: string }[]) => {
    if (!items.length) return new Set<string>();
    return reviewCheck(await api.checkDuplicates(items.map(({ source, galleryId, url }) => ({ source, galleryId, ...(url ? { url } : {}) }))));
  }, [reviewCheck]);
  // Only earlier editions matched: this is an upgrade, not a duplicate.
  const upgrade = !!review && review.reports.filter(report => report.matches.length).every(report => report.matches.every(match => match.betterEdition));
  const dialog = review && <Dialog open onOpenChange={open => { if (!open) finish(false); }}>
    <DialogContent className="max-w-xl">
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="shrink-0 space-y-2 border-b border-border p-4 pr-12 sm:p-5 sm:pr-12">
          {upgrade ? <>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 shrink-0 text-primary" />Better edition available</DialogTitle>
            <DialogDescription>You own an earlier edition. This one is marked uncensored or decensored. Your current copy stays where it is; remove it yourself if you no longer want it.</DialogDescription>
          </> : <>
            <DialogTitle className="flex items-center gap-2"><Copy className="h-5 w-5 shrink-0 text-warning" />Possible duplicates</DialogTitle>
            <DialogDescription>Review matching copies before downloading.</DialogDescription>
          </>}
        </div>
        <div className="min-h-0 space-y-5 overflow-y-auto p-4 sm:p-5">
          {review.reports.filter(report => report.matches.length).map(report => <section key={`${report.source}:${report.galleryId}`} className="space-y-2">
            <h3 className="break-words font-sans text-sm font-semibold">{report.title}</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {report.matches.map(match => <li key={`${match.source}:${match.galleryId}`} className="space-y-1.5 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words font-medium">{match.title}</span>{match.betterEdition && <Badge tone="default">Earlier edition</Badge>}<Badge tone="muted">{sourceDisplayName(match.source)} · {match.status}</Badge></div>
                <p className="break-words text-xs text-muted">{match.artists.join(', ')}{match.language ? ` · ${match.language}` : ''}{match.pageCount ? ` · ${match.pageCount} pages` : ''}</p>
                <p className="text-xs text-muted">{match.reasons.join(' · ')}</p>
                {match.path && <p className="break-all text-xs text-muted">{match.path}</p>}
              </li>)}
            </ul>
          </section>)}
          {!!review.warnings.length && <div role="alert" className="space-y-1 text-xs text-warning"><p className="font-medium">Some files could not be checked.</p>{review.warnings.map(warning => <p key={warning} className="break-words">{warning}</p>)}</div>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={() => finish(false)}>Cancel</Button>
          <Button onClick={() => finish(true)}>{upgrade ? 'Download better edition' : 'Download anyway'}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
  return { checkDuplicates, reviewCheck, dialog };
}
