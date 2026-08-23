import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Server, SlidersHorizontal, Bell, Timer, CheckCircle2, XCircle, Loader2, Save, Download, X, Plus } from 'lucide-react';
import { api, type Settings as SettingsType, type ProviderInfo, type DownloaderSettings } from '../lib/api';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch, Badge } from '../components/ui';
import { cn } from '../lib/utils';

type Agg = SettingsType['aggregation'];
type Notif = SettingsType['notifications'];

const AGG_LABELS: { key: keyof Agg; label: string; hint: string }[] = [
  { key: 'mergeTags', label: 'Merge tags', hint: 'Combine tags from all contributing providers' },
  { key: 'mergeGenres', label: 'Merge genres', hint: 'Combine genres from all contributing providers' },
  { key: 'replaceCover', label: 'Replace cover', hint: 'Download & push provider cover art to Kavita' },
  { key: 'replaceVolumeCovers', label: 'Replace volume covers', hint: 'Push per-volume cover art (MangaDex) onto matching Kavita volumes' },
  { key: 'lockCovers', label: 'Lock covers', hint: 'Lock replacement covers so Kavita does not overwrite them' },
];

async function saveFieldConfigRequest(fieldConfig: Record<string, string | null>): Promise<{ ok: boolean }> {
  const res = await fetch('/api/settings/field-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldConfig }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()) as { ok: boolean };
}

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

function useFlash(on: () => void) {
  const [saved, setSaved] = React.useState(false);
  const flash = React.useCallback(() => {
    on();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [on]);
  return { saved, flash };
}

export function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const kavita = useQuery({ queryKey: ['kavita-status'], queryFn: api.kavitaStatus });
  const catalog = useQuery({ queryKey: ['mangadex-catalog'], queryFn: api.mangadexCatalog, refetchInterval: 30_000 });
  const s = settings.data;
  const provs = providers.data ?? [];

  const invalidate = (key: string) => () => qc.invalidateQueries({ queryKey: [key] });
  const conn = React.useState({ baseUrl: '', apiKey: '' });
  const [kavitaMsg, setKavitaMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const kavitaSave = useMutation({
    mutationFn: api.saveConnection,
    onSuccess: (res) => {
      invalidate('kavita-status')();
      setKavitaMsg({ ok: res.connected, text: res.test });
    },
  });

  const [order, setOrder] = React.useState<string[]>([]);
  const dragIndex = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (s) setOrder(s.priorities);
  }, [s?.priorities]);
  const savePriorities = useMutation({ mutationFn: api.savePriorities, onSuccess: invalidate('settings') });
  const buildCatalog = useMutation({
    mutationFn: () => api.enqueue('mangadex-catalog'),
    onSuccess: () => { invalidate('jobs')(); },
  });
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

  const [agg, setAgg] = React.useState<Agg>({ mergeTags: true, mergeGenres: true, replaceCover: true, replaceVolumeCovers: true, lockCovers: false });
  React.useEffect(() => {
    if (s) setAgg(s.aggregation);
  }, [s?.aggregation]);
  const aggFlash = useFlash(invalidate('settings'));
  const saveAgg = useMutation({ mutationFn: api.saveAggregation });

  const [fieldConfig, setFieldConfig] = React.useState<Record<string, string | null>>({});
  React.useEffect(() => {
    if (s) setFieldConfig(s.fieldConfig);
  }, [s?.fieldConfig]);
  const fieldsFlash = useFlash(invalidate('settings'));
  const saveFields = useMutation({ mutationFn: saveFieldConfigRequest });

  const [notif, setNotif] = React.useState<Notif>({ discord: { enabled: false, webhookUrl: '' }, apprise: { enabled: false, url: '' } });
  React.useEffect(() => {
    if (s) setNotif(s.notifications);
  }, [s?.notifications]);
  const notifFlash = useFlash(invalidate('settings'));
  const saveNotif = useMutation({ mutationFn: api.saveNotifications });
  const [notifMsg, setNotifMsg] = React.useState<{ discord: string; apprise: string } | null>(null);
  const testNotif = useMutation({ mutationFn: api.testNotifications, onSuccess: (r) => setNotifMsg(r) });

  const [poll, setPoll] = React.useState('30');
  React.useEffect(() => {
    if (s) setPoll(String(s.pollInterval));
  }, [s?.pollInterval]);
  const pollFlash = useFlash(invalidate('settings'));
  const savePoll = useMutation({ mutationFn: () => api.savePollInterval(Number(poll)) });

  if (!s) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">Connect Kavita, configure providers, aggregation and notifications.</p>
      </div>

      <Card>
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
              <Label>Base URL</Label>
              <Input value={conn[0].baseUrl} onChange={(e) => conn[1]({ ...conn[0], baseUrl: e.target.value })} placeholder="http://kavita:5000" />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Auth Key</Label>
              <Input type="password" value={conn[0].apiKey} onChange={(e) => conn[1]({ ...conn[0], apiKey: e.target.value })} placeholder="your Kavita Auth Key" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => kavitaSave.mutate(conn[0])} disabled={kavitaSave.isPending || !conn[0].baseUrl || !conn[0].apiKey}>
              {kavitaSave.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />} Save & test connection
            </Button>
            {kavitaMsg && (
              <span className={cn('flex items-center gap-1 text-sm', kavitaMsg.ok ? 'text-success' : 'text-danger')}>
                {kavitaMsg.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {kavitaMsg.text}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<SlidersHorizontal className="h-4 w-4" />} title="Metadata providers">
          <SaveButton label="Save priority" onClick={() => savePriorities.mutate(order)} disabled={savePriorities.isPending} />
        </SectionHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted">Drag to reorder. Providers are searched top-to-bottom; the first confident match wins. Toggle a provider off to skip it.</p>
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
                  className="flex items-center gap-3 rounded-md border border-border bg-surface-2 p-2"
                >
                  <GripVertical className="h-4 w-4 cursor-grab text-muted" />
                  <span className="w-6 text-center text-xs text-muted">{idx + 1}</span>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="flex-1 text-sm font-medium">{p.name}</span>
                  <Switch checked={p.enabled} onCheckedChange={(c) => api.saveProvider(p.id, { enabled: c }).then(invalidate('providers'))} />
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
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div>
              <p className="text-xs font-semibold text-muted">MangaDex adult catalog</p>
              <p className="text-xs text-muted">
                {catalog.data && catalog.data.count > 0
                  ? `${catalog.data.count.toLocaleString()} titles · last refreshed ${new Date(catalog.data.lastRefreshedAt ?? Date.now()).toLocaleString()}`
                  : 'Not built yet — adult-catalog matching is unavailable until it is.'}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => buildCatalog.mutate()} disabled={buildCatalog.isPending}>
              {buildCatalog.isPending ? 'Queued…' : 'Build / refresh'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<SlidersHorizontal className="h-4 w-4" />} title="Aggregation">
          <SaveButton label={aggFlash.saved ? 'Saved' : 'Save'} onClick={() => { saveAgg.mutate(agg); aggFlash.flash(); }} disabled={saveAgg.isPending} />
        </SectionHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {AGG_LABELS.map((a) => (
            <div key={a.key} className="flex items-center justify-between rounded-md border border-border bg-surface-2 p-3">
              <div>
                <p className="text-sm">{a.label}</p>
                <p className="text-xs text-muted">{a.hint}</p>
              </div>
              <Switch checked={agg[a.key]} onCheckedChange={(c) => setAgg((prev) => ({ ...prev, [a.key]: c }))} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<SlidersHorizontal className="h-4 w-4" />} title="Field sourcing">
          <SaveButton label={fieldsFlash.saved ? 'Saved' : 'Save'} onClick={() => { saveFields.mutate(fieldConfig); fieldsFlash.flash(); }} disabled={saveFields.isPending} />
        </SectionHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted">Choose which provider supplies each field. “Primary” uses the matching provider; blank leaves the field unchanged.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {s.fields.map((field) => (
              <div key={field} className="flex items-center gap-2">
                <span className="w-32 text-sm capitalize">{field.replace(/_/g, ' ')}</span>
                <Select value={fieldConfig[field] ?? ''} onChange={(e) => setFieldConfig((prev) => ({ ...prev, [field]: e.target.value || null }))} className="flex-1">
                  <option value="">Primary</option>
                  {provs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<Bell className="h-4 w-4" />} title="Notifications">
          <div className="flex items-center gap-2">
            <SaveButton label={notifFlash.saved ? 'Saved' : 'Save'} onClick={() => { saveNotif.mutate(notif); notifFlash.flash(); }} disabled={saveNotif.isPending} />
            <Button size="sm" variant="outline" onClick={() => testNotif.mutate()} disabled={testNotif.isPending}>
              Test
            </Button>
          </div>
        </SectionHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-sm">Discord webhook</p>
              <Switch checked={notif.discord.enabled} onCheckedChange={(c) => setNotif((n) => ({ ...n, discord: { ...n.discord, enabled: c } }))} />
            </div>
            <Input value={notif.discord.webhookUrl} onChange={(e) => setNotif((n) => ({ ...n, discord: { ...n.discord, webhookUrl: e.target.value } }))} placeholder="https://discord.com/api/webhooks/…" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-sm">Apprise</p>
              <Switch checked={notif.apprise.enabled} onCheckedChange={(c) => setNotif((n) => ({ ...n, apprise: { ...n.apprise, enabled: c } }))} />
            </div>
            <Input value={notif.apprise.url} onChange={(e) => setNotif((n) => ({ ...n, apprise: { ...n.apprise, url: e.target.value } }))} placeholder="ntfy://, gotify://, discord://, telegram://…" />
          </div>
          {notifMsg && (
            <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-3 text-xs">
              <span className={notifMsg.discord.startsWith('OK') ? 'text-success' : 'text-danger'}>Discord: {notifMsg.discord}</span>
              <span className={notifMsg.apprise.startsWith('OK') ? 'text-success' : 'text-danger'}>Apprise: {notifMsg.apprise}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<Timer className="h-4 w-4" />} title="Auto-scan interval">
          <SaveButton label={pollFlash.saved ? 'Saved' : 'Save'} onClick={() => { savePoll.mutate(); pollFlash.flash(); }} disabled={savePoll.isPending || !poll || Number(poll) < 1} />
        </SectionHeader>
        <CardContent className="flex items-center gap-3">
          <Input type="number" min={1} value={poll} onChange={(e) => setPoll(e.target.value)} className="w-28" />
          <span className="text-sm text-muted">minutes between background scans for newly ingested series</span>
        </CardContent>
      </Card>

      <DownloaderSettingsCard />
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
    for (const p of parts) {
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1">
      <Label>nHentai banned tags</Label>
      <p className="text-xs text-muted">Galleries carrying any of these tags never appear in nHentai searches. Separate multiple tags with commas.</p>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 py-1">
          {value.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
              {tag}
              <button type="button" onClick={() => onChange(value.filter((t) => t !== tag))} className="rounded p-0.5 hover:bg-danger/30" aria-label={`Remove ${tag}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          placeholder="e.g. loli, big breasts, nsfw"
          className="flex-1"
        />
        <Button size="sm" variant="outline" onClick={addTag} disabled={!draft.trim()}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

function DownloaderSettingsCard() {
  const qc = useQueryClient();
  const dl = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  const [dlSettings, setDlSettings] = React.useState<DownloaderSettings | null>(null);
  React.useEffect(() => {
    if (dl.data) setDlSettings(dl.data);
  }, [dl.data]);
  const flash = useFlash(() => qc.invalidateQueries({ queryKey: ['downloader-settings'] }));
  const save = useMutation({ mutationFn: (s: DownloaderSettings) => api.saveDownloaderSettings(s) });

  if (!dlSettings) {
    return (
      <Card>
        <SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader" />
        <CardContent className="flex items-center gap-2 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <SectionHeader icon={<Download className="h-4 w-4" />} title="Doujinshi downloader">
        <SaveButton label={flash.saved ? 'Saved' : 'Save'} onClick={() => { save.mutate(dlSettings); flash.flash(); }} disabled={save.isPending} />
      </SectionHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label>Output folder</Label>
          <Input value={dlSettings.downloadDirectory} onChange={(e) => setDlSettings({ ...dlSettings, downloadDirectory: e.target.value })} placeholder="/path/to/kavita/library or /downloads" />
          <p className="text-xs text-muted">Absolute path on this machine. Point it at a Kavita library folder to have new media picked up automatically.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label>Output format</Label>
            <Select value={dlSettings.format} onChange={(e) => setDlSettings({ ...dlSettings, format: e.target.value as 'cbz' | 'folder' })}>
              <option value="cbz">Compressed .cbz archive (recommended)</option>
              <option value="folder">Raw image folder</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Max concurrent downloads</Label>
            <Input type="number" min={1} max={10} value={dlSettings.maxConcurrentDownloads} onChange={(e) => setDlSettings({ ...dlSettings, maxConcurrentDownloads: Math.max(1, Number(e.target.value) || 1) })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Max image concurrency</Label>
            <Input type="number" min={1} max={20} value={dlSettings.maxImageConcurrency} onChange={(e) => setDlSettings({ ...dlSettings, maxImageConcurrency: Math.max(1, Number(e.target.value) || 1) })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Request delay (ms)</Label>
            <Input type="number" min={0} step={50} value={dlSettings.requestDelayMs} onChange={(e) => setDlSettings({ ...dlSettings, requestDelayMs: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label>nHentai API key</Label>
          <Input type="password" value={dlSettings.nhentaiApiKey} onChange={(e) => setDlSettings({ ...dlSettings, nhentaiApiKey: e.target.value })} placeholder="optional — NHENTAI_API_KEY env var is used as a fallback" autoComplete="off" />
          <p className="text-xs text-muted">Optional key from nhentai.net for higher API rate limits. Leave blank to use the NHENTAI_API_KEY environment variable, if set.</p>
        </div>

        <BannedTagsEditor value={dlSettings.nhentaiBannedTags ?? []} onChange={(tags) => setDlSettings({ ...dlSettings, nhentaiBannedTags: tags })} />

        <div className="flex items-center justify-between rounded-md border border-border bg-surface-2 p-3">
          <div>
            <p className="text-sm">Auto-sync Kavita</p>
            <p className="text-xs text-muted">Trigger a library scan in Kavita after each download completes.</p>
          </div>
          <Switch checked={dlSettings.autoSyncKavita} onCheckedChange={(c) => setDlSettings({ ...dlSettings, autoSyncKavita: c })} />
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCreds({ provider, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  const [creds, setCreds] = React.useState<Record<string, string>>({});
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
              await api.saveProvider(provider.id, { credentials: creds });
              onChanged();
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
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
              <Label>{cf.label}</Label>
              <Input value={creds[cf.key] ?? ''} onChange={(e) => setCreds((prev) => ({ ...prev, [cf.key]: e.target.value }))} placeholder={cf.label} />
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