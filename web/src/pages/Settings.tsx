import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Server, SlidersHorizontal, Bell, Timer, CheckCircle2, XCircle, Loader2, Save, Download, X, Plus, Star, ArrowUp, ArrowDown, LockKeyhole } from 'lucide-react';
import { api, type Settings as SettingsType, type ProviderInfo, type DownloaderSettings, type DoujinSource } from '../lib/api';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch, Badge, PageHeader, ErrorState, SegmentedTabs } from '../components/ui';
import { cn, timeAgo } from '../lib/utils';
import { toast } from '../lib/toast';
import { useAuth } from '../lib/AuthContext';

type Notif = SettingsType['notifications'];
const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'downloader', label: 'Downloader' },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

function SectionHeader({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <CardHeader className="flex-row items-center justify-between">
      <CardTitle className="flex items-center gap-2">
        {icon} {title}
      </CardTitle>
      {children}
    </CardHeader>
  );
}

function SaveButton({ label = 'Save', ...props }: { label?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button size="sm" {...props}>
      <Save className="h-3.5 w-3.5" /> {label}
    </Button>
  );
}

function useFlash(on?: () => void) {
  const [saved, setSaved] = React.useState(false);
  const flash = React.useCallback(() => {
    on?.();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }, [on]);
  return { saved, flash };
}

