import * as React from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GripVertical,
  Plug,
  FolderTree,
  ListOrdered,
  SlidersHorizontal,
  Bell,
  Timer,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Download,
  X,
  Plus,
  ArrowUp,
  ArrowDown,
  LockKeyhole,
  Monitor,
  Moon,
  Sun,
  Palette,
  KeyRound,
  Key,
  RotateCcw,
  Save,
} from "lucide-react";
import {
  api,
  ApiError,
  type Settings as SettingsType,
  type ProviderInfo,
  type DownloaderSettings,
  type LibraryPathMapping,
  type EhentaiSite,
  type EhentaiSessionInput,
  type EhentaiSiteAccess,
} from "../lib/api";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Badge,
  PageHeader,
  ErrorState,
  SegmentedTabs,
  SegmentedControl,
  TabPanel,
  Disclosure,
  Skeleton,
} from "../components/ui";
import { Switch } from "../components/switch";
import { ConfirmDialog } from "../components/dialog";
const AppUpdatesCard = React.lazy(() =>
  import("../components/AppUpdatesCard").then((m) => ({
    default: m.AppUpdatesCard,
  }))
);
import { cn, timeAgo } from "../lib/utils";
import { toast } from "../lib/toast";
import { useAuth } from "../lib/AuthContext";
import { useTheme, type Theme } from "../lib/theme";
import {
  DraftFeedback,
  useSettingsDraft,
  useSettingsNavigation,
} from "../lib/SettingsDrafts";

