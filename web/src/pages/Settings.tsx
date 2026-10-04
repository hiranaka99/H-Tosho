import * as React from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Server, SlidersHorizontal, Bell, Timer, CheckCircle2, XCircle, Loader2, Save, Download, X, Plus, ArrowUp, ArrowDown, LockKeyhole, Monitor, Moon, Sun, Palette } from 'lucide-react';
import { api, type Settings as SettingsType, type ProviderInfo, type DownloaderSettings, type LibraryPathMapping } from '../lib/api';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch, Badge, PageHeader, ErrorState, SegmentedTabs, SegmentedControl, TabPanel, Disclosure } from '../components/ui';
import { cn, timeAgo } from '../lib/utils';
import { toast } from '../lib/toast';
import { useAuth } from '../lib/AuthContext';
import { useTheme, type Theme } from '../lib/theme';
import { DraftFeedback, useSettingsDraft } from '../lib/SettingsDrafts';

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
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
      <CardTitle className="flex min-w-0 items-center gap-2">
        {icon} <span className="break-words">{title}</span>
      </CardTitle>
      {children ? <div className="flex flex-wrap items-center justify-end gap-2">{children}</div> : null}
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


function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  const options: { id: Theme; label: string; icon: typeof Monitor }[] = [
    { id: 'system', label: 'System', icon: Monitor },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
  ];
  return (
    <Card className="animate-fade-up">
      <SectionHeader icon={<Palette className="h-4 w-4" />} title="Appearance" />
      <CardContent>
        <SegmentedControl items={options.map((option) => ({ id: option.id, label: option.label, icon: <option.icon className="h-4 w-4 shrink-0" /> }))} value={theme} onChange={setTheme} label="Theme" itemClassName="px-2 text-xs sm:px-3 sm:text-sm" />
        <p className="mt-2 text-sm text-muted">System follows your operating system's color scheme.</p>
      </CardContent>
    </Card>
  );
}

