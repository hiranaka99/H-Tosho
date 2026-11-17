import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ArrowDown, Loader2, Plus, Pencil, Trash2 } from 'lucide-react';
import { FOLLOWING_INTERVAL_MINUTES, type FollowingInterval, type WatchedSearch, type WatchedSearchFolder } from '../../../../server/src/contracts/following';
import type { NotificationMode } from '../../../../server/src/contracts/followingDelivery';
import { api, ApiError } from '../../lib/api';
import { Button, ConfirmDialog, Input, Select } from '../../components/ui';

export function cadenceLabel(minutes: number): string {
  if (minutes === 0) return 'Off';
  if (minutes < 60) return `${minutes} min`;
  return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
}

export function WatchEditor({ watch, folders, foldersReady, globalInterval, onClose, onRefresh }: {
  watch: WatchedSearch; folders: WatchedSearchFolder[]; foldersReady: boolean; globalInterval: number;
  onClose: () => void; onRefresh: () => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [name, setName] = React.useState(watch.displayName ?? '');
  const [folder, setFolder] = React.useState(watch.folderId === null ? '' : String(watch.folderId));
  const [interval, setInterval] = React.useState(watch.intervalMinutes === null ? '' : String(watch.intervalMinutes));
  const [notificationMode, setNotificationMode] = React.useState<NotificationMode>(watch.notificationMode);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [conflictRevision, setConflictRevision] = React.useState<number | null>(null);
  const stale = conflictRevision !== null && watch.revision === conflictRevision;
  const selectedFolderExists = !folder || folders.some(item => String(item.id) === folder);
  const id = React.useId();
  const nameInvalid = name.trim().length > 120;
  async function save() {
    if (pending || stale || nameInvalid || !selectedFolderExists || !foldersReady) return;
    setPending(true);
    setError('');
    try {
      await api.updateWatchedSearch(watch.id, {
        expectedRevision: watch.revision, displayName: name.trim() || null,
        folderId: folder ? Number(folder) : null,
        intervalMinutes: interval ? Number(interval) as FollowingInterval : null,
        notificationMode,
      });
      await Promise.all([onRefresh(), qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] })]);
      if (mounted.current) onClose();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setConflictRevision(watch.revision);
        setError('This watch changed elsewhere. Your draft is kept. Review the latest saved values below, then save again.');
        await onRefresh();
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (failure instanceof ApiError && failure.status === 404) await onRefresh();
      }
    } finally { setPending(false); }
  }
  return <form aria-label={`Edit watch ${watch.displayName ?? watch.query}`} onSubmit={event => { event.preventDefault(); void save(); }} className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_12rem]">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">Watch name
        <Input autoFocus aria-label="Watch name" className="h-11" value={name} onChange={event => setName(event.target.value)} disabled={pending} maxLength={120} placeholder={watch.query} aria-describedby={`${id}-name-hint`} aria-invalid={nameInvalid} />
        <span id={`${id}-name-hint`}>Leave blank to use the original query.</span>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">Folder
        <Select aria-label="Folder" className="h-11" value={folder} onChange={event => setFolder(event.target.value)} disabled={pending || !foldersReady}>
          <option value="">Unfiled</option>
          {!selectedFolderExists && <option value={folder}>Folder removed — choose another</option>}
          {folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">Check cadence
        <Select aria-label="Check cadence" className="h-11" value={interval} onChange={event => setInterval(event.target.value)} disabled={pending}>
          <option value="">Inherit default ({cadenceLabel(globalInterval)})</option>
          {FOLLOWING_INTERVAL_MINUTES.map(minutes => <option key={minutes} value={minutes}>{cadenceLabel(minutes)}</option>)}
        </Select>
      </label>
    </div>
    <label className="flex flex-col gap-1 text-xs text-muted">Notification delivery
      <Select aria-label="Notification delivery" className="min-h-11 sm:max-w-xs" value={notificationMode} onChange={event => setNotificationMode(event.target.value as NotificationMode)} disabled={pending}>
        <option value="in-app">In-app only</option><option value="immediate">Immediate Discord</option><option value="digest">Daily digest</option>
      </Select>
      <span>Finds always stay in Following. Discord also requires global enablement. Changing this preference does not send old finds.</span>
    </label>
    {globalInterval === 0 && <p className="text-xs text-muted">Automatic checks are off globally, including custom cadences. Check once is still available.</p>}
    {error && <div role="alert" className="flex flex-col gap-1 text-sm text-danger"><p>{error}</p>
      {conflictRevision !== null && <p className="break-words text-xs text-muted">Latest saved: {watch.displayName ?? watch.query} · {folders.find(item => item.id === watch.folderId)?.name ?? 'Unfiled'} · {watch.intervalMinutes === null ? 'Inherited cadence' : cadenceLabel(watch.intervalMinutes)} · {watch.pausedAt ? 'Paused' : 'Active'}</p>}
      {stale && <Button type="button" size="sm" variant="outline" className="min-h-11 self-start" onClick={() => void onRefresh()}>Reload latest watch</Button>}
    </div>}
    {!selectedFolderExists && <p role="alert" className="text-xs text-danger">The selected folder no longer exists. Choose a folder or Unfiled before saving.</p>}
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" size="sm" type="submit" disabled={pending || stale || nameInvalid || !selectedFolderExists || !foldersReady}>{pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save watch</Button>
      <Button className="min-h-11" size="sm" variant="ghost" type="button" disabled={pending} onClick={onClose}>Cancel edit</Button>
    </div>
  </form>;
}