function AccountSettingsCard() {
  const auth = useAuth();
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [username, setUsername] = React.useState(auth.username ?? '');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const change = useMutation({
    mutationFn: () => api.changeCredentials(currentPassword, username, password),
    onSuccess: async () => {
      setCurrentPassword('');
      setPassword('');
      setConfirmPassword('');
      setError('');
      await auth.refresh();
      toast({ tone: 'success', title: 'Account updated' });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setError('');
    change.mutate();
  };
  return (
    <Card className="animate-fade-up">
      <SectionHeader icon={<LockKeyhole className="h-4 w-4" />} title="Account security" />
      <CardContent>
        <form className="flex max-w-xl flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1"><Label htmlFor="account-username">Username</Label><Input id="account-username" autoComplete="username" required maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} /></div>
          <div className="flex flex-col gap-1"><Label htmlFor="current-password">Current password</Label><Input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
            <div className="flex flex-col gap-1"><Label htmlFor="confirm-new-password">Confirm new password</Label><Input id="confirm-new-password" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></div>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" className="self-start" disabled={change.isPending || !username.trim() || password.length < 8 || confirmPassword.length < 8}>
            {change.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Update account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const kavita = useQuery({ queryKey: ['kavita-status'], queryFn: api.kavitaStatus });
  const s = settings.data;
  const provs = providers.data ?? [];

  const invalidate = (key: string) => () => qc.invalidateQueries({ queryKey: [key] });
  const conn = React.useState({ baseUrl: '', apiKey: '' });
  // Hydrate the stored base URL on load / after save. The auth key is never
  // returned by the server — a set key is shown as "Set" in the placeholder.
  React.useEffect(() => {
    if (kavita?.data) conn[1]((prev) => ({ ...prev, baseUrl: kavita.data.baseUrl ?? '' }));
  }, [kavita?.data]);
  const [kavitaMsg, setKavitaMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const kavitaSave = useMutation({
    mutationFn: api.saveConnection,
    onSuccess: (res) => {
      invalidate('kavita-status')();
      setKavitaMsg({ ok: res.connected, text: res.test });
    },
    onError: (error) => setKavitaMsg({ ok: false, text: error instanceof Error ? error.message : String(error) }),
  });

  const [order, setOrder] = React.useState<string[]>([]);
  const dragIndex = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (s) setOrder(s.priorities);
  }, [s?.priorities]);
  const savePriorities = useMutation({ mutationFn: api.savePriorities, onSuccess: invalidate('settings'), onError: (error) => toast({ tone: 'danger', title: 'Could not save provider priority', description: error instanceof Error ? error.message : String(error) }) });
  const onDrop = (to: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === to) return;
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const moveProvider = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const [notif, setNotif] = React.useState<Notif>({ discord: { enabled: false, webhookUrl: '' } });
  React.useEffect(() => {
    if (s) setNotif(s.notifications);
  }, [s?.notifications]);
  const notifFlash = useFlash(invalidate('settings'));
  const saveNotif = useMutation({ mutationFn: api.saveNotifications, onSuccess: notifFlash.flash, onError: (error) => toast({ tone: 'danger', title: 'Could not save notifications', description: error instanceof Error ? error.message : String(error) }) });
  const [notifMsg, setNotifMsg] = React.useState<{ discord: string } | null>(null);
  const testNotif = useMutation({ mutationFn: api.testNotifications, onSuccess: (r) => setNotifMsg(r), onError: (error) => toast({ tone: 'danger', title: 'Notification test failed', description: error instanceof Error ? error.message : String(error) }) });

  const [poll, setPoll] = React.useState('12');
  React.useEffect(() => {
    if (s) setPoll(String(s.pollIntervalHours));
  }, [s?.pollIntervalHours]);
  const pollFlash = useFlash(invalidate('settings'));
  const savePoll = useMutation({ mutationFn: () => api.savePollInterval(Number(poll)), onSuccess: pollFlash.flash, onError: (error) => toast({ tone: 'danger', title: 'Could not save scan interval', description: error instanceof Error ? error.message : String(error) }) });
  const [tab, setTab] = React.useState<SettingsTab>('general');

  if (settings.isError) {
    return <ErrorState title="Could not load settings" description={settings.error instanceof Error ? settings.error.message : String(settings.error)} onRetry={() => void settings.refetch()} />;
  }
  if (!s) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon={<SlidersHorizontal className="h-5 w-5" />} title="Settings" subtitle="Connect Kavita, configure providers and notifications." />
      <SegmentedTabs items={SETTINGS_TABS} value={tab} onChange={setTab} label="Settings sections" className="self-start" />

      {tab === 'general' && (<>
      <AccountSettingsCard />
      <Card className="animate-fade-up">
        <SectionHeader icon={<Server className="h-4 w-4" />} title="Kavita connection">
          <Badge tone={kavita?.data?.configured && !kavita.data.error ? 'success' : kavita?.data?.configured ? 'danger' : 'muted'}>
            {kavita?.data?.configured
              ? kavita.data.error
                ? 'Connection error'
                : `Connected · server v${kavita.data.version} · API ${kavita.data.apiVersion}`
              : 'Not configured'}
          </Badge>
        </SectionHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="kavita-base-url">Base URL</Label>
              <Input id="kavita-base-url" value={conn[0].baseUrl} onChange={(e) => conn[1]({ ...conn[0], baseUrl: e.target.value })} placeholder="http://kavita:5000" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="kavita-auth-key">Auth Key</Label>
              <Input id="kavita-auth-key" type="password" value={conn[0].apiKey} onChange={(e) => conn[1]({ ...conn[0], apiKey: e.target.value })} placeholder={kavita?.data?.hasApiKey ? 'Set' : 'your Kavita Auth Key'} />
            </div>
          </div>
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Button onClick={() => kavitaSave.mutate(conn[0])} disabled={kavitaSave.isPending || !conn[0].baseUrl}>
              {kavitaSave.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />} Save & test connection
            </Button>
            {kavitaMsg && (
              <span role="status" className={cn('flex items-center gap-1 text-sm', kavitaMsg.ok ? 'text-success' : 'text-danger')}>
                {kavitaMsg.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{kavitaMsg.text}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      <Card className="animate-fade-up" style={{ animationDelay: '60ms' }}>
        <SectionHeader icon={<Timer className="h-4 w-4" />} title="Auto-scan interval">
          <SaveButton label={pollFlash.saved ? 'Saved' : 'Save'} onClick={() => savePoll.mutate()} disabled={savePoll.isPending || poll === '' || Number(poll) < 0} />
        </SectionHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input id="scan-interval" aria-label="Auto-scan interval in hours" type="number" min={0} value={poll} onChange={(e) => setPoll(e.target.value)} className="w-full sm:w-28" />
          <span className="text-sm text-muted">hours between background scans for newly ingested series (0 disables)</span>
        </CardContent>
      </Card>
      </>)
      }

      {tab === 'providers' && (
      <Card className="animate-fade-up">
        <SectionHeader icon={<SlidersHorizontal className="h-4 w-4" />} title="Metadata providers">
          <SaveButton label="Save priority" onClick={() => savePriorities.mutate(order)} disabled={savePriorities.isPending} />
        </SectionHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted">Drag to reorder or use the arrow buttons. Providers are searched top-to-bottom; the first confident match wins.</p>
          <div className="flex flex-col gap-2">
            {order.map((id, idx) => {
              const p = provs.find((x) => x.id === id);
              if (!p) return null;
              return (
                <div
                  key={id}
                  draggable
                  onDragStart={() => (dragIndex.current = idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(idx)}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-2 transition-colors hover:border-border-2"
                >
                  <GripVertical className="hidden h-4 w-4 shrink-0 cursor-grab text-muted active:cursor-grabbing sm:block" aria-hidden="true" />
                  <span className="w-6 text-center text-xs text-muted">{idx + 1}</span>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  <div className="flex items-center gap-1">
                    <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Move ${p.name} up`} disabled={idx === 0} onClick={() => moveProvider(idx, idx - 1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Move ${p.name} down`} disabled={idx === order.length - 1} onClick={() => moveProvider(idx, idx + 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                    <Switch aria-label={`Enable ${p.name}`} checked={p.enabled} onCheckedChange={(c) => api.saveProvider(p.id, { enabled: c }).then(invalidate('providers')).catch((error) => toast({ tone: 'danger', title: `Could not update ${p.name}`, description: error instanceof Error ? error.message : String(error) }))} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted">Credentials & testing</p>
            {provs.map((p) => (
              <ProviderCreds key={p.id} provider={p} onChanged={invalidate('providers')} />
            ))}
          </div>
        </CardContent>
      </Card>
      )}

      {tab === 'notifications' && (

      <Card className="animate-fade-up">
        <SectionHeader icon={<Bell className="h-4 w-4" />} title="Notifications">
          <div className="flex items-center gap-2">
            <SaveButton label={notifFlash.saved ? 'Saved' : 'Save'} onClick={() => saveNotif.mutate(notif)} disabled={saveNotif.isPending} />
            <Button size="sm" variant="outline" onClick={() => testNotif.mutate()} disabled={testNotif.isPending}>
              Test
            </Button>
          </div>
        </SectionHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="discord-webhook">Discord webhook</Label>
              <Switch aria-label="Enable Discord notifications" checked={notif.discord.enabled} onCheckedChange={(c) => setNotif((n) => ({ ...n, discord: { ...n.discord, enabled: c } }))} />
            </div>
            <Input id="discord-webhook" value={notif.discord.webhookUrl} onChange={(e) => setNotif((n) => ({ ...n, discord: { ...n.discord, webhookUrl: e.target.value } }))} placeholder="https://discord.com/api/webhooks/…" />
          </div>
          {notifMsg && (
            <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-3 text-xs">
              <span className={notifMsg.discord === 'ok' ? 'text-success' : 'text-danger'}>Discord: {notifMsg.discord}</span>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {tab === 'downloader' && (
        <>
          <DownloaderSettingsCard />
          <WatchedSearchesCard />
        </>
      )}
    </div>
  );
}

/** Tag list editor for nHentai banned tags. Enter adds a tag; comma-separated input adds several at once. */
function BannedTagsEditor({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = React.useState('');
  const addTag = () => {
    const parts = draft.split(',').map((s) => s.trim().replace(/^"+|"+$/g, '')).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const part of parts) if (!next.some((value) => value.toLowerCase() === part.toLowerCase())) next.push(part);
    onChange(next);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="banned-tags">nHentai banned tags</Label>
      <p className="text-sm text-muted">Galleries carrying any of these tags never appear in nHentai searches. Separate multiple tags with commas.</p>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 py-1">
          {value.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
              {tag}
              <button type="button" onClick={() => onChange(value.filter((value) => value !== tag))} className="flex h-6 w-6 items-center justify-center rounded hover:bg-danger/30" aria-label={`Remove ${tag}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input id="banned-tags" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} placeholder="e.g. loli, big breasts, nsfw" className="flex-1" />
        <Button size="sm" variant="outline" onClick={addTag} disabled={!draft.trim()}><Plus className="h-3.5 w-3.5" /> Add</Button>
      </div>
    </div>
  );
}

function DownloaderSettingsCard() {
  const qc = useQueryClient();
  const dl = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  const [dlSettings, setDlSettings] = React.useState<DownloaderSettings | null>(null);
  React.useEffect(() => { if (dl.data) setDlSettings(dl.data); }, [dl.data]);
  const flash = useFlash(() => qc.invalidateQueries({ queryKey: ['downloader-settings'] }));
  const save = useMutation({
    mutationFn: (settings: DownloaderSettings) => api.saveDownloaderSettings(settings),
    onSuccess: (result) => { setDlSettings(result.settings); flash.flash(); },
    onError: (error) => toast({ title: 'Failed to save downloader settings', description: error instanceof Error ? error.message : String(error), tone: 'danger' }),
  });

  if (dl.isError) return <Card><ErrorState title="Could not load downloader settings" description={dl.error instanceof Error ? dl.error.message : String(dl.error)} onRetry={() => void dl.refetch()} /></Card>;
  if (!dlSettings) return <Card><SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader" /><CardContent className="flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</CardContent></Card>;

  return (
    <Card className="animate-fade-up">
      <SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader">
        <SaveButton label={flash.saved ? 'Saved' : 'Save'} onClick={() => save.mutate(dlSettings)} disabled={save.isPending} />
      </SectionHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1"><Label htmlFor="download-directory">Output folder</Label><Input id="download-directory" value={dlSettings.downloadDirectory} onChange={(e) => setDlSettings({ ...dlSettings, downloadDirectory: e.target.value })} placeholder="/path/to/kavita/library or /downloads" /><p className="text-sm text-muted">Absolute path on this machine. Point it at a Kavita library folder to have new media picked up automatically.</p></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1"><Label htmlFor="download-format">Output format</Label><Select id="download-format" value={dlSettings.format} onChange={(e) => setDlSettings({ ...dlSettings, format: e.target.value as 'cbz' | 'folder' })}><option value="cbz">Compressed .cbz archive (recommended)</option><option value="folder">Raw image folder</option></Select></div>
          <div className="flex flex-col gap-1"><Label htmlFor="download-concurrency">Max concurrent downloads</Label><Input id="download-concurrency" type="number" min={1} max={10} value={dlSettings.maxConcurrentDownloads} onChange={(e) => setDlSettings({ ...dlSettings, maxConcurrentDownloads: Math.max(1, Number(e.target.value) || 1) })} /></div>
          <div className="flex flex-col gap-1"><Label htmlFor="image-concurrency">Max image concurrency</Label><Input id="image-concurrency" type="number" min={1} max={20} value={dlSettings.maxImageConcurrency} onChange={(e) => setDlSettings({ ...dlSettings, maxImageConcurrency: Math.max(1, Number(e.target.value) || 1) })} /></div>
          <div className="flex flex-col gap-1"><Label htmlFor="request-delay">Request delay (ms)</Label><Input id="request-delay" type="number" min={0} step={50} value={dlSettings.requestDelayMs} onChange={(e) => setDlSettings({ ...dlSettings, requestDelayMs: Math.max(0, Number(e.target.value) || 0) })} /></div>
        </div>
        <div className="flex flex-col gap-1"><Label htmlFor="nhentai-api-key">nHentai API key</Label><Input id="nhentai-api-key" type="password" value={dlSettings.nhentaiApiKey} onChange={(e) => setDlSettings({ ...dlSettings, nhentaiApiKey: e.target.value })} placeholder="optional — NHENTAI_API_KEY env var is used as a fallback" autoComplete="off" /><p className="text-sm text-muted">Optional key from nhentai.net for higher API rate limits. Leave blank to use the NHENTAI_API_KEY environment variable, if set.</p></div>
        <BannedTagsEditor value={dlSettings.nhentaiBannedTags ?? []} onChange={(tags) => setDlSettings({ ...dlSettings, nhentaiBannedTags: tags })} />
        <div className="flex items-center justify-between rounded-md border border-border bg-surface-2 p-3"><div><p className="text-sm">Auto-sync Kavita</p><p className="text-sm text-muted">Trigger a library scan in Kavita after each download completes.</p></div><Switch aria-label="Auto-sync Kavita after downloads" checked={dlSettings.autoSyncKavita} onCheckedChange={(checked) => setDlSettings({ ...dlSettings, autoSyncKavita: checked })} /></div>
      </CardContent>
    </Card>
  );
}

const WATCH_SOURCE_LABELS: Record<DoujinSource, string> = { hitomi: 'Hitomi', nhentai: 'nHentai' };

function WatchedSearchesCard() {
  const qc = useQueryClient();
  const watchesQuery = useQuery({ queryKey: ['watched-searches'], queryFn: api.watchedSearches, refetchInterval: 30_000 });
  const watches = watchesQuery.data;
  const [source, setSource] = React.useState<DoujinSource>('hitomi');
  const [query, setQuery] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  async function add() {
    const q = query.trim();
    if (!q) return;
    setAdding(true);
    try {
      await api.addWatchedSearch(source, q);
      setQuery('');
      qc.invalidateQueries({ queryKey: ['watched-searches'] });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not add watch', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.removeWatchedSearch(id);
      qc.invalidateQueries({ queryKey: ['watched-searches'] });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not remove watch', description: e instanceof Error ? e.message : String(e) });
    }
  }
  async function checkNow() {
    setChecking(true);
    try {
      await api.checkWatchedSearches();
      toast({ tone: 'success', title: 'Check queued', description: 'Results land in the job log; new galleries ping Discord.' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not queue check', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="animate-fade-up" style={{ animationDelay: '60ms' }}>
      <SectionHeader icon={<Star className="h-4 w-4" />} title="Watched searches">
        <Button size="sm" variant="outline" onClick={checkNow} disabled={checking}>
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />} Check now
        </Button>
      </SectionHeader>
      <CardContent className="flex flex-col gap-3">
        {watchesQuery.isError && <ErrorState title="Could not load watched searches" description={watchesQuery.error instanceof Error ? watchesQuery.error.message : String(watchesQuery.error)} onRetry={() => void watchesQuery.refetch()} />}
        <p className="text-sm text-muted">Saved doujinshi searches re-run on every auto-scan cycle. New results ping Discord — the first run just records what already exists.</p>
        {watches && watches.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {watches.map((w) => (
              <div key={w.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border-2 px-3 py-2 text-xs">
                <Badge tone="muted">{WATCH_SOURCE_LABELS[w.source] ?? w.source}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium" title={w.query}>{w.query}</span>
                <span className="w-full text-muted sm:w-auto sm:shrink-0">{w.lastCheckedAt ? `checked ${timeAgo(w.lastCheckedAt)}` : 'not checked yet'} · {w.seenCount} seen</span>
                <Button size="icon" variant="ghost" aria-label={`Remove watch ${w.query}`} onClick={() => void remove(w.id)}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
          </div>
        ) : (
          watches && <p className="text-sm text-muted">No watched searches yet — add one below, or use the Watch button in the Downloader.</p>
        )}
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Select aria-label="Watched search source" value={source} onChange={(e) => setSource(e.target.value as DoujinSource)} className="sm:w-32 sm:shrink-0"><option value="hitomi">Hitomi</option><option value="nhentai">nHentai</option></Select>
          <Input aria-label="Watched search query" placeholder="Search query, e.g. artist:konboi" value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1" />
          <Button size="sm" type="submit" disabled={adding || !query.trim()}>{adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ProviderCreds({ provider, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  const [creds, setCreds] = React.useState<Record<string, string>>(provider.credentials ?? {});
  const test = useMutation({ mutationFn: () => api.testProvider(provider.id), onSuccess: (r) => setTestMsg(r) });
  const [testMsg, setTestMsg] = React.useState<{ ok: boolean; error?: string } | null>(null);
  const [saved, setSaved] = React.useState(false);
  const hasFields = provider.credentialFields.length > 0;

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: provider.color }} />
        <span className="text-sm font-medium">{provider.name}</span>
        <span className="text-xs text-muted">{provider.requiresCredentials ? (provider.hasCredentials ? 'configured' : 'needs credentials') : 'no credentials required'}</span>
        <span className="flex-1" />
        {hasFields && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await api.saveProvider(provider.id, { credentials: creds });
                onChanged();
                setSaved(true);
                window.setTimeout(() => setSaved(false), 1500);
              } catch (error) {
                toast({ tone: 'danger', title: `Could not save ${provider.name} credentials`, description: error instanceof Error ? error.message : String(error) });
              }
            }}
          >
            {saved ? 'Saved' : 'Save creds'}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Test connection
        </Button>
        {testMsg && (
          <span className={cn('flex items-center gap-1 text-xs', testMsg.ok ? 'text-success' : 'text-danger')}>
            {testMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {testMsg.ok ? 'OK' : testMsg.error}
          </span>
        )}
      </div>
      {hasFields && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {provider.credentialFields.map((cf) => (
            <div key={cf.key} className="flex flex-col gap-1">
              <Label htmlFor={`provider-${provider.id}-${cf.key}`}>{cf.label}</Label>
              <Input id={`provider-${provider.id}-${cf.key}`} value={creds[cf.key] ?? ''} onChange={(e) => setCreds((prev) => ({ ...prev, [cf.key]: e.target.value }))} placeholder={cf.label} />
            </div>
          ))}
        </div>
      )}
      {provider.helpUrl && (
        <a href={provider.helpUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">
          How to get credentials →
        </a>
      )}
    </div>
  );
}