function AccountSettingsCard() {
  const auth = useAuth();
  const account = useSettingsDraft({
    id: 'account', label: 'Account security',
    initial: { currentPassword: '', username: auth.username ?? '', password: '', confirmPassword: '' },
    source: { currentPassword: '', username: auth.username ?? '', password: '', confirmPassword: '' },
    valid: (value) => Boolean(value.currentPassword && value.username.trim() && value.username.length <= 100 && value.password.length >= 8 && value.password === value.confirmPassword),
    save: async (value) => {
      await api.changeCredentials(value.currentPassword, value.username, value.password);
      await auth.refresh();
      return { currentPassword: '', username: value.username, password: '', confirmPassword: '' };
    },
  });
  const { currentPassword, username, password, confirmPassword } = account.value;
  const setCurrentPassword = (currentPassword: string) => account.setValue((value) => ({ ...value, currentPassword }));
  const setUsername = (username: string) => account.setValue((value) => ({ ...value, username }));
  const setPassword = (password: string) => account.setValue((value) => ({ ...value, password }));
  const setConfirmPassword = (confirmPassword: string) => account.setValue((value) => ({ ...value, confirmPassword }));
  const submit = (event: React.FormEvent) => { event.preventDefault(); account.submit(); };
  return (
    <Card className="animate-fade-up">
      <SectionHeader icon={<LockKeyhole className="h-4 w-4" />} title="Account security"><DraftFeedback draft={account} /></SectionHeader>
      <Disclosure label="Change credentials" summaryClassName="p-3 text-foreground sm:p-4">
        <CardContent>
          <form className="flex max-w-xl flex-col gap-3" onSubmit={submit}>
            <div className="flex flex-col gap-1"><Label htmlFor="account-username">Username</Label><Input id="account-username" autoComplete="username" required maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} /></div>
            <div className="flex flex-col gap-1"><Label htmlFor="current-password">Current password</Label><Input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
              <div className="flex flex-col gap-1"><Label htmlFor="confirm-new-password">Confirm new password</Label><Input id="confirm-new-password" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></div>
            </div>
            {password !== confirmPassword && <p role="alert" className="text-sm text-danger">Passwords do not match</p>}
            <Button type="submit" className="self-start" disabled={!account.canSave}>
              {account.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Update account
            </Button>
          </form>
        </CardContent>
      </Disclosure>
    </Card>
  );
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const kavita = useQuery({ queryKey: ['kavita-status'], queryFn: api.kavitaStatus });
  const s = settings.data;
  const provs = providers.data ?? [];

  const invalidate = (key: string) => () => qc.invalidateQueries({ queryKey: [key] });
  const [kavitaMsg, setKavitaMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const connection = useSettingsDraft({
    id: 'connection', label: 'Kavita connection', initial: { baseUrl: '', apiKey: '' },
    source: kavita.data ? { baseUrl: kavita.data.baseUrl ?? '', apiKey: '' } : undefined,
    valid: (value) => { try { return ['http:', 'https:'].includes(new URL(value.baseUrl).protocol); } catch { return false; } },
    save: async (value) => {
      const result = await api.saveConnection(value);
      if (!result.saved) throw new Error(result.test);
      qc.setQueryData(['kavita-status'], { ...kavita.data, baseUrl: value.baseUrl, configured: true, hasApiKey: Boolean(value.apiKey) || kavita.data?.hasApiKey });
      void qc.invalidateQueries({ queryKey: ['kavita-status'] });
      setKavitaMsg({ ok: result.connected, text: result.test });
      return { ...value, apiKey: '' };
    },
  });
  const conn = connection.value;
  const setConn = connection.setValue;
  const priorities = useSettingsDraft({
    id: 'priorities', label: 'Provider priorities', initial: [] as string[], source: s?.priorities,
    save: async (value) => {
      await api.savePriorities(value);
      qc.setQueryData<SettingsType>(['settings'], (current) => current ? { ...current, priorities: value } : current);
    },
  });
  const order = priorities.value;
  const setOrder = priorities.setValue;
  const dragIndex = React.useRef<number | null>(null);
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

  const notifications = useSettingsDraft<Notif>({
    id: 'notifications', label: 'Notifications', initial: { discord: { enabled: false, webhookUrl: '' } }, source: s?.notifications,
    valid: (value) => { if (!value.discord.enabled) return true; try { return new URL(value.discord.webhookUrl).protocol === 'https:'; } catch { return false; } },
    save: async (value) => {
      await api.saveNotifications(value);
      qc.setQueryData<SettingsType>(['settings'], (current) => current ? { ...current, notifications: value } : current);
    },
  });
  const notif = notifications.value;
  const setNotif = notifications.setValue;
  const [notifMsg, setNotifMsg] = React.useState<{ discord: string } | null>(null);
  const testNotif = useMutation({ mutationFn: () => api.testNotifications(notif), onSuccess: (r) => setNotifMsg(r), onError: (error) => toast({ tone: 'danger', title: 'Notification test failed', description: error instanceof Error ? error.message : String(error) }) });
  const polling = useSettingsDraft({
    id: 'poll', label: 'Auto-scan interval', initial: '12', source: s ? String(s.pollIntervalHours) : undefined,
    valid: (value) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 576,
    save: async (value) => {
      await api.savePollInterval(Number(value));
      qc.setQueryData<SettingsType>(['settings'], (current) => current ? { ...current, pollIntervalHours: Number(value) } : current);
      return String(Number(value));
    },
  });
  const poll = polling.value;
  const setPoll = polling.setValue;
  const providerToggle = useMutation({
    mutationFn: (v: { id: string; name: string; enabled: boolean }) => api.saveProvider(v.id, { enabled: v.enabled }),
    onSuccess: (_res, v) => {
      invalidate('providers')();
      toast({ tone: 'success', title: `${v.name} ${v.enabled ? 'enabled' : 'disabled'}` });
    },
    onError: (error, v) => toast({ tone: 'danger', title: `Could not update ${v.name}`, description: error instanceof Error ? error.message : String(error) }),
  });
  const requestedTab = searchParams.get('tab');
  const tab: SettingsTab = SETTINGS_TABS.some(item => item.id === requestedTab) ? requestedTab as SettingsTab : 'general';
  const setTab = (next: SettingsTab) => setSearchParams(previous => { const params = new URLSearchParams(previous); params.set('tab', next); return params; });
  React.useEffect(() => {
    if (!s || !['#kavita-connection', '#library-folders'].includes(location.hash) || tab !== 'general') return;
    const timer = window.setTimeout(() => {
      const section = document.getElementById(location.hash.slice(1));
      section?.scrollIntoView({ block: 'start' });
      section?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [s, location.hash, tab]);

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
      <SegmentedTabs items={SETTINGS_TABS} value={tab} onChange={setTab} label="Settings sections" panelId="settings-panel" className="sticky top-0 z-10 self-start bg-background" />

      <TabPanel value={tab} id="settings-panel" role="tabpanel" aria-labelledby={`settings-panel-tab-${tab}`}>
      <div hidden={tab !== 'general'} className="flex flex-col gap-4">
      <Card id="kavita-connection" className="animate-fade-up scroll-mt-16">
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
              <Input id="kavita-base-url" value={conn.baseUrl} onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} placeholder="http://kavita:5000" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="kavita-auth-key">Auth Key</Label>
              <Input id="kavita-auth-key" type="password" value={conn.apiKey} onChange={(e) => setConn({ ...conn, apiKey: e.target.value })} placeholder={kavita?.data?.hasApiKey ? 'Set' : 'your Kavita Auth Key'} />
            </div>
          </div>
          <DraftFeedback draft={connection} />
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Button onClick={connection.submit} disabled={!connection.canSave}>
              {connection.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />} Save & test connection
            </Button>
            {kavitaMsg && (
              <span role="status" className={cn('flex min-w-0 items-start gap-1 break-words text-sm', kavitaMsg.ok ? 'text-success' : 'text-danger')}>
                {kavitaMsg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}{kavitaMsg.text}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      <KavitaLibraryFoldersCard connected={Boolean(kavita?.data?.configured && !kavita.data.error)} />
      <Card className="animate-fade-up" style={{ animationDelay: '60ms' }}>
        <SectionHeader icon={<Timer className="h-4 w-4" />} title="Auto-scan interval"><DraftFeedback draft={polling} /></SectionHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input id="scan-interval" aria-label="Auto-scan interval in hours" type="number" min={0} max={576} value={poll} onChange={(e) => setPoll(e.target.value)} className="w-full sm:w-28" />
          <span className="text-sm text-muted">hours between background scans for newly ingested series (0 disables)</span>
          <SaveButton label={polling.status === 'saved' ? 'Saved' : 'Save'} onClick={polling.submit} disabled={!polling.canSave} className="sm:ml-auto" />
        </CardContent>
      </Card>
      <AppearanceCard />
      <AccountSettingsCard />
      </div>

      <div hidden={tab !== 'providers'} className="flex flex-col gap-4">
      <Card className="animate-fade-up">
        <SectionHeader icon={<SlidersHorizontal className="h-4 w-4" />} title="Metadata providers">
          <DraftFeedback draft={priorities} />
          <SaveButton label={priorities.status === 'saved' ? 'Saved' : 'Save priority'} onClick={priorities.submit} disabled={!priorities.canSave} />
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
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2 transition-colors hover:border-border-2 sm:gap-3"
                >
                  <GripVertical className="hidden h-4 w-4 shrink-0 cursor-grab text-muted active:cursor-grabbing sm:block" aria-hidden="true" />
                  <span className="w-6 text-center text-xs text-muted">{idx + 1}</span>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  <div className="flex items-center gap-1">
                    <Button size="icon" variant="ghost" aria-label={`Move ${p.name} up`} disabled={idx === 0} onClick={() => moveProvider(idx, idx - 1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" aria-label={`Move ${p.name} down`} disabled={idx === order.length - 1} onClick={() => moveProvider(idx, idx + 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                    <Switch aria-label={`Enable ${p.name}`} checked={p.enabled} disabled={providerToggle.isPending} onCheckedChange={(c) => providerToggle.mutate({ id: p.id, name: p.name, enabled: c })} />
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
      </div>

      <div hidden={tab !== 'notifications'} className="flex flex-col gap-4">
      <Card className="animate-fade-up">
        <SectionHeader icon={<Bell className="h-4 w-4" />} title="Notifications">
          <div className="flex items-center gap-2">
            <DraftFeedback draft={notifications} />
            <SaveButton label={notifications.status === 'saved' ? 'Saved' : 'Save'} onClick={notifications.submit} disabled={!notifications.canSave} />
            <Button size="sm" variant="outline" onClick={() => testNotif.mutate()} disabled={testNotif.isPending || (notif.discord.enabled && !notif.discord.webhookUrl.trim())}>
              {testNotif.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Test draft
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
      </div>

      <div hidden={tab !== 'downloader'} className="flex flex-col gap-4">
        <DownloaderSettingsCard />
      </div>
      </TabPanel>
    </div>
  );
}

/** Kavita reports its own mount paths; local folders are where H-Tosho can actually edit CBZs. */
function KavitaLibraryFoldersCard({ connected }: { connected: boolean }) {
  const qc = useQueryClient();
  const libs = useQuery({ queryKey: ['libraries'], queryFn: api.libraries, enabled: connected });
  const dl = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  const folders = useSettingsDraft<LibraryPathMapping[]>({
    id: 'library-folders', label: 'Library folder mappings', initial: [], source: dl.data?.libraryPathMappings ?? (dl.data ? [] : undefined),
    valid: (value) => value.every((mapping) => Boolean(mapping.kavitaPath.trim() && mapping.localPath.trim())),
    save: async (value) => {
      const { libraryPathMappings } = await api.saveLibraryPathMappings(value);
      qc.setQueryData<DownloaderSettings>(['downloader-settings'], (current) => current ? { ...current, libraryPathMappings } : current);
      void qc.invalidateQueries({ queryKey: ['cbz-roots'] });
      void qc.invalidateQueries({ queryKey: ['cbz-series-files'] });
      return libraryPathMappings;
    },
  });
  const draft = folders.value;
  const setDraft = folders.setValue;
  const rootKey = (value: string) => {
    const root = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(root) || root.startsWith('//') ? root.toLowerCase() : root;
  };
  const libraryPaths = (libs.data ?? []).flatMap((lib) => (lib.paths ?? (lib.path ? [lib.path] : [])).map((remote) => ({ id: lib.id, name: lib.name, remote })));
  const known = new Set(libraryPaths.map(({ remote }) => rootKey(remote)));
  const other = (draft ?? []).map((mapping, index) => ({ mapping, index })).filter(({ mapping }) => !known.has(rootKey(mapping.kavitaPath)));
  const setPath = (remote: string, local: string) => {
    setDraft((current) => {
      const next = [...(current ?? [])];
      const index = next.findIndex((mapping) => rootKey(mapping.kavitaPath) === rootKey(remote));
      if (index < 0 && local) next.push({ kavitaPath: remote, localPath: local });
      else if (index >= 0 && !local) next.splice(index, 1);
      else if (index >= 0) next[index] = { kavitaPath: remote, localPath: local };
      return next;
    });
  };

  return (
    <Card id="library-folders" className="animate-fade-up scroll-mt-16">
      <SectionHeader icon={<Server className="h-4 w-4" />} title="Kavita library folders">
        <DraftFeedback draft={folders} />
        <SaveButton label={folders.status === 'saved' ? 'Saved' : 'Save folders'} onClick={folders.submit} disabled={!folders.canSave} />
      </SectionHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted">Set the absolute folder path as seen by H-Tosho for each Kavita library root. These folders must be mounted with write access for CBZ editing and title updates. This does not change the download output folder.</p>
        {dl.isError ? <ErrorState title="Could not load library folders" description={dl.error instanceof Error ? dl.error.message : String(dl.error)} onRetry={() => void dl.refetch()} /> : !dl.data ? <p className="text-sm text-muted">Loading library folders…</p> : (
          <>
            {!connected && <p className="text-sm text-muted">Connect Kavita above to see its library folders.</p>}
            {libs.isError && <p role="alert" className="text-sm text-danger">Could not load Kavita libraries: {libs.error instanceof Error ? libs.error.message : String(libs.error)}</p>}
            {libraryPaths.map(({ id, name, remote }) => (
              <div key={`${id}:${remote}`} className="flex flex-col gap-1">
                <Label htmlFor={`library-folder-${id}-${remote}`}>{name} · {remote}</Label>
                <Input id={`library-folder-${id}-${remote}`} aria-label={`H-Tosho folder for ${name}: ${remote}`} value={draft.find((mapping) => rootKey(mapping.kavitaPath) === rootKey(remote))?.localPath ?? ''} onChange={(e) => setPath(remote, e.target.value)} placeholder="Absolute folder path inside H-Tosho" />
              </div>
            ))}
            {other.map(({ mapping, index }) => (
              <div key={index} className="grid min-w-0 grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <div className="min-w-0"><Label htmlFor={`extra-kavita-path-${index}`}>Kavita folder</Label><Input id={`extra-kavita-path-${index}`} value={mapping.kavitaPath} onChange={(e) => setDraft(draft.map((m, i) => i === index ? { ...m, kavitaPath: e.target.value } : m))} placeholder="/media/Manga" /></div>
                <div className="min-w-0"><Label htmlFor={`extra-local-path-${index}`}>H-Tosho folder</Label><Input id={`extra-local-path-${index}`} value={mapping.localPath} onChange={(e) => setDraft(draft.map((m, i) => i === index ? { ...m, localPath: e.target.value } : m))} placeholder="/mnt/manga" /></div>
                <Button type="button" variant="ghost" aria-label={`Remove extra folder mapping ${index + 1}`} onClick={() => setDraft(draft.filter((_, i) => i !== index))}><X className="h-4 w-4" /> Remove</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" className="self-start" onClick={() => setDraft([...draft, { kavitaPath: '', localPath: '' }])}><Plus className="h-4 w-4" /> Add another folder</Button>
            <p className="text-xs text-muted">Leave a library folder empty to use Kavita's path directly when it is accessible from H-Tosho. Add another folder for a nested mount or a root Kavita does not list.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Tag list editor for a source's banned tags. Enter adds a tag; comma-separated input adds several at once. */
function BannedTagsEditor({ id, label, hint, value, onChange, draft, setDraft }: { id: string; label: string; hint: string; value: string[]; onChange: (tags: string[]) => void; draft: string; setDraft: (value: string) => void }) {
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
      <Label htmlFor={id}>{label}</Label>
      <p className="text-sm text-muted">{hint}</p>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 py-1">
          {value.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-danger/15 pl-3 pr-1 text-xs font-medium text-danger">
              {tag}
              <button type="button" onClick={() => onChange(value.filter((value) => value !== tag))} className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-danger/30" aria-label={`Remove ${tag}`}><X className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} placeholder="e.g. loli, big breasts, nsfw" className="flex-1" />
        <Button size="sm" variant="outline" onClick={addTag} disabled={!draft.trim()}><Plus className="h-3.5 w-3.5" /> Add</Button>
      </div>
    </div>
  );
}

function DownloaderSettingsCard() {
  const qc = useQueryClient();
  const dl = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  type DownloadDraft = Omit<DownloaderSettings, 'libraryPathMappings'> & { nhentaiTagInput: string; hitomiTagInput: string };
  const source = React.useMemo(() => {
    if (!dl.data) return undefined;
    const { libraryPathMappings: _mappings, ...settings } = dl.data;
    return { ...settings, nhentaiTagInput: '', hitomiTagInput: '' };
  }, [dl.data]);
  const downloader = useSettingsDraft<DownloadDraft | null>({
    id: 'downloader', label: 'Downloader settings', initial: null, source,
    valid: (value) => Boolean(value && value.downloadDirectory.trim() && Number.isInteger(value.maxConcurrentDownloads) && value.maxConcurrentDownloads >= 1 && value.maxConcurrentDownloads <= 10 && Number.isInteger(value.maxImageConcurrency) && value.maxImageConcurrency >= 1 && value.maxImageConcurrency <= 20 && Number.isFinite(value.requestDelayMs) && value.requestDelayMs >= 0),
    save: async (value) => {
      if (!value) throw new Error('Downloader settings have not loaded.');
      const { nhentaiTagInput, hitomiTagInput, ...settings } = value;
      const appendTags = (tags: string[], input: string) => [...new Set([...tags, ...input.split(',').map((tag) => tag.trim().replace(/^"+|"+$/g, '')).filter(Boolean)])];
      const result = await api.saveDownloaderSettings({ ...settings, libraryPathMappings: [], nhentaiBannedTags: appendTags(settings.nhentaiBannedTags ?? [], nhentaiTagInput), hitomiBannedTags: appendTags(settings.hitomiBannedTags ?? [], hitomiTagInput) });
      qc.setQueryData<DownloaderSettings>(['downloader-settings'], (current) => ({ ...result.settings, libraryPathMappings: current?.libraryPathMappings ?? result.settings.libraryPathMappings }));
      const { libraryPathMappings: _mappings, ...persisted } = result.settings;
      return { ...persisted, nhentaiTagInput: '', hitomiTagInput: '' };
    },
  });
  const dlSettings = downloader.value;
  const setDlSettings = downloader.setValue;

  if (dl.isError) return <Card><ErrorState title="Could not load downloader settings" description={dl.error instanceof Error ? dl.error.message : String(dl.error)} onRetry={() => void dl.refetch()} /></Card>;
  if (!dlSettings) return <Card><SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader" /><CardContent className="flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</CardContent></Card>;

  return (
    <Card className="animate-fade-up">
      <SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader">
        <DraftFeedback draft={downloader} />
        <SaveButton label={downloader.status === 'saved' ? 'Saved' : 'Save'} onClick={downloader.submit} disabled={!downloader.canSave} />
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
        <BannedTagsEditor id="nhentai-banned-tags" label="nHentai banned tags" hint="Galleries carrying any of these tags never appear in nHentai searches. Separate multiple tags with commas." value={dlSettings.nhentaiBannedTags ?? []} onChange={(tags) => setDlSettings((current) => current ? { ...current, nhentaiBannedTags: tags } : current)} draft={dlSettings.nhentaiTagInput} setDraft={(nhentaiTagInput) => setDlSettings((current) => current ? { ...current, nhentaiTagInput } : current)} />
        <BannedTagsEditor id="hitomi-banned-tags" label="Hitomi banned tags" hint="Galleries carrying any of these tags never appear in Hitomi searches or recommendations. A plain name matches anywhere; a namespace prefix (e.g. artist:foo) scopes the ban to that area. Separate multiple tags with commas." value={dlSettings.hitomiBannedTags ?? []} onChange={(tags) => setDlSettings((current) => current ? { ...current, hitomiBannedTags: tags } : current)} draft={dlSettings.hitomiTagInput} setDraft={(hitomiTagInput) => setDlSettings((current) => current ? { ...current, hitomiTagInput } : current)} />
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-2 p-3"><div className="min-w-0"><p className="text-sm">Auto-sync Kavita</p><p className="break-words text-sm text-muted">Trigger a library scan in Kavita after each download completes.</p></div><Switch className="mt-0.5" aria-label="Auto-sync Kavita after downloads" checked={dlSettings.autoSyncKavita} onCheckedChange={(checked) => setDlSettings({ ...dlSettings, autoSyncKavita: checked })} /></div>
      </CardContent>
    </Card>
  );
}

function ProviderCreds({ provider, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  const credentials = useSettingsDraft<Record<string, string>>({
    id: `provider:${provider.id}`, label: `${provider.name} credentials`, initial: {}, source: provider.credentials ?? {},
    save: async (value) => { await api.saveProvider(provider.id, { credentials: value }); onChanged(); },
  });
  const creds = credentials.value;
  const setCreds = credentials.setValue;
  const test = useMutation({ mutationFn: () => api.testProvider(provider.id), onSuccess: (r) => setTestMsg(r) });
  const [testMsg, setTestMsg] = React.useState<{ ok: boolean; error?: string } | null>(null);
  const hasFields = provider.credentialFields.length > 0;

  return (
    <div className="rounded-md border border-border bg-surface-2/50 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: provider.color }} />
        <span className="text-sm font-medium">{provider.name}</span>
        <span className="text-xs text-muted">{provider.requiresCredentials ? (provider.hasCredentials ? 'configured' : 'needs credentials') : 'no credentials required'}</span>
        <span className="flex-1" />
        {hasFields && (
          <Button
            size="sm"
            variant="outline"
            disabled={!credentials.canSave}
            onClick={credentials.submit}
          >
            {credentials.pending ? 'Saving…' : credentials.status === 'saved' ? 'Saved' : 'Save credentials'}
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
      {hasFields && <div className="mt-2"><DraftFeedback draft={credentials} /></div>}
      {hasFields && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {provider.credentialFields.map((cf) => (
            <div key={cf.key} className="flex flex-col gap-1">
              <Label htmlFor={`provider-${provider.id}-${cf.key}`}>{cf.label}</Label>
              <Input id={`provider-${provider.id}-${cf.key}`} type="password" autoComplete="off" value={creds[cf.key] ?? ''} onChange={(e) => setCreds((prev) => ({ ...prev, [cf.key]: e.target.value }))} placeholder={cf.label} />
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