type Notif = SettingsType["notifications"];
const DEFAULT_NOTIFICATION_DRAFT: Notif = {
  discord: { enabled: false, webhookUrl: "" },
  revision: 0,
  destinationIdentity: "",
};
const SETTINGS_TABS = [
  { id: "kavita", label: "Kavita" },
  { id: "sources", label: "Sources" },
  { id: "downloads", label: "Downloads" },
  { id: "notifications", label: "Notifications" },
  { id: "account", label: "Account" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
const SETTINGS_TAB_ORDER = SETTINGS_TABS.map((tab) => tab.id);
/** Tab ids from before the regrouping, so existing links keep working. */
const LEGACY_TABS: Record<string, SettingsTab> = {
  general: "kavita",
  providers: "sources",
  downloader: "downloads",
};

/** Where each draft lives, for the tab dots and for jumping to a field that needs fixing. */
function draftLocation(id: string): { tab: SettingsTab; section: string } {
  if (id === "connection")
    return { tab: "kavita", section: "kavita-connection" };
  if (id === "library-folders")
    return { tab: "kavita", section: "library-folders" };
  if (id === "poll" || id === "match-refresh")
    return { tab: "kavita", section: "auto-scan" };
  if (id === "priorities" || id.startsWith("provider:"))
    return { tab: "sources", section: "metadata-providers" };
  if (id === "ehentai-account")
    return { tab: "sources", section: "ehentai-account" };
  if (id === "nhentai-api-key") return { tab: "sources", section: "nhentai" };
  if (id === "downloader") return { tab: "downloads", section: "downloader" };
  if (id === "notifications")
    return { tab: "notifications", section: "notifications" };
  return { tab: "account", section: "account-security" };
}

/** Draft ids whose field errors should show even on untouched fields (after a save attempt). */
const RevealContext = React.createContext<ReadonlySet<string>>(new Set());
const useRevealed = (id: string) => React.useContext(RevealContext).has(id);

function SectionHeader({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
      <CardTitle as="h2" className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>{" "}
        <span className="break-words">{title}</span>
      </CardTitle>
      {children ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      ) : null}
    </CardHeader>
  );
}

type Draftish = {
  status: "clean" | "dirty" | "pending" | "saved" | "error";
  error: string;
  valid: boolean;
  dirty: boolean;
  pending: boolean;
  discard: () => void;
};
/** A section's save state plus a way to undo just that section. Saving lives in the page save bar. */
function SectionStatus({
  draft,
  label,
  hideSaved = false,
  hideError = false,
}: {
  draft: Draftish;
  label: string;
  hideSaved?: boolean;
  hideError?: boolean;
}) {
  return (
    <>
      <DraftFeedback
        draft={draft}
        hideSaved={hideSaved}
        hideError={hideError}
      />
      {draft.dirty && !draft.pending && (
        <Button
          size="sm"
          variant="ghost"
          onClick={draft.discard}
          aria-label={`Revert ${label} changes`}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Revert
        </Button>
      )}
    </>
  );
}

/** Keep the instruction and validation message attached to their field. */
function SettingsInput({
  id,
  error,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  error?: string;
  hint?: React.ReactNode;
}) {
  const describedBy =
    [
      props["aria-describedby"],
      hint ? `${id}-hint` : "",
      error ? `${id}-error` : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <>
      <Input
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}

/** An external help link that keeps a full touch target on phones. */
function HelpLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-11 items-center self-start text-sm text-primary underline underline-offset-2 sm:min-h-0"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Field-level validation: show a field's error only after that field was edited and blurred. */
function useFieldTouched() {
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const onBlur = (key: string) => () =>
    setTouched((current) =>
      current[key] ? current : { ...current, [key]: true }
    );
  return { touched, onBlur };
}

function httpUrlError(value: string, httpsOnly = false) {
  try {
    const url = new URL(value);
    if (
      httpsOnly
        ? url.protocol === "https:"
        : ["http:", "https:"].includes(url.protocol)
    )
      return "";
  } catch {
    /* The field explains the expected URL format. */
  }
  return httpsOnly
    ? "Enter a complete URL starting with https://."
    : "Enter a complete URL starting with http:// or https://.";
}

function numberError(
  value: string | number,
  min: number,
  max?: number,
  integer = false
) {
  const number = Number(value);
  if (
    String(value).trim() !== "" &&
    Number.isFinite(number) &&
    number >= min &&
    (max === undefined || number <= max) &&
    (!integer || Number.isInteger(number))
  )
    return "";
  return max !== undefined
    ? `Enter ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`
    : `Enter ${integer ? "a whole number" : "a number"} of ${min} or more.`;
}

function webhookLabel(url: string) {
  if (!url) return "no webhook URL";
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${parsed.hostname}${last ? ` · …${last.slice(-6)}` : ""}`;
  } catch {
    return "invalid webhook URL";
  }
}

function notifSummary(notif: Notif) {
  return `Discord ${notif.discord.enabled ? "on" : "off"} · ${webhookLabel(notif.discord.webhookUrl)}`;
}

function folderError(value: string) {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value.trim()) && !value.includes("\0")
    ? ""
    : "Enter an absolute folder path, such as /downloads or C:\\Manga.";
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};
const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Turn a Kavita connection failure into a cause the user can act on. The
 * server already explains HTTP failures (bad key, wrong path); network-level
 * failures arrive as bare runtime messages such as "fetch failed".
 */
function describeKavitaProblem(raw: string): {
  cause: string;
  detail?: string;
} {
  const text = raw
    .replace(/^Saved, but connection test failed:\s*/i, "")
    .trim();
  if (/ECONNREFUSED/i.test(text))
    return {
      cause:
        "Kavita refused the connection. Check the port and that Kavita is running.",
      detail: text,
    };
  if (/ETIMEDOUT|timed? ?out|aborted/i.test(text))
    return {
      cause:
        "Kavita did not answer in time. Check the address and the network between H-Tosho and Kavita.",
      detail: text,
    };
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|network|socket/i.test(text))
    return {
      cause:
        "H-Tosho could not reach this address. Check the host name and port, and that Kavita is running and reachable from H-Tosho's container.",
      detail: text,
    };
  return { cause: sentence(text || "The connection test failed.") };
}

type Notice = {
  tone: "success" | "warning" | "danger";
  title: string;
  cause?: string;
  detail?: string;
  canRestore?: boolean;
};
function NoticeLine({
  notice,
  children,
}: {
  notice: Notice;
  children?: React.ReactNode;
}) {
  const Icon =
    notice.tone === "success"
      ? CheckCircle2
      : notice.tone === "warning"
        ? AlertTriangle
        : XCircle;
  return (
    <div
      role={notice.tone === "success" ? "status" : "alert"}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm",
        notice.tone === "success"
          ? "border-success/30 bg-success/10"
          : notice.tone === "warning"
            ? "border-warning/40 bg-warning/10"
            : "border-danger/40 bg-danger/10"
      )}
    >
      <p className="flex min-w-0 items-start gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            notice.tone === "success"
              ? "text-success"
              : notice.tone === "warning"
                ? "text-warning"
                : "text-danger"
          )}
        />
        <span className="min-w-0 break-words">
          <span className="font-medium">{notice.title}</span>
          {notice.cause && <> {notice.cause}</>}
        </span>
      </p>
      {notice.detail && (
        <p className="break-words pl-6 text-xs text-muted">
          Details: <span className="font-mono">{notice.detail}</span>
        </p>
      )}
      {children && <div className="flex flex-wrap gap-2 pl-6">{children}</div>}
    </div>
  );
}

/** One place to save or discard every changed section, pinned while anything is unsaved. */
function SettingsSaveBar({ onShow }: { onShow: (ids: string[]) => void }) {
  const drafts = useSettingsNavigation();
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/i.test(navigator.platform);
  React.useEffect(() => {
    if (drafts.dirty) setResult((current) => (current?.ok ? null : current));
  }, [drafts.dirty]);
  React.useEffect(() => {
    if (!result?.ok) return;
    const timer = window.setTimeout(() => setResult(null), 3000);
    return () => window.clearTimeout(timer);
  }, [result]);
  const save = React.useCallback(async () => {
    if (saving || drafts.pending || !drafts.dirty) return;
    if (drafts.invalid.length) {
      onShow(drafts.invalid.map((entry) => entry.id));
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      await drafts.saveAll();
      setResult({ ok: true, text: "All changes saved." });
    } catch (cause) {
      setResult({
        ok: false,
        text: `${cause instanceof Error ? cause.message : String(cause)} Your other changes are kept.`,
      });
    } finally {
      setSaving(false);
    }
  }, [drafts, onShow, saving]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s" ||
        event.altKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);
  if (!drafts.dirty && !saving && !result) return null;
  const busy = saving || drafts.pending;
  const labels = drafts.labels;
  const summary =
    labels.length === 1
      ? labels[0]
      : labels.length === 2
        ? `${labels[0]} and ${labels[1]}`
        : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return (
    <div
      role="region"
      aria-label="Unsaved settings"
      className="settings-save-bar sticky z-20 mt-2 flex flex-col gap-3 rounded-xl border border-border-2 bg-surface p-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
    >
      <div role="status" aria-live="polite" className="min-w-0 flex-1 text-sm">
        {busy ? (
          <p className="flex items-center gap-2 text-muted">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{" "}
            Saving changes…
          </p>
        ) : result && !result.ok ? (
          <p className="flex items-start gap-2 break-words text-danger">
            <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {result.text}
          </p>
        ) : result?.ok && !drafts.dirty ? (
          <p className="flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
            {result.text}
          </p>
        ) : drafts.invalid.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-2 text-danger">
            <span className="break-words">
              Fix the highlighted fields in{" "}
              {drafts.invalid.map((entry) => entry.label).join(", ")} before
              saving.
            </span>
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => onShow(drafts.invalid.map((entry) => entry.id))}
            >
              Show me
            </button>
          </p>
        ) : (
          <p className="line-clamp-2 break-words">
            <span className="font-medium">Unsaved changes</span>
            <span className="text-muted"> in {summary}</span>
          </p>
        )}
      </div>
      {drafts.dirty && (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            className="flex-1 sm:flex-none"
            disabled={busy}
            onClick={() => {
              drafts.discardAll();
              setResult(null);
            }}
          >
            Discard
          </Button>
          <Button
            className="flex-1 sm:flex-none"
            disabled={busy}
            onClick={() => void save()}
            aria-keyshortcuts={isMac ? "Meta+S" : "Control+S"}
            title={isMac ? "Save changes (⌘S)" : "Save changes (Ctrl+S)"}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}{" "}
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  const options: { id: Theme; label: string; icon: typeof Monitor }[] = [
    { id: "system", label: "System", icon: Monitor },
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <Card id="appearance" className="animate-fade-up">
      <SectionHeader
        icon={<Palette className="h-4 w-4" />}
        title="Appearance"
      />
      <CardContent>
        <SegmentedControl
          items={options.map((option) => ({
            id: option.id,
            label: option.label,
            icon: <option.icon className="h-4 w-4 shrink-0" />,
          }))}
          value={theme}
          onChange={setTheme}
          label="Theme"
          className="sm:max-w-md"
          itemClassName="px-2 text-xs sm:px-3 sm:text-sm"
        />
        <p className="mt-2 text-sm text-muted">
          Applies immediately. System follows your device's light or dark
          setting.
        </p>
      </CardContent>
    </Card>
  );
}

function AccountSettingsCard() {
  const auth = useAuth();
  const { touched, onBlur } = useFieldTouched();
  const revealed = useRevealed("account");
  const accountSource = React.useMemo(
    () => ({
      currentPassword: "",
      username: auth.username ?? "",
      password: "",
      confirmPassword: "",
    }),
    [auth.username]
  );
  const account = useSettingsDraft({
    id: "account",
    label: "Account security",
    initial: accountSource,
    source: accountSource,
    valid: (value) =>
      Boolean(
        value.currentPassword &&
        value.username.trim() &&
        value.username.length <= 100 &&
        value.password.length >= 8 &&
        value.password === value.confirmPassword
      ),
    save: async (value) => {
      await api.changeCredentials(
        value.currentPassword,
        value.username,
        value.password
      );
      await auth.refresh();
      return {
        currentPassword: "",
        username: value.username,
        password: "",
        confirmPassword: "",
      };
    },
  });
  const { currentPassword, username, password, confirmPassword } =
    account.value;
  const show = (key: string) => touched[key] || revealed;
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (revealed && !account.valid) setOpen(true);
  }, [revealed, account.valid]);
  const setField =
    (key: keyof typeof account.value) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      account.setValue((value) => ({ ...value, [key]: next }));
    };
  const passwordShort = password.length < 8;
  return (
    <Card id="account-security" className="animate-fade-up scroll-mt-16">
      <SectionHeader
        icon={<LockKeyhole className="h-4 w-4" />}
        title="Account security"
      >
        <SectionStatus draft={account} label="account" />
      </SectionHeader>
      <Disclosure
        label="Change username or password"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        summaryClassName="p-3 text-foreground sm:p-4"
      >
        <CardContent className="pt-0 sm:pt-0">
          <form
            className="flex max-w-xl flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              account.submit();
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="current-password">Current password</Label>
              <SettingsInput
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={setField("currentPassword")}
                onBlur={onBlur("currentPassword")}
                hint="Required to confirm any change to this account."
                error={
                  show("currentPassword") && !currentPassword
                    ? "Enter your current password to confirm this change."
                    : undefined
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="account-username">Username</Label>
              <SettingsInput
                id="account-username"
                autoComplete="username"
                required
                maxLength={100}
                value={username}
                onChange={setField("username")}
                onBlur={onBlur("username")}
                error={
                  show("username") && !username.trim()
                    ? "Enter a username."
                    : undefined
                }
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="new-password">New password</Label>
                <SettingsInput
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={setField("password")}
                  onBlur={onBlur("password")}
                  hint={
                    show("password") && passwordShort
                      ? undefined
                      : "At least 8 characters."
                  }
                  error={
                    show("password") && passwordShort
                      ? "Use at least 8 characters."
                      : undefined
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="confirm-new-password">
                  Confirm new password
                </Label>
                <SettingsInput
                  id="confirm-new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={setField("confirmPassword")}
                  onBlur={onBlur("confirmPassword")}
                  error={
                    confirmPassword && password !== confirmPassword
                      ? "The passwords do not match."
                      : show("confirmPassword") &&
                          !passwordShort &&
                          !confirmPassword
                        ? "Enter the new password again."
                        : undefined
                  }
                />
              </div>
            </div>
            {/* Enter submits; the page save bar is the visible Save action. */}
            <button
              type="submit"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
            >
              Save account
            </button>
          </form>
        </CardContent>
      </Disclosure>
    </Card>
  );
}

function KavitaConnectionCard() {
  const qc = useQueryClient();
  const kavita = useQuery({
    queryKey: ["kavita-status"],
    queryFn: api.kavitaStatus,
  });
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const savedBaseUrl = kavita.data ? (kavita.data.baseUrl ?? "") : undefined;
  const connectionSource = React.useMemo(
    () =>
      savedBaseUrl === undefined
        ? undefined
        : { baseUrl: savedBaseUrl, apiKey: "" },
    [savedBaseUrl]
  );
  const connection = useSettingsDraft({
    id: "connection",
    label: "Kavita connection",
    initial: { baseUrl: "", apiKey: "" },
    source: connectionSource,
    valid: (value) =>
      !httpUrlError(value.baseUrl) &&
      Boolean(value.apiKey.trim() || kavita.data?.hasApiKey),
    save: async (value) => {
      const result = await api.saveConnection(value);
      if (!result.saved) throw new Error(result.test);
      const connectionQueries = new Set([
        "libraries",
        "library-series",
        "series",
        "identify",
        "low-confidence",
        "review-series",
        "library-override",
        "jobs",
        "job",
        "logs",
        "history",
        "field-policy",
        "metadata-history",
        "metadata-history-detail",
        "cbz-roots",
        "cbz-series-files",
        "recommendation-libraries",
        "home-matches",
        "home-activity",
      ]);
      await qc.cancelQueries({
        predicate: (query) => connectionQueries.has(String(query.queryKey[0])),
      });
      qc.removeQueries({
        predicate: (query) =>
          connectionQueries.has(String(query.queryKey[0])) &&
          query.getObserversCount() === 0,
      });
      void qc.resetQueries({
        predicate: (query) => connectionQueries.has(String(query.queryKey[0])),
      });
      qc.setQueryData(["kavita-status"], {
        ...kavita.data,
        baseUrl: value.baseUrl,
        configured: true,
        hasApiKey: Boolean(value.apiKey) || kavita.data?.hasApiKey,
        error: result.connected ? null : result.test,
      });
      void qc.invalidateQueries({ queryKey: ["kavita-status"] });
      setNotice(
        result.connected
          ? { tone: "success", title: `Saved. ${sentence(result.test)}` }
          : {
              tone: "warning",
              title: "Saved, but the connection test failed.",
              ...describeKavitaProblem(result.test),
              canRestore: result.canRestore,
            }
      );
      return { ...value, apiKey: "" };
    },
  });
  const conn = connection.value;
  const setConn = connection.setValue;
  const connTouched = useFieldTouched();
  const revealed = useRevealed("connection");
  const testKavita = useMutation({
    // Tests the entered values (or the saved ones when the fields are blank) without persisting anything.
    mutationFn: () =>
      api.testConnection({ baseUrl: conn.baseUrl, apiKey: conn.apiKey }),
    onSuccess: (result) =>
      setNotice(
        result.connected
          ? {
              tone: "success",
              title: `Test passed. ${sentence(result.test)}`,
              cause: connection.dirty
                ? "Save changes to use this connection."
                : undefined,
            }
          : {
              tone: "danger",
              title: "Test failed.",
              ...describeKavitaProblem(result.test),
            }
      ),
    onError: (error) =>
      setNotice({
        tone: "danger",
        title: "Could not run the connection test.",
        cause: `${sentence(error instanceof Error ? error.message : String(error))} Try again.`,
      }),
  });
  const revertConnection = useMutation({
    mutationFn: api.restoreConnection,
    onSuccess: (result) => {
      connection.setValue({ baseUrl: result.baseUrl, apiKey: "" });
      void qc.invalidateQueries({ queryKey: ["kavita-status"] });
      setNotice({ tone: "success", title: "Previous connection restored." });
    },
    onError: (error) =>
      setNotice({
        tone: "danger",
        title: "Could not restore the previous connection.",
        cause: `${sentence(error instanceof Error ? error.message : String(error))} Try again.`,
      }),
  });
  React.useEffect(() => {
    if (connection.dirty) setNotice(null);
  }, [conn.baseUrl, conn.apiKey, connection.dirty]);

  const state = !kavita.data
    ? kavita.isError
      ? "unknown"
      : "checking"
    : !kavita.data.configured
      ? "unconfigured"
      : kavita.data.error
        ? "error"
        : "connected";
  // With no fresh result to report, the saved connection's own problem is the one message.
  const savedProblem: Notice | null = kavita.isError
    ? {
        tone: "danger",
        title: "Could not check the saved connection.",
        cause: `${sentence(kavita.error instanceof Error ? kavita.error.message : String(kavita.error))} Reload the page to try again.`,
      }
    : kavita.data?.configured && kavita.data.error
      ? {
          tone: "danger",
          title: "Your saved Kavita connection isn't working.",
          ...describeKavitaProblem(kavita.data.error),
        }
      : null;
  const shown = testKavita.isPending
    ? null
    : (notice ?? (connection.dirty ? null : savedProblem));
  const keyHint = kavita.data?.hasApiKey
    ? "A key is saved. Leave blank to keep it. To replace it, create an admin key in Kavita under User Settings → Manage Auth Keys."
    : "Create an admin key in Kavita under User Settings → Manage Auth Keys.";

  return (
    <Card
      id="kavita-connection"
      className={cn(
        "animate-fade-up scroll-mt-16",
        state === "unconfigured" && "border-primary/40"
      )}
    >
      <SectionHeader
        icon={<Plug className="h-4 w-4" />}
        title="Kavita connection"
      >
        <SectionStatus draft={connection} label="connection" hideSaved />
        <Badge
          role="status"
          tone={
            state === "connected"
              ? "success"
              : state === "error"
                ? "danger"
                : state === "unconfigured"
                  ? "warning"
                  : "muted"
          }
        >
          {state === "checking"
            ? "Checking…"
            : state === "unknown"
              ? "Status unavailable"
              : state === "unconfigured"
                ? "Not configured"
                : state === "error"
                  ? "Can't reach Kavita"
                  : `Connected · Kavita ${kavita.data?.version ?? ""}`.trim()}
        </Badge>
      </SectionHeader>
      <CardContent className="flex flex-col gap-3">
        {state === "unconfigured" && (
          <p className="text-sm">
            <span className="font-medium">Start here.</span>{" "}
            <span className="text-muted">
              Libraries, metadata review and auto-scan all need a working
              connection to your Kavita server.
            </span>
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="kavita-base-url">Server address</Label>
            <SettingsInput
              id="kavita-base-url"
              type="url"
              autoComplete="url"
              spellCheck={false}
              disabled={connection.pending || testKavita.isPending}
              value={conn.baseUrl}
              onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })}
              onBlur={connTouched.onBlur("baseUrl")}
              placeholder="e.g. http://kavita:5000"
              error={
                connTouched.touched.baseUrl || revealed
                  ? httpUrlError(conn.baseUrl) || undefined
                  : undefined
              }
              hint="The address without /api. In Docker, use an address reachable from H-Tosho's container."
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="kavita-auth-key">Auth Key</Label>
            <SettingsInput
              id="kavita-auth-key"
              type="password"
              autoComplete="off"
              disabled={connection.pending || testKavita.isPending}
              value={conn.apiKey}
              onChange={(e) => setConn({ ...conn, apiKey: e.target.value })}
              onBlur={connTouched.onBlur("apiKey")}
              placeholder={
                kavita.data?.hasApiKey ? "Saved key" : "Kavita admin Auth Key"
              }
              error={
                (connTouched.touched.apiKey || revealed) &&
                !conn.apiKey.trim() &&
                !kavita.data?.hasApiKey
                  ? "Enter an Auth Key for a Kavita admin account."
                  : undefined
              }
              hint={keyHint}
            />
            <HelpLink href="https://www.kavitareader.com/docs/api/">
              Kavita Auth Key help
            </HelpLink>
          </div>
        </div>
        {shown && (
          <NoticeLine notice={shown}>
            {shown.canRestore && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => revertConnection.mutate()}
                disabled={revertConnection.isPending}
              >
                {revertConnection.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}{" "}
                Revert to previous connection
              </Button>
            )}
          </NoticeLine>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setNotice(null);
              testKavita.mutate();
            }}
            disabled={connection.pending || testKavita.isPending}
            aria-describedby="kavita-test-hint"
          >
            {testKavita.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}{" "}
            {testKavita.isPending ? "Testing…" : "Test connection"}
          </Button>
          <p id="kavita-test-hint" className="text-sm text-muted">
            {connection.dirty
              ? "Tests the values above without saving them."
              : "Tests the saved connection."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Kavita reports its own mount paths; local folders are where H-Tosho can actually edit CBZs. */
function KavitaLibraryFoldersCard({ connected }: { connected: boolean }) {
  const qc = useQueryClient();
  const libs = useQuery({
    queryKey: ["libraries"],
    queryFn: api.libraries,
    enabled: connected,
  });
  const dl = useQuery({
    queryKey: ["downloader-settings"],
    queryFn: api.downloaderSettings,
  });
  const revealed = useRevealed("library-folders");
  const foldersSource = React.useMemo(
    () => dl.data?.libraryPathMappings ?? (dl.data ? [] : undefined),
    [dl.data]
  );
  const folders = useSettingsDraft<LibraryPathMapping[]>({
    id: "library-folders",
    label: "Kavita library folders",
    initial: [],
    source: foldersSource,
    valid: (value) =>
      value.every(
        (mapping) =>
          !folderError(mapping.kavitaPath) && !folderError(mapping.localPath)
      ),
    save: async (value) => {
      const { libraryPathMappings } = await api.saveLibraryPathMappings(value);
      qc.setQueryData<DownloaderSettings>(["downloader-settings"], (current) =>
        current ? { ...current, libraryPathMappings } : current
      );
      void qc.invalidateQueries({ queryKey: ["cbz-roots"] });
      void qc.invalidateQueries({ queryKey: ["cbz-series-files"] });
      return libraryPathMappings;
    },
  });
  const draft = folders.value;
  const setDraft = folders.setValue;
  const rootKey = (value: string) => {
    const root = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(root) || root.startsWith("//")
      ? root.toLowerCase()
      : root;
  };
  const libraryPaths = (libs.data ?? []).flatMap((lib) =>
    (lib.paths ?? (lib.path ? [lib.path] : [])).map((remote) => ({
      id: lib.id,
      name: lib.name,
      remote,
    }))
  );
  const known = new Set(libraryPaths.map(({ remote }) => rootKey(remote)));
  const other = (draft ?? [])
    .map((mapping, index) => ({ mapping, index }))
    .filter(({ mapping }) => !known.has(rootKey(mapping.kavitaPath)));
  const setPath = (remote: string, local: string) => {
    setDraft((current) => {
      const next = [...(current ?? [])];
      const index = next.findIndex(
        (mapping) => rootKey(mapping.kavitaPath) === rootKey(remote)
      );
      if (index < 0 && local)
        next.push({ kavitaPath: remote, localPath: local });
      else if (index >= 0 && !local) next.splice(index, 1);
      else if (index >= 0)
        next[index] = { kavitaPath: remote, localPath: local };
      return next;
    });
  };
  const waitingForKavita = !connected && draft.length === 0;

  return (
    <Card id="library-folders" className="animate-fade-up scroll-mt-16">
      <SectionHeader
        icon={<FolderTree className="h-4 w-4" />}
        title="Kavita library folders"
      >
        <SectionStatus draft={folders} label="library folder" />
      </SectionHeader>
      <CardContent className="flex flex-col gap-3">
        {dl.isError ? (
          <ErrorState
            title="Could not load library folders"
            description={
              dl.error instanceof Error ? dl.error.message : String(dl.error)
            }
            onRetry={() => void dl.refetch()}
          />
        ) : !dl.data ? (
          <p role="status" className="text-sm text-muted">
            Loading library folders…
          </p>
        ) : waitingForKavita ? (
          <p className="text-sm text-muted">
            Connect Kavita first. Each of its library folders will be listed
            here so you can tell H-Tosho where that folder is mounted.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Where each Kavita library folder is mounted inside H-Tosho, with
              write access, so H-Tosho can edit CBZ files and titles. This does
              not change the download output folder.
            </p>
            {libs.isError && (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="break-words text-sm text-danger">
                  Could not load Kavita libraries.{" "}
                  {sentence(
                    libs.error instanceof Error
                      ? libs.error.message
                      : String(libs.error)
                  )}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void libs.refetch()}
                >
                  Retry
                </Button>
              </div>
            )}
            {libraryPaths.map(({ id, name, remote }) => {
              const localPath =
                draft.find(
                  (mapping) => rootKey(mapping.kavitaPath) === rootKey(remote)
                )?.localPath ?? "";
              return (
                <div key={`${id}:${remote}`} className="flex flex-col gap-1">
                  <Label htmlFor={`library-folder-${id}-${remote}`}>
                    {name}{" "}
                    <span className="font-mono text-xs text-muted">
                      {remote}
                    </span>
                  </Label>
                  <SettingsInput
                    id={`library-folder-${id}-${remote}`}
                    aria-label={`H-Tosho folder for ${name}: ${remote}`}
                    aria-describedby="library-folders-hint"
                    value={localPath}
                    onChange={(e) => setPath(remote, e.target.value)}
                    placeholder="Same as Kavita's path"
                    error={
                      localPath
                        ? folderError(localPath) || undefined
                        : undefined
                    }
                  />
                </div>
              );
            })}
            {other.map(({ mapping, index }) => (
              <div
                key={index}
                className="grid min-w-0 grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <Label htmlFor={`extra-kavita-path-${index}`}>
                    Kavita folder
                  </Label>
                  <SettingsInput
                    id={`extra-kavita-path-${index}`}
                    value={mapping.kavitaPath}
                    onChange={(e) =>
                      setDraft(
                        draft.map((m, i) =>
                          i === index ? { ...m, kavitaPath: e.target.value } : m
                        )
                      )
                    }
                    placeholder="e.g. /media/Manga"
                    error={
                      mapping.kavitaPath || revealed
                        ? folderError(mapping.kavitaPath) || undefined
                        : undefined
                    }
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <Label htmlFor={`extra-local-path-${index}`}>
                    H-Tosho folder
                  </Label>
                  <SettingsInput
                    id={`extra-local-path-${index}`}
                    value={mapping.localPath}
                    onChange={(e) =>
                      setDraft(
                        draft.map((m, i) =>
                          i === index ? { ...m, localPath: e.target.value } : m
                        )
                      )
                    }
                    placeholder="e.g. /mnt/manga"
                    error={
                      mapping.localPath || revealed
                        ? folderError(mapping.localPath) || undefined
                        : undefined
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove extra folder mapping ${index + 1}`}
                  onClick={() => setDraft(draft.filter((_, i) => i !== index))}
                >
                  <X className="h-4 w-4" /> Remove
                </Button>
              </div>
            ))}
            <p id="library-folders-hint" className="text-sm text-muted">
              Leave a folder empty when H-Tosho can use Kavita's path as is. Add
              a folder for a nested mount or a root Kavita does not list.
            </p>
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() =>
                setDraft([...draft, { kavitaPath: "", localPath: "" }])
              }
            >
              <Plus className="h-4 w-4" /> Add folder
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AutoScanCard({
  hours,
  refreshDays,
}: {
  hours: number;
  refreshDays: number;
}) {
  const qc = useQueryClient();
  const refresh = useSettingsDraft({
    id: "match-refresh",
    label: "Provider update checks",
    initial: "7",
    source: String(refreshDays),
    valid: (value) => !numberError(value, 0, 60, true),
    save: async (value) => {
      await api.saveMatchRefreshInterval(Number(value));
      qc.setQueryData<SettingsType>(["settings"], (current) =>
        current
          ? { ...current, matchRefreshIntervalDays: Number(value) }
          : current
      );
      return String(Number(value));
    },
  });
  const checkNow = useMutation({
    mutationFn: api.refreshMatchedSeries,
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["home-updates"] });
      toast({
        tone: "info",
        title: result.alreadyRunning
          ? "Already checking for updates"
          : "Checking matched series",
        description:
          "Changes to each series’ matched source appear on Home for review. Nothing is applied automatically.",
      });
    },
    onError: (error) =>
      toast({
        tone: "danger",
        title: "Could not check for provider updates",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const polling = useSettingsDraft({
    id: "poll",
    label: "Auto-scan interval",
    initial: "12",
    source: String(hours),
    valid: (value) => !numberError(value, 0, 576),
    save: async (value) => {
      await api.savePollInterval(Number(value));
      qc.setQueryData<SettingsType>(["settings"], (current) =>
        current ? { ...current, pollIntervalHours: Number(value) } : current
      );
      return String(Number(value));
    },
  });
  return (
    <Card id="auto-scan" className="animate-fade-up scroll-mt-16">
      <SectionHeader
        icon={<Timer className="h-4 w-4" />}
        title="Auto-scan interval"
      >
        <div className="flex flex-wrap items-center gap-2">
          <SectionStatus draft={polling} label="auto-scan" />
          <SectionStatus draft={refresh} label="provider update checks" />
        </div>
      </SectionHeader>
      <CardContent className="flex flex-col gap-1">
        <Label htmlFor="scan-interval">Hours between background scans</Label>
        <SettingsInput
          id="scan-interval"
          type="number"
          inputMode="decimal"
          min={0}
          max={576}
          step="any"
          value={polling.value}
          onChange={(e) => polling.setValue(e.target.value)}
          className="w-full sm:w-28"
          hint="Checks Kavita for newly added series. Up to 576 hours (24 days); 0 turns automatic scans off."
          error={
            polling.dirty
              ? numberError(polling.value, 0, 576) || undefined
              : undefined
          }
        />
        <Label htmlFor="match-refresh-interval" className="mt-4">
          Days between provider update checks
        </Label>
        <SettingsInput
          id="match-refresh-interval"
          type="number"
          inputMode="numeric"
          min={0}
          max={60}
          step={1}
          value={refresh.value}
          onChange={(e) => refresh.setValue(e.target.value)}
          className="w-full sm:w-28"
          hint="Re-reads each matched series from the exact source it is matched to and lists changes on Home for review. A different or better match is never suggested here. Up to 60 days; 0 turns these checks off."
          error={
            refresh.dirty
              ? numberError(refresh.value, 0, 60, true) || undefined
              : undefined
          }
        />
        <Button
          type="button"
          variant="outline"
          className="mt-1 self-start"
          disabled={checkNow.isPending}
          onClick={() => checkNow.mutate()}
        >
          {checkNow.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Check matched series now
        </Button>
      </CardContent>
    </Card>
  );
}

function MetadataProvidersCard({ savedOrder }: { savedOrder: string[] }) {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });
  const provs = providers.data ?? [];
  const priorities = useSettingsDraft({
    id: "priorities",
    label: "Provider order",
    initial: [] as string[],
    source: savedOrder,
    save: async (value) => {
      await api.savePriorities(value);
      qc.setQueryData<SettingsType>(["settings"], (current) =>
        current ? { ...current, priorities: value } : current
      );
    },
  });
  const order = priorities.value;
  const setOrder = priorities.setValue;
  const dragIndex = React.useRef<number | null>(null);
  const [reorderMessage, setReorderMessage] = React.useState("");
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    setReorderMessage(
      `${provs.find((provider) => provider.id === order[from])?.name ?? order[from]} moved to position ${to + 1} of ${order.length}. Save changes to apply.`
    );
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const providerToggle = useMutation({
    mutationFn: (v: { id: string; name: string; enabled: boolean }) =>
      api.saveProvider(v.id, { enabled: v.enabled }),
    onSuccess: (_res, v) => {
      void qc.invalidateQueries({ queryKey: ["providers"] });
      toast({
        tone: "success",
        title: `${v.name} ${v.enabled ? "turned on" : "turned off"}`,
      });
    },
    onError: (error, v) =>
      toast({
        tone: "danger",
        title: `Could not update ${v.name}`,
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <Card id="metadata-providers" className="animate-fade-up scroll-mt-16">
      <SectionHeader
        icon={<ListOrdered className="h-4 w-4" />}
        title="Metadata providers"
      >
        <SectionStatus draft={priorities} label="provider order" />
      </SectionHeader>
      <CardContent className="flex flex-col gap-3">
        {providers.isError ? (
          <ErrorState
            title="Could not load metadata providers"
            description={
              providers.error instanceof Error
                ? providers.error.message
                : String(providers.error)
            }
            onRetry={() => void providers.refetch()}
          />
        ) : providers.isPending ? (
          <p role="status" className="text-sm text-muted">
            Loading metadata providers…
          </p>
        ) : provs.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted">
              No metadata providers are available. Check your installation, then
              reload providers.
            </p>
            <Button variant="outline" onClick={() => void providers.refetch()}>
              Reload providers
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">
              Searched from top to bottom; the first confident match is used.
              Drag or use the arrows to change the order. On/off switches apply
              immediately.
            </p>
            <p role="status" aria-live="polite" className="sr-only">
              {reorderMessage}
            </p>
            <ol className="flex flex-col divide-y divide-border border-y border-border">
              {order.map((id, idx) => {
                const p = provs.find((x) => x.id === id);
                if (!p) return null;
                return (
                  <ProviderRow
                    key={id}
                    provider={p}
                    index={idx}
                    count={order.length}
                    onMove={move}
                    toggling={providerToggle.isPending}
                    onToggle={(enabled) =>
                      providerToggle.mutate({ id: p.id, name: p.name, enabled })
                    }
                    dragProps={{
                      onDragStart: () => {
                        dragIndex.current = idx;
                      },
                      onDragEnd: () => {
                        dragIndex.current = null;
                      },
                      onDrop: () => {
                        const from = dragIndex.current;
                        dragIndex.current = null;
                        if (from !== null) move(from, idx);
                      },
                    }}
                  />
                );
              })}
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One provider: order, on/off, and (when it has any) its credentials and connection test. */
function ProviderRow({
  provider,
  index,
  count,
  onMove,
  toggling,
  onToggle,
  dragProps,
}: {
  provider: ProviderInfo;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  dragProps: {
    onDragStart: () => void;
    onDragEnd: () => void;
    onDrop: () => void;
  };
}) {
  const qc = useQueryClient();
  const { touched, onBlur } = useFieldTouched();
  const draftId = `provider:${provider.id}`;
  const revealed = useRevealed(draftId);
  const credentialsSource = React.useMemo(
    () => provider.credentials ?? {},
    [provider.credentials]
  );
  const credentials = useSettingsDraft<Record<string, string>>({
    id: draftId,
    label: `${provider.name} credentials`,
    initial: {},
    source: credentialsSource,
    valid: (value) =>
      !provider.requiresCredentials ||
      provider.credentialFields.every((field) =>
        Boolean(value[field.key]?.trim())
      ),
    save: async (value) => {
      await api.saveProvider(provider.id, { credentials: value });
      void qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
  const creds = credentials.value;
  const needsSaved = provider.requiresCredentials && !provider.hasCredentials;
  const [open, setOpen] = React.useState(needsSaved && provider.enabled);
  React.useEffect(() => {
    if (revealed && !credentials.valid) setOpen(true);
  }, [revealed, credentials.valid]);
  const [testMsg, setTestMsg] = React.useState<{
    ok: boolean;
    error?: string;
  } | null>(null);
  const test = useMutation({
    mutationFn: () => api.testProvider(provider.id),
    onSuccess: (r) => setTestMsg(r),
    onError: (error) =>
      setTestMsg({
        ok: false,
        error: `Could not run the test. ${sentence(error instanceof Error ? error.message : String(error))} Try again.`,
      }),
  });
  const credentialsKey = React.useMemo(() => JSON.stringify(creds), [creds]);
  React.useEffect(() => setTestMsg(null), [credentialsKey, provider.enabled]);
  const hasFields = provider.credentialFields.length > 0;
  const testBlocked = credentials.dirty
    ? "Save changes first to test the new credentials."
    : needsSaved
      ? "Add and save credentials first."
      : "";
  const testButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        setTestMsg(null);
        test.mutate();
      }}
      disabled={test.isPending || credentials.pending || Boolean(testBlocked)}
      aria-describedby={
        testBlocked ? `provider-${provider.id}-test-hint` : undefined
      }
      aria-label={hasFields ? undefined : `Test ${provider.name} connection`}
    >
      {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{" "}
      {hasFields ? "Test saved credentials" : "Test"}
    </Button>
  );
  const result = testMsg && (
    <p
      role={testMsg.ok ? "status" : "alert"}
      className={cn(
        "flex min-w-0 items-start gap-1.5 break-words text-sm",
        testMsg.ok ? "text-success" : "text-danger"
      )}
    >
      {testMsg.ok ? (
        <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      {testMsg.ok
        ? `${provider.name} is reachable${hasFields ? " with the saved credentials" : ""}.`
        : sentence(
            testMsg.error ||
              "The connection failed. Check the saved credentials and try again."
          )}
    </p>
  );
  // Indent detail content to the provider name: grip + number + colour dot on wide screens.
  const indent = "pl-[2.875rem] sm:pl-[5.125rem]";
  const status = credentials.status !== "clean" && (
    <span
      className={cn(
        "text-xs font-normal",
        credentials.status === "error" ||
          (credentials.dirty && !credentials.valid)
          ? "text-danger"
          : credentials.status === "saved"
            ? "text-success"
            : "text-muted"
      )}
    >
      ·{" "}
      {credentials.status === "pending"
        ? "Saving…"
        : credentials.status === "error"
          ? "Not saved"
          : credentials.status === "saved"
            ? "Saved"
            : credentials.valid
              ? "Unsaved"
              : "Fix highlighted fields"}
    </span>
  );

  return (
    <li
      className="flex min-w-0 flex-col py-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={dragProps.onDrop}
    >
      <div
        draggable
        onDragStart={dragProps.onDragStart}
        onDragEnd={dragProps.onDragEnd}
        className="flex min-w-0 items-center gap-2 sm:gap-3"
      >
        <GripVertical
          className="hidden h-4 w-4 shrink-0 cursor-grab text-muted active:cursor-grabbing sm:block"
          aria-hidden="true"
        />
        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted">
          {index + 1}
        </span>
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: provider.color }}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium">
            {provider.name}
          </span>
          {needsSaved && (
            <Badge tone={provider.enabled ? "warning" : "muted"}>
              {provider.enabled
                ? "On, but needs credentials"
                : "Needs credentials"}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!hasFields && <span className="mr-1">{testButton}</span>}
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Move ${provider.name} up`}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Move ${provider.name} down`}
            disabled={index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Switch
            aria-label={`Use ${provider.name}`}
            checked={provider.enabled}
            disabled={toggling}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
      {!hasFields && result && (
        <div className={cn("pt-1", indent)}>{result}</div>
      )}
      {hasFields && (
        <Disclosure
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
          label={
            <span className="flex flex-wrap items-center gap-x-1.5">
              Credentials{status}
            </span>
          }
          summaryClassName={cn("px-0 py-1", indent)}
        >
          <div className={cn("flex flex-col gap-3 pb-2 pt-1", indent)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {provider.credentialFields.map((cf) => (
                <div key={cf.key} className="flex flex-col gap-1">
                  <Label htmlFor={`provider-${provider.id}-${cf.key}`}>
                    {cf.label}
                  </Label>
                  <SettingsInput
                    id={`provider-${provider.id}-${cf.key}`}
                    type="password"
                    autoComplete="off"
                    disabled={test.isPending || credentials.pending}
                    value={creds[cf.key] ?? ""}
                    onChange={(e) => {
                      const next = e.target.value;
                      credentials.setValue((prev) => ({
                        ...prev,
                        [cf.key]: next,
                      }));
                    }}
                    onBlur={onBlur(cf.key)}
                    error={
                      (touched[cf.key] || revealed || credentials.dirty) &&
                      provider.requiresCredentials &&
                      !creds[cf.key]?.trim()
                        ? `Enter the ${cf.label}.`
                        : undefined
                    }
                  />
                </div>
              ))}
            </div>
            {provider.helpUrl && (
              <HelpLink href={provider.helpUrl}>
                How to get {provider.name} credentials
              </HelpLink>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {testButton}
              {testBlocked && (
                <p
                  id={`provider-${provider.id}-test-hint`}
                  className="text-sm text-muted"
                >
                  {testBlocked}
                </p>
              )}
              {credentials.dirty && !credentials.pending && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={credentials.discard}
                  aria-label={`Revert ${provider.name} credential changes`}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Revert
                </Button>
              )}
            </div>
            {result}
          </div>
        </Disclosure>
      )}
    </li>
  );
}

/** Tag list editor for a source's banned tags. Enter adds a tag; comma-separated input adds several at once. */
function BannedTagsEditor({
  id,
  label,
  hint,
  value,
  onChange,
  draft,
  setDraft,
}: {
  id: string;
  label: string;
  hint: string;
  value: string[];
  onChange: (tags: string[]) => void;
  draft: string;
  setDraft: (value: string) => void;
}) {
  const addTag = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim().replace(/^"+|"+$/g, ""))
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const part of parts)
      if (!next.some((value) => value.toLowerCase() === part.toLowerCase()))
        next.push(part);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <p id={`${id}-hint`} className="text-sm text-muted">
        {hint}
      </p>
      {value.length > 0 && (
        <ul
          aria-label={`${label} list`}
          className="flex flex-wrap gap-1.5 py-1"
        >
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-border-2 bg-surface-2 pl-3 pr-1 text-xs font-medium text-foreground"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((value) => value !== tag))}
                className="ui-button-icon flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-border/60 hover:text-foreground"
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          aria-describedby={`${id}-hint`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder="Tag names"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={addTag}
          disabled={!draft.trim()}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

/**
 * Downloader fields and the nHentai key share one stored record. Each save
 * starts from the latest saved record so one section never overwrites the
 * other's newer value.
 */
function saveDownloaderRecord(
  qc: ReturnType<typeof useQueryClient>,
  patch: Partial<DownloaderSettings>
) {
  const current = qc.getQueryData<DownloaderSettings>(["downloader-settings"]);
  if (!current)
    throw new Error(
      "Downloader settings have not loaded. Reload the page and try again."
    );
  return api.saveDownloaderSettings({ ...current, ...patch }).then((result) => {
    qc.setQueryData<DownloaderSettings>(["downloader-settings"], (cached) => ({
      ...result.settings,
      libraryPathMappings:
        cached?.libraryPathMappings ?? result.settings.libraryPathMappings,
    }));
    return result.settings;
  });
}

function DownloaderSettingsCard() {
  const qc = useQueryClient();
  const dl = useQuery({
    queryKey: ["downloader-settings"],
    queryFn: api.downloaderSettings,
  });
  type Saved = Omit<
    DownloaderSettings,
    "libraryPathMappings" | "nhentaiApiKey"
  >;
  type DownloadDraft = Omit<
    Saved,
    "maxConcurrentDownloads" | "maxImageConcurrency" | "requestDelayMs"
  > & {
    maxConcurrentDownloads: number | "";
    maxImageConcurrency: number | "";
    requestDelayMs: number | "";
    nhentaiTagInput: string;
    hitomiTagInput: string;
    ehentaiTagInput: string;
  };
  const toDraft = (settings: DownloaderSettings): DownloadDraft => {
    const {
      libraryPathMappings: _mappings,
      nhentaiApiKey: _key,
      ...rest
    } = settings;
    return {
      ...rest,
      nhentaiTagInput: "",
      hitomiTagInput: "",
      ehentaiTagInput: "",
    };
  };
  const source = React.useMemo(
    () => (dl.data ? toDraft(dl.data) : undefined),
    [dl.data]
  );
  const revealed = useRevealed("downloader");
  const { touched, onBlur } = useFieldTouched();
  const downloader = useSettingsDraft<DownloadDraft | null>({
    id: "downloader",
    label: "Downloads",
    initial: null,
    source,
    valid: (value) =>
      Boolean(
        value &&
        (!value.downloadDirectory.trim() ||
          !folderError(value.downloadDirectory)) &&
        !numberError(value.maxConcurrentDownloads, 1, 10, true) &&
        !numberError(value.maxImageConcurrency, 1, 20, true) &&
        !numberError(value.requestDelayMs, 0, 60000)
      ),
    save: async (value) => {
      if (!value) throw new Error("Downloader settings have not loaded.");
      const { nhentaiTagInput, hitomiTagInput, ehentaiTagInput, ...settings } =
        value;
      const appendTags = (tags: string[], input: string) => [
        ...new Set([
          ...tags,
          ...input
            .split(",")
            .map((tag) => tag.trim().replace(/^"+|"+$/g, ""))
            .filter(Boolean),
        ]),
      ];
      const saved = await saveDownloaderRecord(qc, {
        ...settings,
        downloadDirectory: settings.downloadDirectory.trim(),
        maxConcurrentDownloads: Number(settings.maxConcurrentDownloads),
        maxImageConcurrency: Number(settings.maxImageConcurrency),
        requestDelayMs: Number(settings.requestDelayMs),
        nhentaiBannedTags: appendTags(
          settings.nhentaiBannedTags ?? [],
          nhentaiTagInput
        ),
        hitomiBannedTags: appendTags(
          settings.hitomiBannedTags ?? [],
          hitomiTagInput
        ),
        ehentaiBannedTags: appendTags(
          settings.ehentaiBannedTags ?? [],
          ehentaiTagInput
        ),
      });
      return toDraft(saved);
    },
  });
  const dlSettings = downloader.value;
  const setDlSettings = downloader.setValue;
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [exclusionsOpen, setExclusionsOpen] = React.useState(false);
  // A field shows its error once the user changed it, left it, or tried to save.
  const changed = (key: keyof DownloadDraft) =>
    Boolean(source && dlSettings && dlSettings[key] !== source[key]);
  const showError = (key: keyof DownloadDraft) =>
    touched[key] || revealed || changed(key);
  const performanceErrors = dlSettings
    ? {
        maxConcurrentDownloads: numberError(
          dlSettings.maxConcurrentDownloads,
          1,
          10,
          true
        ),
        maxImageConcurrency: numberError(
          dlSettings.maxImageConcurrency,
          1,
          20,
          true
        ),
        requestDelayMs: numberError(dlSettings.requestDelayMs, 0, 60000),
      }
    : null;
  const advancedInvalid = Boolean(
    performanceErrors && Object.values(performanceErrors).some(Boolean)
  );
  React.useEffect(() => {
    if (advancedInvalid && (revealed || downloader.dirty))
      setAdvancedOpen(true);
  }, [advancedInvalid, revealed, downloader.dirty]);

  if (dl.isError)
    return (
      <Card>
        <ErrorState
          title="Could not load download settings"
          description={
            dl.error instanceof Error ? dl.error.message : String(dl.error)
          }
          onRetry={() => void dl.refetch()}
        />
      </Card>
    );
  if (!dlSettings || !performanceErrors)
    return (
      <Card>
        <SectionHeader
          icon={<Download className="h-4 w-4" />}
          title="Doujinshi downloads"
        />
        <CardContent className="flex items-center gap-2 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </CardContent>
      </Card>
    );

  const folderMissing = !dlSettings.downloadDirectory.trim();
  const folderProblem = folderMissing
    ? ""
    : folderError(dlSettings.downloadDirectory);
  const tagCount =
    (dlSettings.nhentaiBannedTags ?? []).length +
    (dlSettings.hitomiBannedTags ?? []).length +
    (dlSettings.ehentaiBannedTags ?? []).length;
  const perf = `${dlSettings.maxConcurrentDownloads || "–"} at once · ${dlSettings.maxImageConcurrency || "–"} images per gallery · ${dlSettings.requestDelayMs === "" ? "–" : dlSettings.requestDelayMs} ms between requests`;

  return (
    <Card id="downloader" className="animate-fade-up scroll-mt-16">
      <SectionHeader
        icon={<Download className="h-4 w-4" />}
        title="Doujinshi downloads"
      >
        <SectionStatus draft={downloader} label="download" />
      </SectionHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="download-directory">Output folder</Label>
          <SettingsInput
            id="download-directory"
            spellCheck={false}
            value={dlSettings.downloadDirectory}
            onChange={(e) =>
              setDlSettings({
                ...dlSettings,
                downloadDirectory: e.target.value,
              })
            }
            onBlur={onBlur("downloadDirectory")}
            placeholder="e.g. /downloads"
            error={
              showError("downloadDirectory") && folderProblem
                ? folderProblem
                : undefined
            }
            hint="Absolute path as seen by H-Tosho, including inside Docker. Choose a Kavita library folder to have new downloads picked up automatically."
          />
          {folderMissing && (
            <p className="flex items-start gap-1.5 text-sm text-warning">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              Not set. Downloads cannot start until you choose an output folder.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="download-format">Output format</Label>
          <Select
            id="download-format"
            value={dlSettings.format}
            onChange={(e) =>
              setDlSettings({
                ...dlSettings,
                format: e.target.value as "cbz" | "folder",
              })
            }
          >
            <option value="cbz">CBZ archive (recommended)</option>
            <option value="folder">Image folder</option>
          </Select>
        </div>
        <p className="break-words text-sm text-muted">
          Downloads saved into a shared Kavita library are imported and matched
          in the background. Review the matches on Home before applying
          metadata.
        </p>
        <Disclosure
          label={
            <span>
              Content exclusions{" "}
              <span className="font-normal text-muted">
                ·{" "}
                {tagCount === 0
                  ? "none"
                  : `${tagCount} banned ${tagCount === 1 ? "tag" : "tags"}`}
              </span>
            </span>
          }
          open={exclusionsOpen}
          onToggle={(event) => setExclusionsOpen(event.currentTarget.open)}
          className="border-t border-border pt-2"
          summaryClassName="px-0 text-foreground"
        >
          <div className="flex flex-col gap-4 pt-3">
            <BannedTagsEditor
              id="nhentai-banned-tags"
              label="nHentai banned tags"
              hint="Galleries with any of these tags never appear in nHentai searches. Separate tags with commas."
              value={dlSettings.nhentaiBannedTags ?? []}
              onChange={(tags) =>
                setDlSettings((current) =>
                  current ? { ...current, nhentaiBannedTags: tags } : current
                )
              }
              draft={dlSettings.nhentaiTagInput}
              setDraft={(nhentaiTagInput) =>
                setDlSettings((current) =>
                  current ? { ...current, nhentaiTagInput } : current
                )
              }
            />
            <BannedTagsEditor
              id="hitomi-banned-tags"
              label="Hitomi banned tags"
              hint="Galleries with any of these tags never appear in Hitomi searches or recommendations. A plain name matches anywhere; a namespace prefix such as artist:foo limits the ban to that namespace. Separate tags with commas."
              value={dlSettings.hitomiBannedTags ?? []}
              onChange={(tags) =>
                setDlSettings((current) =>
                  current ? { ...current, hitomiBannedTags: tags } : current
                )
              }
              draft={dlSettings.hitomiTagInput}
              setDraft={(hitomiTagInput) =>
                setDlSettings((current) =>
                  current ? { ...current, hitomiTagInput } : current
                )
              }
            />
            <BannedTagsEditor
              id="ehentai-banned-tags"
              label="E-Hentai / ExHentai banned tags"
              hint="Galleries with any of these tags never appear in E-Hentai or ExHentai searches and downloads. Separate tags with commas."
              value={dlSettings.ehentaiBannedTags ?? []}
              onChange={(tags) =>
                setDlSettings((current) =>
                  current ? { ...current, ehentaiBannedTags: tags } : current
                )
              }
              draft={dlSettings.ehentaiTagInput}
              setDraft={(ehentaiTagInput) =>
                setDlSettings((current) =>
                  current ? { ...current, ehentaiTagInput } : current
                )
              }
            />
          </div>
        </Disclosure>
        <Disclosure
          label={
            <span>
              Performance{" "}
              <span
                className={cn(
                  "font-normal",
                  advancedInvalid ? "text-danger" : "text-muted"
                )}
              >
                · {advancedInvalid ? "needs a fix" : perf}
              </span>
            </span>
          }
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          className="border-t border-border pt-2"
          summaryClassName="px-0 text-foreground"
        >
          <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="download-concurrency">Downloads at once</Label>
              <SettingsInput
                id="download-concurrency"
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                value={dlSettings.maxConcurrentDownloads}
                onChange={(e) =>
                  setDlSettings({
                    ...dlSettings,
                    maxConcurrentDownloads:
                      e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
                onBlur={onBlur("maxConcurrentDownloads")}
                hint="Galleries downloading at the same time, 1–10."
                error={
                  showError("maxConcurrentDownloads")
                    ? performanceErrors.maxConcurrentDownloads || undefined
                    : undefined
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="image-concurrency">
                Images per gallery at once
              </Label>
              <SettingsInput
                id="image-concurrency"
                type="number"
                inputMode="numeric"
                min={1}
                max={20}
                value={dlSettings.maxImageConcurrency}
                onChange={(e) =>
                  setDlSettings({
                    ...dlSettings,
                    maxImageConcurrency:
                      e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
                onBlur={onBlur("maxImageConcurrency")}
                hint="Images fetched in parallel for one gallery, 1–20."
                error={
                  showError("maxImageConcurrency")
                    ? performanceErrors.maxImageConcurrency || undefined
                    : undefined
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="request-delay">Delay between requests (ms)</Label>
              <SettingsInput
                id="request-delay"
                type="number"
                inputMode="numeric"
                min={0}
                max={60000}
                step="any"
                value={dlSettings.requestDelayMs}
                onChange={(e) =>
                  setDlSettings({
                    ...dlSettings,
                    requestDelayMs:
                      e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
                onBlur={onBlur("requestDelayMs")}
                hint="0–60,000. Higher is gentler on the source sites."
                error={
                  showError("requestDelayMs")
                    ? performanceErrors.requestDelayMs || undefined
                    : undefined
                }
              />
            </div>
          </div>
        </Disclosure>
      </CardContent>
    </Card>
  );
}

function NhentaiCard() {
  const qc = useQueryClient();
  const dl = useQuery({
    queryKey: ["downloader-settings"],
    queryFn: api.downloaderSettings,
  });
  const key = useSettingsDraft<string>({
    id: "nhentai-api-key",
    label: "nHentai API key",
    initial: "",
    source: dl.data?.nhentaiApiKey,
    save: async (value) =>
      (await saveDownloaderRecord(qc, { nhentaiApiKey: value.trim() }))
        .nhentaiApiKey,
  });
  return (
    <Card id="nhentai" className="animate-fade-up scroll-mt-16">
      <SectionHeader icon={<Key className="h-4 w-4" />} title="nHentai">
        <SectionStatus draft={key} label="nHentai" />
      </SectionHeader>
      <CardContent className="flex flex-col gap-1">
        {dl.isError ? (
          <ErrorState
            title="Could not load the nHentai settings"
            description={
              dl.error instanceof Error ? dl.error.message : String(dl.error)
            }
            onRetry={() => void dl.refetch()}
          />
        ) : (
          <>
            <Label htmlFor="nhentai-api-key">API key (optional)</Label>
            <SettingsInput
              id="nhentai-api-key"
              type="password"
              autoComplete="off"
              disabled={!dl.data || key.pending}
              value={key.value}
              onChange={(e) => key.setValue(e.target.value)}
              placeholder="No key"
              hint="A key from nhentai.net raises its API rate limits. Leave blank to use the NHENTAI_API_KEY environment variable, if set."
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EhentaiAccountCard() {
  const qc = useQueryClient();
  const account = useQuery({
    queryKey: ["ehentai-account"],
    queryFn: api.ehentaiAccount,
    staleTime: 30_000,
  });
  const view = account.data;
  const revealed = useRevealed("ehentai-account");
  // Cookies are write-only: the draft never pre-fills saved values, so a
  // blank field means "keep the stored session" once an account exists.
  type EhDraft = {
    site: EhentaiSite;
    memberId: string;
    passHash: string;
    igneous: string;
    revision: number;
  };
  const source = React.useMemo<EhDraft | undefined>(
    () =>
      view
        ? {
            site: view.site,
            memberId: "",
            passHash: "",
            igneous: "",
            revision: view.revision,
          }
        : undefined,
    [view]
  );
  const [conflict, setConflict] = React.useState(false);
  const draft = useSettingsDraft<EhDraft>({
    id: "ehentai-account",
    label: "E-Hentai account",
    initial: {
      site: "e-hentai",
      memberId: "",
      passHash: "",
      igneous: "",
      revision: 0,
    },
    source,
    valid: (value) => {
      const member = value.memberId.trim();
      const hash = value.passHash.trim();
      return (member === "" && hash === "") || (member !== "" && hash !== "");
    },
    save: async (value) => {
      const member = value.memberId.trim();
      const hash = value.passHash.trim();
      const igneous = value.igneous.trim();
      const body: {
        site: EhentaiSite;
        expectedRevision: number;
        session?: EhentaiSessionInput;
      } = { site: value.site, expectedRevision: value.revision };
      if (member || hash) {
        body.session = {
          ipb_member_id: member,
          ipb_pass_hash: hash,
          ...(igneous ? { igneous } : {}),
        };
      }
      try {
        const next = await api.saveEhentaiAccount(body);
        qc.setQueryData(["ehentai-account"], next);
        setConflict(false);
        return {
          site: next.site,
          memberId: "",
          passHash: "",
          igneous: "",
          revision: next.revision,
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setConflict(true);
          throw new Error(
            "The account changed since you started editing. Your draft is kept. Reload the saved account and try again."
          );
        }
        throw error;
      }
    },
  });
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [removeError, setRemoveError] = React.useState("");
  const [connectOpen, setConnectOpen] = React.useState(false);
  const draftMember = draft.value.memberId.trim();
  const draftHash = draft.value.passHash.trim();
  const hasDraftSession = Boolean(draftMember || draftHash);
  const partialCookies = (draftMember === "") !== (draftHash === "");
  React.useEffect(() => {
    if (partialCookies && (draft.dirty || revealed)) setConnectOpen(true);
  }, [partialCookies, draft.dirty, revealed]);
  const [testResult, setTestResult] = React.useState<Awaited<
    ReturnType<typeof api.testEhentaiAccount>
  > | null>(null);
  const test = useMutation({
    mutationFn: () =>
      hasDraftSession
        ? api.testEhentaiAccount("draft", {
            ipb_member_id: draft.value.memberId.trim(),
            ipb_pass_hash: draft.value.passHash.trim(),
            ...(draft.value.igneous.trim()
              ? { igneous: draft.value.igneous.trim() }
              : {}),
          })
        : api.testEhentaiAccount("saved"),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.saved) void account.refetch();
    },
    onError: (error) =>
      setTestResult({
        eHentai: {
          state: "unavailable",
          testedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        },
        exHentai: {
          state: "unavailable",
          testedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        },
        testedAt: new Date().toISOString(),
        saved: false,
      }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeEhentaiAccount(draft.value.revision),
    onSuccess: (next) => {
      qc.setQueryData(["ehentai-account"], next);
      setRemoveOpen(false);
      setRemoveError("");
      setTestResult(null);
      toast({
        tone: "info",
        title: "E-Hentai account removed",
        description:
          "E-Hentai/ExHentai is no longer a download source until you save an account again.",
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        void account.refetch();
      } else
        setRemoveError(error instanceof Error ? error.message : String(error));
      setRemoveOpen(false);
    },
  });

  if (account.isError)
    return (
      <Card>
        <ErrorState
          title="Could not load the E-Hentai account"
          description={
            account.error instanceof Error
              ? account.error.message
              : String(account.error)
          }
          onRetry={() => void account.refetch()}
        />
      </Card>
    );
  if (!view)
    return (
      <Card>
        <SectionHeader
          icon={<KeyRound className="h-4 w-4" />}
          title="E-Hentai account"
        />
        <CardContent className="flex items-center gap-2 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </CardContent>
      </Card>
    );

  const setDraft = draft.setValue;
  const accessRows: { label: string; access: EhentaiSiteAccess }[] = [
    {
      label: "e-hentai.org (public site)",
      access: testResult ? testResult.eHentai : view.eHentai,
    },
    {
      label: "exhentai.org (ExHentai)",
      access: testResult ? testResult.exHentai : view.exHentai,
    },
  ];
  // Only the empty half of a pair is wrong; copy depends on whether a session already exists.
  const showPairErrors = partialCookies && (draft.dirty || revealed);
  const pairError = (name: string) =>
    view.configured
      ? `Enter ${name} too, or clear both cookies to keep the saved session.`
      : `Enter ${name} too. Both cookies are needed to connect.`;
  const memberError =
    showPairErrors && !draftMember ? pairError("ipb_member_id") : undefined;
  const hashError =
    showPairErrors && !draftHash ? pairError("ipb_pass_hash") : undefined;
  const form = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="ehentai-site">Site</Label>
        <Select
          id="ehentai-site"
          aria-describedby="ehentai-site-hint"
          value={draft.value.site}
          onChange={(e) =>
            setDraft((current) => ({
              ...current,
              site: e.target.value as EhentaiSite,
            }))
          }
          disabled={draft.pending}
        >
          <option value="e-hentai">E-Hentai (e-hentai.org)</option>
          <option value="exhentai">
            ExHentai (exhentai.org, requires ExHentai access)
          </option>
        </Select>
        <p id="ehentai-site-hint" className="text-sm text-muted">
          Searches, previews and downloads use this site. Changing it does not
          rewrite downloads already in the queue.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Where to find the cookies</h3>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted">
          <li>Sign in at e-hentai.org (or exhentai.org) in your browser.</li>
          <li>
            Open the developer tools (F12), then Application → Cookies in Chrome
            or Edge, or Storage → Cookies in Firefox.
          </li>
          <li>
            Select the site and copy the values of{" "}
            <span className="font-mono text-foreground">ipb_member_id</span> and{" "}
            <span className="font-mono text-foreground">ipb_pass_hash</span>,
            plus <span className="font-mono text-foreground">igneous</span> if
            it is listed.
          </li>
        </ol>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ehentai-member-id">
            Member ID{" "}
            <span className="font-mono text-xs font-normal text-muted">
              ipb_member_id
            </span>
          </Label>
          <SettingsInput
            id="ehentai-member-id"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={draft.pending}
            value={draft.value.memberId}
            onChange={(e) =>
              setDraft((current) => ({ ...current, memberId: e.target.value }))
            }
            placeholder={
              view.configured ? "Saved. Enter a value to replace it" : undefined
            }
            error={memberError}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ehentai-pass-hash">
            Pass hash{" "}
            <span className="font-mono text-xs font-normal text-muted">
              ipb_pass_hash
            </span>
          </Label>
          <SettingsInput
            id="ehentai-pass-hash"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={draft.pending}
            value={draft.value.passHash}
            onChange={(e) =>
              setDraft((current) => ({ ...current, passHash: e.target.value }))
            }
            placeholder={
              view.configured ? "Saved. Enter a value to replace it" : undefined
            }
            error={hashError}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="ehentai-igneous">
            igneous{" "}
            <span className="text-xs font-normal text-muted">(optional)</span>
          </Label>
          <SettingsInput
            id="ehentai-igneous"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={draft.pending}
            value={draft.value.igneous}
            onChange={(e) =>
              setDraft((current) => ({ ...current, igneous: e.target.value }))
            }
            placeholder={
              view.hasIgneous ? "Saved. Enter a value to replace it" : undefined
            }
            hint="Only some ExHentai sessions have this cookie. Leave blank if yours does not."
          />
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-medium">Access check</h3>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setTestResult(null);
              test.mutate();
            }}
            disabled={
              test.isPending ||
              draft.pending ||
              (!view.configured && !hasDraftSession) ||
              partialCookies
            }
          >
            {test.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}{" "}
            {hasDraftSession ? "Test entered cookies" : "Test saved account"}
          </Button>
        </div>
        {hasDraftSession && (
          <p className="text-sm text-muted">
            Testing entered cookies never saves or changes the saved account.
          </p>
        )}
        <ul className="flex flex-col gap-1.5">
          {accessRows.map(({ label, access }) => (
            <li
              key={label}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
            >
              <span className="min-w-0 flex-1 break-words">{label}</span>
              <Badge
                tone={
                  access.state === "verified"
                    ? "success"
                    : access.state === "untested"
                      ? "muted"
                      : access.state === "denied" ||
                          access.state === "unavailable"
                        ? "danger"
                        : "warning"
                }
              >
                {capitalize(access.state.replace(/-/g, " "))}
              </Badge>
              {access.testedAt && (
                <span className="text-xs text-muted">
                  checked {timeAgo(access.testedAt)}
                </span>
              )}
            </li>
          ))}
        </ul>
        {accessRows.some(({ access }) => access.message) && (
          <p
            role={
              testResult?.eHentai.state === "verified" &&
              testResult.exHentai.state === "verified"
                ? "status"
                : "alert"
            }
            className="break-words text-sm text-muted"
          >
            {accessRows
              .filter(({ access }) => access.message)
              .map(({ label, access }) => `${label}: ${access.message}`)
              .join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
  return (
    <Card id="ehentai-account" className="animate-fade-up scroll-mt-16">
      <SectionHeader
        icon={<KeyRound className="h-4 w-4" />}
        title="E-Hentai account"
      >
        <SectionStatus draft={draft} label="E-Hentai account" />
        <Badge tone={view.configured ? "success" : "muted"}>
          {view.configured ? "Connected" : "Not connected"}
        </Badge>
      </SectionHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="break-words text-sm text-muted">
          Connect your own E-Hentai or ExHentai account to search and download
          from that site. Cookies stay encrypted on this server and are never
          sent to the browser.
        </p>
        {view.sessionError && (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"
          >
            <span className="font-medium text-danger">
              The saved account cannot be read on this server.
            </span>
            <span className="break-words text-muted">
              {sentence(view.sessionError)} Save the cookies again to restore
              the account.
            </span>
          </div>
        )}
        {conflict && (
          <div
            role="alert"
            className="flex flex-col gap-2 text-sm text-warning"
          >
            <p>
              The saved account changed (another session saved or removed it).
              Your draft is kept.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 self-start"
              onClick={() => {
                setConflict(false);
                void account.refetch();
              }}
            >
              Reload saved account
            </Button>
          </div>
        )}
        {view.configured ? (
          form
        ) : (
          <Disclosure
            label="Connect an account"
            open={connectOpen}
            onToggle={(event) => setConnectOpen(event.currentTarget.open)}
            className="border-t border-border pt-2"
            summaryClassName="px-0 text-foreground"
          >
            <div className="pt-2">{form}</div>
          </Disclosure>
        )}
        {removeError && (
          <p role="alert" className="break-words text-sm text-danger">
            Could not remove the account. {sentence(removeError)} Try again.
          </p>
        )}
        {view.configured && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="break-words text-sm text-muted">
              Removing the account keeps downloaded galleries in the library and
              queue.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="text-danger"
              onClick={() => setRemoveOpen(true)}
              disabled={remove.isPending || draft.pending}
            >
              {remove.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}{" "}
              Remove account
            </Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={removeOpen}
        title="Remove E-Hentai account?"
        description="The stored cookies are deleted from this server. Searches and new downloads from E-Hentai/ExHentai stop until you save an account again; queued downloads keep their saved origin."
        confirmLabel="Remove account"
        danger
        pending={remove.isPending}
        onConfirm={() => {
          setRemoveError("");
          remove.mutate();
        }}
        onOpenChange={setRemoveOpen}
      />
    </Card>
  );
}

function NotificationsCard({
  saved,
  refetch,
}: {
  saved: Notif;
  refetch: () => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const revealed = useRevealed("notifications");
  const notifications = useSettingsDraft<Notif>({
    id: "notifications",
    label: "Notifications",
    initial: DEFAULT_NOTIFICATION_DRAFT,
    source: saved,
    valid: (value) =>
      !value.discord.enabled || !httpUrlError(value.discord.webhookUrl, true),
    save: async (value) => {
      if (value.revision !== saved.revision)
        throw new Error(
          "Notification settings changed. Choose “Load saved settings” or “Replace saved settings with my draft” first."
        );
      let result;
      try {
        result = await api.saveNotifications(value);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) await refetch();
        throw error;
      }
      qc.setQueryData<SettingsType>(["settings"], (current) =>
        current ? { ...current, notifications: result.notifications } : current
      );
      return result.notifications;
    },
  });
  const notif = notifications.value;
  const setNotif = notifications.setValue;
  const notifTouched = useFieldTouched();
  const [notifMsg, setNotifMsg] = React.useState<{ discord: string } | null>(
    null
  );
  const testNotif = useMutation({
    mutationFn: () => api.testNotifications(notif),
    onSuccess: (r) => setNotifMsg(r),
    onError: (error) =>
      setNotifMsg({
        discord: `Could not send a test notification. ${sentence(error instanceof Error ? error.message : String(error))} Try again.`,
      }),
  });
  React.useEffect(
    () => setNotifMsg(null),
    [notif.discord.enabled, notif.discord.webhookUrl]
  );
  return (
    <Card id="notifications" className="animate-fade-up scroll-mt-16">
      <SectionHeader icon={<Bell className="h-4 w-4" />} title="Notifications">
        <SectionStatus draft={notifications} label="notification" />
      </SectionHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="discord-webhook">Discord webhook</Label>
            <Switch
              aria-label="Enable Discord notifications"
              disabled={testNotif.isPending || notifications.pending}
              checked={notif.discord.enabled}
              onCheckedChange={(c) =>
                setNotif((n) => ({
                  ...n,
                  discord: { ...n.discord, enabled: c },
                }))
              }
            />
          </div>
          <SettingsInput
            id="discord-webhook"
            type="url"
            spellCheck={false}
            disabled={testNotif.isPending || notifications.pending}
            value={notif.discord.webhookUrl}
            onChange={(e) =>
              setNotif((n) => ({
                ...n,
                discord: { ...n.discord, webhookUrl: e.target.value },
              }))
            }
            onBlur={notifTouched.onBlur("webhook")}
            placeholder="https://discord.com/api/webhooks/…"
            hint="Turn on Discord and paste a webhook URL from your server's channel settings."
            error={
              notif.discord.enabled &&
              (notifTouched.touched.webhook || revealed)
                ? httpUrlError(notif.discord.webhookUrl, true) || undefined
                : undefined
            }
          />
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => testNotif.mutate()}
              disabled={
                testNotif.isPending ||
                notifications.pending ||
                !notif.discord.enabled ||
                !notifications.valid
              }
            >
              {testNotif.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}{" "}
              Send test notification
            </Button>
            <p className="text-sm text-muted">
              {notif.discord.enabled
                ? "Uses the values above without saving them."
                : "Turn on Discord to send a test."}
            </p>
          </div>
        </div>
        {notif.revision !== saved.revision && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <p className="font-medium text-warning">
              The saved notification settings changed while you were editing.
              Your draft is kept.
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              <p>
                <span className="font-medium">Saved now:</span>{" "}
                {notifSummary(saved)}
              </p>
              <p>
                <span className="font-medium">Your draft:</span>{" "}
                {notifSummary(notif)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => notifications.discard()}
              >
                Load saved settings
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() =>
                  setNotif((value) => ({ ...value, revision: saved.revision }))
                }
              >
                Replace saved settings with my draft
              </Button>
            </div>
            <p className="text-xs text-muted">
              “Replace” keeps your draft and marks it current; the next save
              overwrites the saved destination.
            </p>
          </div>
        )}
        {notifMsg && (
          <p
            role={notifMsg.discord === "ok" ? "status" : "alert"}
            className={cn(
              "flex min-w-0 items-start gap-1.5 break-words text-sm",
              notifMsg.discord === "ok" ? "text-success" : "text-danger"
            )}
          >
            {notifMsg.discord === "ok" ? (
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
            ) : (
              <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {notifMsg.discord === "ok"
              ? "Test notification sent to Discord."
              : `Discord test failed: ${sentence(notifMsg.discord)}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { dirtyIds } = useSettingsNavigation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const kavita = useQuery({
    queryKey: ["kavita-status"],
    queryFn: api.kavitaStatus,
  });
  const s = settings.data;
  const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(
    () => new Set()
  );

  const requestedTab = searchParams.get("tab") ?? "";
  const legacyTab = LEGACY_TABS[requestedTab];
  const tab: SettingsTab =
    legacyTab ??
    (SETTINGS_TABS.some((item) => item.id === requestedTab)
      ? (requestedTab as SettingsTab)
      : "kavita");
  // Tabs mount on first visit and then stay mounted: a section's draft can only
  // be saved by the page save bar while that section is mounted.
  const [visitedTabs, setVisitedTabs] = React.useState<
    ReadonlySet<SettingsTab>
  >(() => new Set([tab]));
  React.useEffect(() => {
    setVisitedTabs((current) =>
      current.has(tab) ? current : new Set([...current, tab])
    );
  }, [tab]);
  const mounted = (id: SettingsTab) => id === tab || visitedTabs.has(id);
  const setTab = React.useCallback(
    (next: SettingsTab) =>
      setSearchParams((previous) => {
        const params = new URLSearchParams(previous);
        params.set("tab", next);
        return params;
      }),
    [setSearchParams]
  );
  React.useEffect(() => {
    if (legacyTab)
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          params.set("tab", legacyTab);
          return params;
        },
        { replace: true }
      );
  }, [legacyTab, setSearchParams]);
  React.useEffect(() => {
    if (!location.hash) return;
    const timer = window.setTimeout(() => {
      const section = document.getElementById(
        decodeURIComponent(location.hash.slice(1))
      );
      // Only sections on the visible tab; hidden panels cannot take focus.
      if (!section || section.closest("[hidden]")) return;
      section.scrollIntoView({ block: "start" });
      section
        .querySelector<HTMLInputElement>("input")
        ?.focus({ preventScroll: true });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [s, location.hash, tab]);

  /** Reveal every invalid field in these sections and take the user to the first one. */
  const showSections = React.useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      setRevealed((current) => new Set([...current, ...ids]));
      const { tab: target, section } = draftLocation(ids[0]);
      setTab(target);
      window.setTimeout(() => {
        const element = document.getElementById(section);
        const field = element?.querySelector<HTMLElement>(
          '[aria-invalid="true"]'
        );
        (field ?? element)?.scrollIntoView({ block: "center" });
        field?.focus({ preventScroll: true });
      }, 120);
    },
    [setTab]
  );

  const settingsError =
    settings.error instanceof Error
      ? settings.error.message
      : String(settings.error);
  const renderSettingsCard = (
    render: (resolved: SettingsType) => React.ReactNode
  ) => {
    if (s) return render(s);
    if (settings.isError)
      return (
        <ErrorState
          title="Could not load settings"
          description={settingsError}
          onRetry={() => void settings.refetch()}
        />
      );
    return <Skeleton className="h-44 w-full rounded-xl" />;
  };

  const kavitaConnected = Boolean(
    kavita.data?.configured && !kavita.data.error
  );
  return (
    <RevealContext.Provider value={revealed}>
      <div className="flex flex-col gap-4">
        <PageHeader
          icon={<SlidersHorizontal className="h-5 w-5" />}
          title="Settings"
          subtitle="Connect Kavita, choose sources and downloads, and manage notifications and your account."
        />
        <SegmentedTabs
          items={SETTINGS_TABS.map((item) => ({
            ...item,
            dirty: dirtyIds.some((id) => draftLocation(id).tab === item.id),
          }))}
          value={tab}
          onChange={setTab}
          label="Settings sections"
          panelId="settings-panel"
          className="sticky top-0 z-10 self-start bg-background"
        />

        <TabPanel
          value={tab}
          tabOrder={SETTINGS_TAB_ORDER}
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-panel-tab-${tab}`}
        >
          {mounted("kavita") && (
            <div hidden={tab !== "kavita"} className="flex flex-col gap-4">
              <KavitaConnectionCard />
              <KavitaLibraryFoldersCard connected={kavitaConnected} />
              {renderSettingsCard((resolved) => (
                <AutoScanCard
                  hours={resolved.pollIntervalHours}
                  refreshDays={resolved.matchRefreshIntervalDays ?? 7}
                />
              ))}
            </div>
          )}
          {mounted("sources") && (
            <div hidden={tab !== "sources"} className="flex flex-col gap-4">
              {renderSettingsCard((resolved) => (
                <MetadataProvidersCard savedOrder={resolved.priorities} />
              ))}
              <EhentaiAccountCard />
              <NhentaiCard />
            </div>
          )}
          {mounted("downloads") && (
            <div hidden={tab !== "downloads"} className="flex flex-col gap-4">
              <DownloaderSettingsCard />
            </div>
          )}
          {mounted("notifications") && (
            <div
              hidden={tab !== "notifications"}
              className="flex flex-col gap-4"
            >
              {renderSettingsCard((resolved) => (
                <NotificationsCard
                  saved={resolved.notifications}
                  refetch={settings.refetch}
                />
              ))}
            </div>
          )}
          {mounted("account") && (
            <div hidden={tab !== "account"} className="flex flex-col gap-4">
              <AppearanceCard />
              <React.Suspense
                fallback={<Skeleton className="h-40 w-full rounded-xl" />}
              >
                <AppUpdatesCard />
              </React.Suspense>
              <AccountSettingsCard />
            </div>
          )}
        </TabPanel>
        <SettingsSaveBar onShow={showSections} />
      </div>
    </RevealContext.Provider>
  );
}
