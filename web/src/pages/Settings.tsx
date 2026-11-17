import * as React from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Server, SlidersHorizontal, Bell, Timer, CheckCircle2, XCircle, Loader2, Save, Download, X, Plus, ArrowUp, ArrowDown, LockKeyhole, Monitor, Moon, Sun, Palette } from 'lucide-react';
import { api, ApiError, type Settings as SettingsType, type ProviderInfo, type DownloaderSettings, type LibraryPathMapping } from '../lib/api';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch, Badge, PageHeader, ErrorState, SegmentedTabs, SegmentedControl, TabPanel, Disclosure } from '../components/ui';
import { cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { useAuth } from '../lib/AuthContext';
import { useTheme, type Theme } from '../lib/theme';
import { DraftFeedback, useSettingsDraft, useSettingsNavigation } from '../lib/SettingsDrafts';

type Notif = SettingsType['notifications'];
const DEFAULT_NOTIFICATION_DRAFT: Notif = { discord: { enabled: false, webhookUrl: '' }, revision: 0, destinationIdentity: '', digest: { time: '09:00', timezone: 'UTC', timezoneFallback: true, nextDueAt: '' } };
function digestDraftValid(value: Notif) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.digest.time)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.digest.timezone }).format(); return Boolean(value.digest.timezone) && !/^[+-]/.test(value.digest.timezone); } catch { return false; }
}
const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'downloader', label: 'Downloader' },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
const SETTINGS_TAB_ORDER = SETTINGS_TABS.map(tab => tab.id);

