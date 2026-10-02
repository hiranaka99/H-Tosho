import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BookOpen, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui';
import { toast } from '../lib/toast';

export function LibraryOwnershipNotice() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['library-ownership'], queryFn: api.libraryOwnership,
    refetchInterval: q => q.state.data?.configured === false ? false : q.state.data?.checking ? 2000 : 10_000 });
  const refresh = useMutation({ mutationFn: api.refreshLibraryOwnership, onSuccess: async result => {
    qc.setQueryData(['library-ownership'], result);
    await Promise.all([qc.invalidateQueries({ queryKey: ['doujin-search'] }), qc.invalidateQueries({ queryKey: ['doujin-gallery'] }), qc.invalidateQueries({ queryKey: ['recommendations'] })]);
    if (!result.complete) toast({ tone: 'danger', title: 'Library check incomplete', description: result.error ?? 'Check the Kavita connection.' });
  }, onError: error => toast({ tone: 'danger', title: 'Could not check library ownership', description: error.message }) });
  const data = status.data;
  if (!data?.configured) return null;
  const checking = refresh.isPending || data.checking;
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
    <p role="status" className={`flex min-w-0 items-start gap-2 text-xs ${data.error && !checking ? 'text-warning' : 'text-muted'}`}><BookOpen className="h-4 w-4 shrink-0" /><span>{checking ? `Checking Kavita ownership${data.total ? ` · ${data.scanned} / ${data.total} series` : '…'}` : data.error ?? (data.complete ? `Library ownership checked · ${data.scanned} series` : 'Library ownership will be checked before downloading.')}</span></p>
    <div className="flex shrink-0 gap-2">{data.error && <Button asChild variant="ghost" size="sm"><Link to="/settings?tab=general#kavita-connection">Check connection</Link></Button>}<Button variant="ghost" size="sm" disabled={checking} onClick={() => refresh.mutate()}><RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} /> Check library</Button></div>
  </div>;
}