export function FollowingFolders({ folders, onRefresh }: { folders: WatchedSearchFolder[]; onRefresh: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [editing, setEditing] = React.useState<number | null>(null);
  const [editName, setEditName] = React.useState('');
  const [removeTarget, setRemoveTarget] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [conflicted, setConflicted] = React.useState<{ id: number; revision: number } | null>(null);
  const stale = conflicted !== null && folders.some(folder => folder.id === conflicted.id && folder.revision === conflicted.revision);
  const target = folders.find(folder => folder.id === removeTarget);
  const id = React.useId();
  async function mutate(action: () => Promise<unknown>, folder?: WatchedSearchFolder): Promise<boolean> {
    if (pending || stale) return false;
    setPending(true);
    setError('');
    try {
      await action();
      await Promise.all([onRefresh(), qc.invalidateQueries({ queryKey: ['watched-searches'] }), qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] })]);
      setConflicted(null);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        if (folder) setConflicted({ id: folder.id, revision: folder.revision });
        setError('A folder changed elsewhere. Drafts kept; the latest folder list has been requested. Review it and try again.');
        await onRefresh();
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (failure instanceof ApiError && failure.status === 404) await onRefresh();
      }
      return false;
    } finally { setPending(false); }
  }
  async function move(folder: WatchedSearchFolder, direction: -1 | 1) {
    const index = folders.findIndex(item => item.id === folder.id);
    const neighbor = folders[index + direction];
    if (!neighbor) return;
    await mutate(() => api.updateWatchedSearchFolder(folder.id, { expectedRevision: folder.revision, position: index + direction }), folder);
  }
  return <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3 border-t border-border pt-4">
    <div><h3 id={`${id}-heading`} className="text-sm font-semibold">Folders</h3><p className="mt-1 text-xs text-muted">Organize watches without changing their searches or saved discoveries.</p></div>
    <form aria-label="Add a watch folder" onSubmit={event => { event.preventDefault(); if (name.trim()) void mutate(() => api.addWatchedSearchFolder(name.trim())).then(saved => { if (saved) setName(''); }); }} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">New folder name<Input className="h-11" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={pending} /></label>
      <Button className="min-h-11 shrink-0" size="sm" type="submit" disabled={pending || stale || !name.trim()}><Plus className="h-3.5 w-3.5" />Add folder</Button>
    </form>
    {error && <div role="alert" className="flex flex-col gap-2 text-sm text-danger"><p>{error}</p>{stale && <Button size="sm" variant="outline" className="min-h-11 self-start" onClick={() => void onRefresh()}>Reload folders</Button>}</div>}
    {folders.length ? <ul className="divide-y divide-border">
      {folders.map((folder, index) => <li key={folder.id} className="py-2">
        {editing === folder.id ? <form aria-label={`Rename folder ${folder.name}`} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center" onSubmit={event => { event.preventDefault(); if (editName.trim()) void mutate(() => api.updateWatchedSearchFolder(folder.id, { expectedRevision: folder.revision, name: editName.trim() }), folder).then(saved => { if (saved) setEditing(null); }); }}>
          <label className="min-w-0 flex-1 text-xs text-muted">Folder name<Input autoFocus className="mt-1 h-11" maxLength={120} value={editName} onChange={event => setEditName(event.target.value)} disabled={pending} /></label>
          <div className="flex gap-2"><Button size="sm" className="min-h-11" type="submit" disabled={pending || stale || !editName.trim()}>Save folder</Button><Button size="sm" variant="ghost" className="min-h-11" type="button" disabled={pending} onClick={() => setEditing(null)}>Cancel rename</Button></div>
        </form> : <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-words text-sm">{folder.name}</span>
          <div className="flex shrink-0 gap-1">
            <Button size="icon" variant="ghost" className="h-11 w-11" disabled={pending || stale || index === 0} aria-label={`Move folder ${folder.name} up`} onClick={() => void move(folder, -1)}><ArrowUp className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" className="h-11 w-11" disabled={pending || stale || index === folders.length - 1} aria-label={`Move folder ${folder.name} down`} onClick={() => void move(folder, 1)}><ArrowDown className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" className="h-11 w-11" disabled={pending} aria-label={`Rename folder ${folder.name}`} onClick={() => { setEditing(folder.id); setEditName(folder.name); }}><Pencil className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" className="h-11 w-11" disabled={pending} aria-label={`Delete folder ${folder.name}`} onClick={() => setRemoveTarget(folder.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        </div>}
      </li>)}
    </ul> : <p className="text-sm text-muted">No folders yet. Watches stay in Unfiled until you assign one.</p>}
    <ConfirmDialog open={removeTarget !== null} title="Delete watch folder?" description={target ? `Delete “${target.name}”? Its watches move to Unfiled. Discoveries and review history are kept.` : 'This folder no longer exists. Close this dialog to continue.'} details={error ? <p role="alert" className="break-words text-sm text-danger">{error}</p> : undefined} confirmLabel={stale ? 'Reload folders' : 'Delete folder'} pending={pending} onOpenChange={open => { if (!open && !pending) setRemoveTarget(null); }} onConfirm={() => { if (stale) void onRefresh(); else if (target && !pending) void mutate(() => api.removeWatchedSearchFolder(target.id, target.revision), target).then(saved => { if (saved) setRemoveTarget(null); }); else if (!target) setRemoveTarget(null); }} />
  </section>;
}