function SectionHeader({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
      <CardTitle as="h2" className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true">{icon}</span> <span className="break-words">{title}</span>
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

/** Keep the instruction and validation message attached to their field. */
function SettingsInput({ id, error, hint, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; error?: string; hint?: React.ReactNode }) {
  const describedBy = [props['aria-describedby'], hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return <>
    <Input {...props} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
    {hint && <p id={`${id}-hint`} className="text-sm text-muted">{hint}</p>}
    {error && <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p>}
  </>;
}

function httpUrlError(value: string, httpsOnly = false) {
  try {
    const url = new URL(value);
    if (httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) return '';
  } catch { /* The field explains the expected URL format. */ }
  return httpsOnly ? 'Enter a complete URL starting with https://.' : 'Enter a complete URL starting with http:// or https://.';
}

function numberError(value: string | number, min: number, max?: number, integer = false) {
  const number = Number(value);
  if (String(value).trim() !== '' && Number.isFinite(number) && number >= min && (max === undefined || number <= max) && (!integer || Number.isInteger(number))) return '';
  return max !== undefined
    ? `Enter ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`
    : `Enter ${integer ? 'a whole number' : 'a number'} of ${min} or more.`;
}

function folderError(value: string) {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value.trim()) && !value.includes('\0') ? '' : 'Enter an absolute folder path, such as /downloads or C:\\Manga.';
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
        <p className="mt-2 text-sm text-muted">Theme changes apply immediately. System follows your operating system's color scheme.</p>
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
            <div className="flex flex-col gap-1"><Label htmlFor="account-username">Username</Label><SettingsInput id="account-username" autoComplete="username" required maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} error={account.dirty && !username.trim() ? 'Enter your username.' : undefined} /></div>
            <div className="flex flex-col gap-1"><Label htmlFor="current-password">Current password</Label><SettingsInput id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} error={account.dirty && !currentPassword ? 'Enter your current password to authorize this change.' : undefined} /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1"><Label htmlFor="new-password">New password</Label><SettingsInput id="new-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} hint="Use at least 8 characters." error={account.dirty && password.length < 8 ? 'Enter a new password with at least 8 characters.' : undefined} /></div>
              <div className="flex flex-col gap-1"><Label htmlFor="confirm-new-password">Confirm new password</Label><SettingsInput id="confirm-new-password" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} hint="Enter your new password again." error={confirmPassword && password !== confirmPassword ? 'Passwords do not match. Enter the same password in both fields.' : account.dirty && password.length >= 8 && !confirmPassword ? 'Confirm your new password.' : undefined} /></div>
            </div>
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
  const { dirtyIds } = useSettingsNavigation();
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
    valid: (value) => !httpUrlError(value.baseUrl) && Boolean(value.apiKey.trim() || kavita.data?.hasApiKey),
    save: async (value) => {
      const result = await api.saveConnection(value);
      if (!result.saved) throw new Error(result.test);
      const connectionQueries = new Set(['libraries', 'library-series', 'series', 'identify', 'low-confidence', 'review-series', 'library-override', 'jobs', 'job', 'logs', 'history', 'field-policy', 'metadata-history', 'metadata-history-detail', 'cbz-roots', 'cbz-series-files', 'recommendation-libraries', 'home-matches', 'home-activity']);
      await qc.cancelQueries({ predicate: query => connectionQueries.has(String(query.queryKey[0])) });
      qc.removeQueries({ predicate: query => connectionQueries.has(String(query.queryKey[0])) && query.getObserversCount() === 0 });
      void qc.resetQueries({ predicate: query => connectionQueries.has(String(query.queryKey[0])) });
      qc.setQueryData(['kavita-status'], { ...kavita.data, baseUrl: value.baseUrl, configured: true, hasApiKey: Boolean(value.apiKey) || kavita.data?.hasApiKey, error: result.connected ? null : result.test });
      void qc.invalidateQueries({ queryKey: ['kavita-status'] });
      setKavitaMsg({ ok: result.connected, text: result.test });
      return { ...value, apiKey: '' };
    },
  });
  const conn = connection.value;
  const setConn = connection.setValue;
  const testKavita = useMutation({
    mutationFn: api.kavitaStatus,
    onSuccess: (result) => {
      qc.setQueryData(['kavita-status'], result);
      setKavitaMsg({ ok: Boolean(result.configured && !result.error), text: result.error ?? (result.configured ? 'Saved connection verified.' : 'Save a server address and Auth Key first.') });
    },
    onError: (error) => setKavitaMsg({ ok: false, text: `Could not check the saved connection. ${error instanceof Error ? error.message : String(error)} Try again.` }),
  });
  React.useEffect(() => { if (connection.dirty) setKavitaMsg(null); }, [conn.baseUrl, conn.apiKey, connection.dirty]);
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
  const [reorderMessage, setReorderMessage] = React.useState('');
  const announceMove = (from: number, to: number) => setReorderMessage(`${provs.find((provider) => provider.id === order[from])?.name ?? order[from]} moved to priority ${to + 1} of ${order.length}. Save priority to apply.`);
  const onDrop = (to: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === to) return;
    announceMove(from, to);
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const moveProvider = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    announceMove(from, to);
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const notifications = useSettingsDraft<Notif>({
    id: 'notifications', label: 'Notifications', initial: DEFAULT_NOTIFICATION_DRAFT, source: s?.notifications,
    valid: (value) => digestDraftValid(value) && (!value.discord.enabled || !httpUrlError(value.discord.webhookUrl, true)),
    save: async (value) => {
      if (value.revision !== s?.notifications.revision) throw new Error('Notification settings changed. Review the latest saved destination and use “Use latest revision” before saving your retained draft.');
      let result;
      try { result = await api.saveNotifications(value); }
      catch (error) { if (error instanceof ApiError && error.status === 409) await settings.refetch(); throw error; }
      qc.setQueryData<SettingsType>(['settings'], (current) => current ? { ...current, notifications: result.notifications } : current);
      await qc.invalidateQueries({ queryKey: ['following-deliveries'] });
      return result.notifications;
    },
  });
  const notif = notifications.value;
  const setNotif = notifications.setValue;
  const [notifMsg, setNotifMsg] = React.useState<{ discord: string } | null>(null);
  const testNotif = useMutation({ mutationFn: () => api.testNotifications(notif), onSuccess: (r) => setNotifMsg(r), onError: (error) => setNotifMsg({ discord: `Could not send a test notification. ${error instanceof Error ? error.message : String(error)} Try again.` }) });
  React.useEffect(() => setNotifMsg(null), [notif.discord.enabled, notif.discord.webhookUrl]);
  const polling = useSettingsDraft({
    id: 'poll', label: 'Auto-scan interval', initial: '12', source: s ? String(s.pollIntervalHours) : undefined,
    valid: (value) => !numberError(value, 0, 576),
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
      <PageHeader icon={<SlidersHorizontal className="h-5 w-5" />} title="Settings" subtitle="Manage connections, downloads, notifications and your account." />
      <SegmentedTabs items={SETTINGS_TABS.map(item => ({ ...item, dirty: dirtyIds.some(id => item.id === 'general' ? ['connection', 'library-folders', 'poll', 'account'].includes(id) : item.id === 'providers' ? id === 'priorities' || id.startsWith('provider:') : id === item.id) }))} value={tab} onChange={setTab} label="Settings sections" panelId="settings-panel" className="sticky top-0 z-10 self-start bg-background" />

      <TabPanel value={tab} tabOrder={SETTINGS_TAB_ORDER} id="settings-panel" role="tabpanel" aria-labelledby={`settings-panel-tab-${tab}`}>
      <div hidden={tab !== 'general'} className="flex flex-col gap-4">
      <Card id="kavita-connection" className="animate-fade-up scroll-mt-16">
        <SectionHeader icon={<Server className="h-4 w-4" />} title="Kavita connection">
          <Badge role="status" tone={kavita.isFetching || testKavita.isPending || kavita.isError ? 'muted' : kavita?.data?.configured && !kavita.data.error ? 'success' : kavita?.data?.configured ? 'danger' : 'muted'}>
            {kavita.isFetching || testKavita.isPending ? 'Checking saved connection…' : kavita.isError ? 'Unable to check connection' : kavita?.data?.configured
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
              <SettingsInput id="kavita-base-url" type="url" autoComplete="url" spellCheck={false} disabled={connection.pending || testKavita.isPending} value={conn.baseUrl} onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} placeholder="http://kavita:5000" error={connection.dirty ? httpUrlError(conn.baseUrl) : undefined} hint="Use the server address without /api. In Docker, use an address reachable from H-Tosho's container, such as http://kavita:5000." />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="kavita-auth-key">Auth Key</Label>
              <SettingsInput id="kavita-auth-key" type="password" autoComplete="off" disabled={connection.pending || testKavita.isPending} value={conn.apiKey} onChange={(e) => setConn({ ...conn, apiKey: e.target.value })} placeholder={kavita?.data?.hasApiKey ? 'Saved key' : 'Kavita admin Auth Key'} error={connection.dirty && !conn.apiKey.trim() && !kavita.data?.hasApiKey ? 'Enter an Auth Key for a Kavita admin account.' : undefined} hint={<>{kavita.data?.hasApiKey && 'A key is saved. Leave blank to keep it. '}Create an admin key in Kavita under User Settings → Manage Auth Keys. <a href="https://www.kavitareader.com/docs/api/" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">Kavita Auth Key help<span className="sr-only"> (opens in a new tab)</span></a></>} />
            </div>
          </div>
          <DraftFeedback draft={connection} />
          {connection.dirty && <p className="text-sm text-muted">The connection status reflects your saved settings. Save your changes to test the new values.</p>}
          {(kavita.isError || kavita.data?.error) && !testKavita.isPending && <p role="alert" className="break-words text-sm text-danger">{kavita.data?.error ?? `Could not load connection status. ${kavita.error instanceof Error ? kavita.error.message : String(kavita.error)}`} Check the server address, Auth Key and network access, then retry.</p>}
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Button onClick={connection.submit} disabled={!connection.canSave || testKavita.isPending}>
              {connection.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />} Save & test connection
            </Button>
            <Button variant="outline" onClick={() => { setKavitaMsg(null); testKavita.mutate(); }} disabled={connection.pending || testKavita.isPending || connection.dirty || (!kavita.data?.configured && !kavita.isError)}>
              {testKavita.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {kavita.isError ? 'Retry connection check' : 'Test saved connection'}
            </Button>
            {kavitaMsg && (
              <span role={kavitaMsg.ok ? 'status' : 'alert'} className={cn('flex min-w-0 items-start gap-1 break-words text-sm', kavitaMsg.ok ? 'text-success' : 'text-danger')}>
                {kavitaMsg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}{kavitaMsg.text}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      <KavitaLibraryFoldersCard connected={Boolean(kavita?.data?.configured && !kavita.data.error)} />
      <Card className="animate-fade-up">
        <SectionHeader icon={<Timer className="h-4 w-4" />} title="Auto-scan interval"><DraftFeedback draft={polling} /></SectionHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-1"><Label htmlFor="scan-interval">Hours between background scans</Label><SettingsInput id="scan-interval" type="number" min={0} max={576} step="any" value={poll} onChange={(e) => setPoll(e.target.value)} className="w-full sm:w-28" hint="Scan for newly ingested series every 0–576 hours. Set 0 to disable automatic scans." error={polling.dirty ? numberError(poll, 0, 576) : undefined} /></div>
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
          <SaveButton label={priorities.status === 'saved' ? 'Saved' : 'Save priority'} onClick={priorities.submit} disabled={!priorities.canSave || providers.isError || providers.isPending} />
        </SectionHeader>
        <CardContent className="flex flex-col gap-4">
          {providers.isError ? <ErrorState title="Could not load metadata providers" description={providers.error instanceof Error ? providers.error.message : String(providers.error)} onRetry={() => void providers.refetch()} /> : providers.isPending ? <p role="status" className="text-sm text-muted">Loading metadata providers…</p> : provs.length === 0 ? <div className="flex flex-col items-start gap-2"><p className="text-sm text-muted">No metadata providers are available. Check your installation, then reload providers.</p><Button variant="outline" onClick={() => void providers.refetch()}>Reload providers</Button></div> : null}
          {!providers.isPending && !providers.isError && provs.length > 0 && <>
          <p className="text-sm text-muted">Drag to reorder or use the arrow buttons. Providers are searched top-to-bottom; the first confident match wins.</p>
          <p className="text-sm text-muted">Enable switches save immediately. Reordering and credentials use their own Save buttons.</p>
          <p role="status" aria-live="polite" className="sr-only">{reorderMessage}</p>
          <div className="flex flex-col gap-2">
            {order.map((id, idx) => {
              const p = provs.find((x) => x.id === id);
              if (!p) return null;
              return (
                <div
                  key={id}
                  draggable
                  onDragStart={() => (dragIndex.current = idx)}
                  onDragEnd={() => (dragIndex.current = null)}
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
          </>}
        </CardContent>
      </Card>
      </div>

      <div hidden={tab !== 'notifications'} className="flex flex-col gap-4">
      <Card className="animate-fade-up">
        <SectionHeader icon={<Bell className="h-4 w-4" />} title="Notifications">
          <div className="flex items-center gap-2">
            <DraftFeedback draft={notifications} />
            <SaveButton label={notifications.status === 'saved' ? 'Saved' : 'Save'} onClick={notifications.submit} disabled={!notifications.canSave || testNotif.isPending} />
            <Button size="sm" variant="outline" onClick={() => testNotif.mutate()} disabled={testNotif.isPending || notifications.pending || !notif.discord.enabled || !notifications.valid}>
              {testNotif.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Test draft
            </Button>
          </div>
        </SectionHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="discord-webhook">Discord webhook</Label>
              <Switch aria-label="Enable Discord notifications" disabled={testNotif.isPending || notifications.pending} checked={notif.discord.enabled} onCheckedChange={(c) => setNotif((n) => ({ ...n, discord: { ...n.discord, enabled: c } }))} />
            </div>
            <SettingsInput id="discord-webhook" type="url" spellCheck={false} disabled={testNotif.isPending || notifications.pending} value={notif.discord.webhookUrl} onChange={(e) => setNotif((n) => ({ ...n, discord: { ...n.discord, webhookUrl: e.target.value } }))} placeholder="https://discord.com/api/webhooks/…" hint="Enable Discord and enter a webhook URL. Test draft sends a notification using the values shown, without saving them." error={notif.discord.enabled ? httpUrlError(notif.discord.webhookUrl, true) : undefined} />
          </div>
          {notif.revision !== s.notifications.revision && <div role="alert" className="flex flex-col gap-2 text-sm text-warning"><p>Saved notification settings changed. Latest destination: {s.notifications.destinationIdentity.slice(0, 12) || 'not configured'} · {s.notifications.digest.time} {s.notifications.digest.timezone}. Your draft is retained.</p><Button variant="outline" className="min-h-11 self-start" onClick={() => setNotif(value => ({ ...value, revision: s.notifications.revision }))}>Use latest revision</Button></div>}
          <section className="flex flex-col gap-3 border-t border-border pt-4" aria-label="Following daily digest">
            <h3 className="text-sm font-semibold">Following daily digest</h3>
            <p className="text-sm text-muted">Choose Daily digest in each watch's notification preference. Finds are collected independently of provider checks.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1"><Label htmlFor="digest-time">Daily time</Label><SettingsInput id="digest-time" type="time" required disabled={notifications.pending} value={notif.digest.time} onChange={event => setNotif(value => ({ ...value, digest: { ...value.digest, time: event.target.value } }))} hint="24-hour HH:mm in the chosen timezone." /></div>
              <div className="flex flex-col gap-1"><Label htmlFor="digest-zone">IANA timezone</Label><SettingsInput id="digest-zone" required spellCheck={false} disabled={notifications.pending} value={notif.digest.timezone} onChange={event => setNotif(value => ({ ...value, digest: { ...value.digest, timezone: event.target.value, timezoneFallback: false } }))} placeholder="America/New_York" hint="For example Europe/London, America/New_York or UTC." error={!digestDraftValid(notif) ? 'Enter a valid HH:mm time and IANA timezone.' : undefined} /></div>
            </div>
            <p className="text-sm text-muted">{s.notifications.digest.timezoneFallback ? 'The server could not resolve its timezone; UTC is the visible fallback. ' : ''}Saved next cutoff: {s.notifications.digest.nextDueAt ? new Date(s.notifications.digest.nextDueAt).toLocaleString() : 'Not scheduled'}.</p>
            <p className="text-sm text-muted">DST: repeated hours use the first occurrence; missing times shift forward by the gap. One bounded batch per local day; missed days do not replay. Saving settings suppresses queued old finds. Send backlog only after reviewing the current destination in Following.</p>
          </section>
          {notifMsg && (
            <div role={notifMsg.discord === 'ok' ? 'status' : 'alert'} className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-3 text-sm">
              <span className={notifMsg.discord === 'ok' ? 'text-success' : 'text-danger'}>{notifMsg.discord === 'ok' ? 'Test notification sent to Discord.' : `Discord test failed: ${notifMsg.discord}`}</span>
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
    valid: (value) => value.every((mapping) => !folderError(mapping.kavitaPath) && !folderError(mapping.localPath)),
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
            {libs.isError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="break-words text-sm text-danger">Could not load Kavita libraries: {libs.error instanceof Error ? libs.error.message : String(libs.error)}</p><Button size="sm" variant="outline" onClick={() => void libs.refetch()}>Retry library folders</Button></div>}
            {libraryPaths.map(({ id, name, remote }) => {
              const localPath = draft.find((mapping) => rootKey(mapping.kavitaPath) === rootKey(remote))?.localPath ?? '';
              return (
              <div key={`${id}:${remote}`} className="flex flex-col gap-1">
                <Label htmlFor={`library-folder-${id}-${remote}`}>{name} · {remote}</Label>
                <SettingsInput id={`library-folder-${id}-${remote}`} aria-label={`H-Tosho folder for ${name}: ${remote}`} aria-describedby="library-folders-hint" value={localPath} onChange={(e) => setPath(remote, e.target.value)} placeholder="Absolute folder path inside H-Tosho" error={folders.dirty && localPath ? folderError(localPath) : undefined} />
              </div>
              );
            })}
            {other.map(({ mapping, index }) => (
              <div key={index} className="grid min-w-0 grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <div className="flex min-w-0 flex-col gap-1"><Label htmlFor={`extra-kavita-path-${index}`}>Kavita folder</Label><SettingsInput id={`extra-kavita-path-${index}`} value={mapping.kavitaPath} onChange={(e) => setDraft(draft.map((m, i) => i === index ? { ...m, kavitaPath: e.target.value } : m))} placeholder="/media/Manga" error={folderError(mapping.kavitaPath)} /></div>
                <div className="flex min-w-0 flex-col gap-1"><Label htmlFor={`extra-local-path-${index}`}>H-Tosho folder</Label><SettingsInput id={`extra-local-path-${index}`} value={mapping.localPath} onChange={(e) => setDraft(draft.map((m, i) => i === index ? { ...m, localPath: e.target.value } : m))} placeholder="/mnt/manga" error={folderError(mapping.localPath)} /></div>
                <Button type="button" variant="ghost" aria-label={`Remove extra folder mapping ${index + 1}`} onClick={() => setDraft(draft.filter((_, i) => i !== index))}><X className="h-4 w-4" /> Remove</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" className="self-start" onClick={() => setDraft([...draft, { kavitaPath: '', localPath: '' }])}><Plus className="h-4 w-4" /> Add another folder</Button>
            <p id="library-folders-hint" className="text-sm text-muted">Leave a library folder empty to use Kavita's path directly when it is accessible from H-Tosho. Add another folder for a nested mount or a root Kavita does not list.</p>
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
      <p id={`${id}-hint`} className="text-sm text-muted">{hint}</p>
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
      <div className="flex items-center gap-2">
        <Input id={id} aria-describedby={`${id}-hint`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} placeholder="Tag names" className="min-w-0 flex-1" />
        <Button size="sm" variant="outline" className="shrink-0" onClick={addTag} disabled={!draft.trim()}><Plus className="h-3.5 w-3.5" /> Add</Button>
      </div>
    </div>
  );
}

function DownloaderSettingsCard() {
  const qc = useQueryClient();
  const dl = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  type DownloadDraft = Omit<DownloaderSettings, 'libraryPathMappings' | 'maxConcurrentDownloads' | 'maxImageConcurrency' | 'requestDelayMs'> & { maxConcurrentDownloads: number | ''; maxImageConcurrency: number | ''; requestDelayMs: number | ''; nhentaiTagInput: string; hitomiTagInput: string };
  const source = React.useMemo(() => {
    if (!dl.data) return undefined;
    const { libraryPathMappings: _mappings, ...settings } = dl.data;
    return { ...settings, nhentaiTagInput: '', hitomiTagInput: '' };
  }, [dl.data]);
  const downloader = useSettingsDraft<DownloadDraft | null>({
    id: 'downloader', label: 'Downloader settings', initial: null, source,
    valid: (value) => Boolean(value && !folderError(value.downloadDirectory) && !numberError(value.maxConcurrentDownloads, 1, 10, true) && !numberError(value.maxImageConcurrency, 1, 20, true) && !numberError(value.requestDelayMs, 0, 60000)),
    save: async (value) => {
      if (!value) throw new Error('Downloader settings have not loaded.');
      const { nhentaiTagInput, hitomiTagInput, ...settings } = value;
      const appendTags = (tags: string[], input: string) => [...new Set([...tags, ...input.split(',').map((tag) => tag.trim().replace(/^"+|"+$/g, '')).filter(Boolean)])];
      const result = await api.saveDownloaderSettings({ ...settings, maxConcurrentDownloads: Number(settings.maxConcurrentDownloads), maxImageConcurrency: Number(settings.maxImageConcurrency), requestDelayMs: Number(settings.requestDelayMs), libraryPathMappings: [], nhentaiBannedTags: appendTags(settings.nhentaiBannedTags ?? [], nhentaiTagInput), hitomiBannedTags: appendTags(settings.hitomiBannedTags ?? [], hitomiTagInput) });
      qc.setQueryData<DownloaderSettings>(['downloader-settings'], (current) => ({ ...result.settings, libraryPathMappings: current?.libraryPathMappings ?? result.settings.libraryPathMappings }));
      const { libraryPathMappings: _mappings, ...persisted } = result.settings;
      return { ...persisted, nhentaiTagInput: '', hitomiTagInput: '' };
    },
  });
  const dlSettings = downloader.value;
  const setDlSettings = downloader.setValue;
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const advancedInvalid = Boolean(dlSettings && (numberError(dlSettings.maxConcurrentDownloads, 1, 10, true) || numberError(dlSettings.maxImageConcurrency, 1, 20, true) || numberError(dlSettings.requestDelayMs, 0, 60000)));
  React.useEffect(() => { if (advancedInvalid) setAdvancedOpen(true); }, [advancedInvalid]);

  if (dl.isError) return <Card><ErrorState title="Could not load downloader settings" description={dl.error instanceof Error ? dl.error.message : String(dl.error)} onRetry={() => void dl.refetch()} /></Card>;
  if (!dlSettings) return <Card><SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader" /><CardContent className="flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</CardContent></Card>;

  return (
    <Card className="animate-fade-up">
      <SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader">
        <DraftFeedback draft={downloader} />
        <SaveButton label={downloader.status === 'saved' ? 'Saved' : 'Save'} onClick={downloader.submit} disabled={!downloader.canSave} />
      </SectionHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1"><Label htmlFor="download-directory">Output folder</Label><SettingsInput id="download-directory" value={dlSettings.downloadDirectory} onChange={(e) => setDlSettings({ ...dlSettings, downloadDirectory: e.target.value })} placeholder="/downloads" error={downloader.dirty ? folderError(dlSettings.downloadDirectory) : undefined} hint="Absolute path as seen by H-Tosho, including inside Docker. Use a Kavita library folder to have new media picked up automatically." /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="download-format">Output format</Label><Select id="download-format" value={dlSettings.format} onChange={(e) => setDlSettings({ ...dlSettings, format: e.target.value as 'cbz' | 'folder' })}><option value="cbz">CBZ archive (recommended)</option><option value="folder">Image folder</option></Select></div>
        <BannedTagsEditor id="nhentai-banned-tags" label="nHentai banned tags" hint="Galleries carrying any of these tags never appear in nHentai searches. Separate multiple tags with commas." value={dlSettings.nhentaiBannedTags ?? []} onChange={(tags) => setDlSettings((current) => current ? { ...current, nhentaiBannedTags: tags } : current)} draft={dlSettings.nhentaiTagInput} setDraft={(nhentaiTagInput) => setDlSettings((current) => current ? { ...current, nhentaiTagInput } : current)} />
        <BannedTagsEditor id="hitomi-banned-tags" label="Hitomi banned tags" hint="Galleries carrying any of these tags never appear in Hitomi searches or recommendations. A plain name matches anywhere; a namespace prefix (e.g. artist:foo) scopes the ban to that area. Separate multiple tags with commas." value={dlSettings.hitomiBannedTags ?? []} onChange={(tags) => setDlSettings((current) => current ? { ...current, hitomiBannedTags: tags } : current)} draft={dlSettings.hitomiTagInput} setDraft={(hitomiTagInput) => setDlSettings((current) => current ? { ...current, hitomiTagInput } : current)} />
        <p className="break-words text-sm text-muted">Completed downloads in a shared Kavita library are imported and checked for matches in the background. Review candidates on Home before applying metadata.</p>
        <Disclosure label={`Advanced: download performance and API key${advancedInvalid ? ' — needs attention' : ''}`} open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="border-t border-border pt-2" summaryClassName="px-0">
          <div className="flex flex-col gap-4 pt-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1"><Label htmlFor="download-concurrency">Max concurrent downloads</Label><SettingsInput id="download-concurrency" type="number" min={1} max={10} value={dlSettings.maxConcurrentDownloads} onChange={(e) => setDlSettings({ ...dlSettings, maxConcurrentDownloads: e.target.value === '' ? '' : Number(e.target.value) })} hint="Galleries downloading at once (1–10)." error={downloader.dirty ? numberError(dlSettings.maxConcurrentDownloads, 1, 10, true) : undefined} /></div>
              <div className="flex flex-col gap-1"><Label htmlFor="image-concurrency">Max image concurrency</Label><SettingsInput id="image-concurrency" type="number" min={1} max={20} value={dlSettings.maxImageConcurrency} onChange={(e) => setDlSettings({ ...dlSettings, maxImageConcurrency: e.target.value === '' ? '' : Number(e.target.value) })} hint="Images fetched at once per gallery (1–20)." error={downloader.dirty ? numberError(dlSettings.maxImageConcurrency, 1, 20, true) : undefined} /></div>
              <div className="flex flex-col gap-1"><Label htmlFor="request-delay">Request delay (ms)</Label><SettingsInput id="request-delay" type="number" min={0} max={60000} step="any" value={dlSettings.requestDelayMs} onChange={(e) => setDlSettings({ ...dlSettings, requestDelayMs: e.target.value === '' ? '' : Number(e.target.value) })} hint="Wait 0–60,000 milliseconds between requests. Higher values reduce request frequency." error={downloader.dirty ? numberError(dlSettings.requestDelayMs, 0, 60000) : undefined} /></div>
            </div>
            <div className="flex flex-col gap-1"><Label htmlFor="nhentai-api-key">nHentai API key (optional)</Label><SettingsInput id="nhentai-api-key" type="password" value={dlSettings.nhentaiApiKey} onChange={(e) => setDlSettings({ ...dlSettings, nhentaiApiKey: e.target.value })} placeholder="Optional API key" autoComplete="off" hint="Optional key from nhentai.net for higher API rate limits. Leave blank to use the NHENTAI_API_KEY environment variable, if set." /></div>
          </div>
        </Disclosure>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <DraftFeedback draft={downloader} />
          <SaveButton label={downloader.pending ? 'Saving…' : downloader.status === 'saved' ? 'Saved' : 'Save downloader settings'} onClick={downloader.submit} disabled={!downloader.canSave} className="ml-auto" />
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCreds({ provider, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  const credentials = useSettingsDraft<Record<string, string>>({
    id: `provider:${provider.id}`, label: `${provider.name} credentials`, initial: {}, source: provider.credentials ?? {},
    valid: (value) => !provider.requiresCredentials || provider.credentialFields.every(field => Boolean(value[field.key]?.trim())),
    save: async (value) => { await api.saveProvider(provider.id, { credentials: value }); onChanged(); },
  });
  const creds = credentials.value;
  const setCreds = credentials.setValue;
  const [testMsg, setTestMsg] = React.useState<{ ok: boolean; error?: string } | null>(null);
  const test = useMutation({ mutationFn: () => api.testProvider(provider.id), onSuccess: (r) => setTestMsg(r), onError: (error) => setTestMsg({ ok: false, error: `Could not test the saved connection. ${error instanceof Error ? error.message : String(error)} Try again.` }) });
  const credentialsKey = JSON.stringify(creds);
  React.useEffect(() => setTestMsg(null), [credentialsKey, provider.enabled]);
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
        <Button size="sm" variant="secondary" onClick={() => { setTestMsg(null); test.mutate(); }} disabled={test.isPending || credentials.dirty || credentials.pending || (provider.requiresCredentials && !provider.hasCredentials)} aria-describedby={hasFields ? `provider-${provider.id}-test-hint` : undefined}>
          {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {hasFields ? 'Test saved credentials' : 'Test connection'}
        </Button>
        {testMsg && (
          <span role={testMsg.ok ? 'status' : 'alert'} className={cn('flex min-w-0 items-start gap-1 break-words text-sm', testMsg.ok ? 'text-success' : 'text-danger')}>
            {testMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {testMsg.ok ? 'Saved connection verified' : testMsg.error || 'Connection failed. Check the saved credentials and try again.'}
          </span>
        )}
      </div>
      {hasFields && <div className="mt-2"><DraftFeedback draft={credentials} /></div>}
      {hasFields && <p id={`provider-${provider.id}-test-hint`} className="mt-2 text-sm text-muted">{credentials.dirty || (provider.requiresCredentials && !provider.hasCredentials) ? 'Save your credential changes before testing.' : 'Connection tests use saved credentials.'}</p>}
      {hasFields && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {provider.credentialFields.map((cf) => (
            <div key={cf.key} className="flex flex-col gap-1">
              <Label htmlFor={`provider-${provider.id}-${cf.key}`}>{cf.label}</Label>
              <SettingsInput id={`provider-${provider.id}-${cf.key}`} type="password" autoComplete="off" disabled={test.isPending || credentials.pending} value={creds[cf.key] ?? ''} onChange={(e) => setCreds((prev) => ({ ...prev, [cf.key]: e.target.value }))} placeholder={cf.label} error={credentials.dirty && provider.requiresCredentials && !creds[cf.key]?.trim() ? `Enter ${cf.label}.` : undefined} />
            </div>
          ))}
        </div>
      )}
      {provider.helpUrl && hasFields && (
        <a href={provider.helpUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">
          How to get credentials →
        </a>
      )}
    </div>
  );
}
