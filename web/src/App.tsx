import * as React from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import {
  House,
  Library,
  Settings as SettingsIcon,
  ListChecks,
  Compass,
  Menu,
  X,
  LogOut,
  Monitor,
  Sun,
  Moon,
  ArrowUpCircle,
  AlertTriangle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import {
  loadDownloader,
  loadHome,
  loadJobs,
  loadLibraries,
  loadSettings,
} from "./lib/routeChunks";
import { APP_VERSION } from "./lib/appVersion";
// Route-level code splitting: each page (and the modals only it imports) loads
// on first navigation instead of one upfront bundle.
// main.tsx preloads the current route's chunk through the same loaders.
const Libraries = React.lazy(() =>
  loadLibraries().then((m) => ({ default: m.Libraries }))
);
const Home = React.lazy(() => loadHome().then((m) => ({ default: m.Home })));
const Downloader = React.lazy(() =>
  loadDownloader().then((m) => ({ default: m.Downloader }))
);
const Jobs = React.lazy(() => loadJobs().then((m) => ({ default: m.Jobs })));
const Settings = React.lazy(() =>
  loadSettings().then((m) => ({ default: m.Settings }))
);
import { SidebarStatus } from "./components/SidebarStatus";
import { Button } from "./components/ui";
import { cn } from "./lib/utils";
import { useAuth } from "./lib/AuthContext";
import { useTheme } from "./lib/theme";
import { useMediaQuery } from "./lib/useMediaQuery";
import { recommendationQuery } from "./lib/recommendationQuery";

/** Owns the single startup recommendation fetch without re-rendering App on settle. */
function RecommendationLoader() {
  useQuery(recommendationQuery);
  return null;
}

function LowConfidenceBadge() {
  const { data } = useQuery({
    queryKey: ["low-confidence"],
    queryFn: api.lowConfidenceCount,
    refetchInterval: 60_000,
  });
  if (!data || data.count === 0) return null;
  return (
    <Link
      to="/libraries/review"
      className="absolute right-1 top-0 flex h-9 min-w-9 items-center justify-center rounded-md"
      aria-label={`Review queue · ${data.count}`}
      title={`Review matches below ${Math.round(data.threshold * 100)}% confidence`}
    >
      <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-foreground">
        {data.count}
      </span>
    </Link>
  );
}

/** Quiet sidebar notice when a newer H-Tosho release is available. */
function UpdateIndicator() {
  const { data } = useQuery({
    queryKey: ["app-update-status"],
    queryFn: api.appUpdateStatus,
    staleTime: 5 * 60_000,
    refetchInterval: 6 * 3_600_000,
    retry: false,
  });
  if (!data?.updateAvailable || !data.latestRelease) return null;
  const replaceImage = Boolean(
    data.installMode === "docker" && data.docker?.requiresImageReplacement
  );
  const label = replaceImage
    ? `v${data.latestRelease.version} · Replace image`
    : `Update available · v${data.latestRelease.version}`;
  return (
    <Link
      to="/settings?tab=account#app-updates"
      className={cn(
        "flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs font-medium transition-colors hover:bg-surface-2",
        replaceImage ? "text-warning" : "text-primary"
      )}
      title={
        replaceImage
          ? `v${data.latestRelease.version} requires replacing the Docker image`
          : `Update H-Tosho to v${data.latestRelease.version}`
      }
    >
      {replaceImage ? (
        <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <ArrowUpCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Link>
  );
}

/** Always-visible Kavita connection state — polled so a dead server is obvious from any page. */
function KavitaIndicator() {
  const { data } = useQuery({
    queryKey: ["kavita-status"],
    queryFn: api.kavitaStatus,
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const state = !data.configured ? "off" : data.error ? "error" : "ok";
  const label =
    state === "ok"
      ? data.version
        ? `Kavita ${data.version}`
        : "Kavita connected"
      : state === "error"
        ? "Kavita unreachable"
        : "Kavita not configured";
  return (
    <div
      className="flex items-center gap-2 border-t border-border px-4 py-2.5"
      title={state === "error" ? (data.error ?? undefined) : label}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          state === "ok"
            ? "bg-success"
            : state === "error"
              ? "animate-pulse-soft bg-danger"
              : "bg-muted/50"
        )}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-muted">
        {label}
      </span>
    </div>
  );
}

/** Catches render errors inside a page so the rest of the app (sidebar etc.) stays intact. */
class PageErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="font-medium">Something went wrong on this page.</p>
          <p className="max-w-md break-all text-sm text-muted">
            {this.state.error.message}
          </p>
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Brand mark + wordmark, shared by the mobile header and the desktop sidebar. */
function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <img
        src="/h-tosho-icon.png?v=26b1c759"
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        decoding="async"
        className="h-8 w-8 shrink-0 rounded-lg object-contain"
      />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold leading-tight tracking-tight">
          H-Tosho
        </div>
        {APP_VERSION && (
          <div className="text-[11px] leading-tight text-muted">
            v{APP_VERSION}
          </div>
        )}
      </div>
    </div>
  );
}

/** Cycles system → light → dark; the choice persists across sessions. */
function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label =
    theme === "system" ? "System" : theme === "light" ? "Light" : "Dark";
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={cycle}
      aria-label={`Theme: ${label}. Switch to next theme.`}
      title={`Theme: ${label}`}
      className="shrink-0"
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}

const NAV = [
  { to: "/", label: "Home", icon: House },
  { to: "/libraries", label: "Libraries", icon: Library },
  { to: "/downloader", label: "Discover", icon: Compass },
  { to: "/jobs", label: "Tasks", icon: ListChecks },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

/** Mount-time style only; later positions are written to the node directly. */
const NAV_INDICATOR_INITIAL: React.CSSProperties = {
  height: 0,
  transform: "translateY(0px)",
  opacity: 0,
};

export default function App() {
  const location = useLocation();
  const { username, logout } = useAuth();
  // Library IDs select content within one page; keep its controls mounted.
  const isLibraryPage =
    location.pathname === "/libraries" ||
    (location.pathname.startsWith("/libraries/") &&
      location.pathname !== "/libraries/review");
  const pageKey = isLibraryPage ? "/libraries" : location.pathname;

  const [navOpen, setNavOpen] = React.useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const sidebarRef = React.useRef<HTMLElement>(null);
  const mainRef = React.useRef<HTMLElement>(null);
  const navToggleRef = React.useRef<HTMLButtonElement>(null);
  const navigationRef = React.useRef<HTMLElement>(null);
  const navIndicatorRef = React.useRef<HTMLSpanElement>(null);
  // The indicator is positioned straight on the DOM node: moving it never
  // re-renders App, and one ResizeObserver lives for the sidebar's lifetime.
  const measureNavIndicator = React.useCallback(() => {
    const nav = navigationRef.current,
      indicator = navIndicatorRef.current;
    if (!nav || !indicator) return;
    const active = nav.querySelector<HTMLElement>('a[aria-current="page"]');
    const bounds = active?.getBoundingClientRect();
    const top = bounds ? bounds.top - nav.getBoundingClientRect().top : 0;
    const height = bounds?.height ?? 0;
    indicator.style.height = `${height}px`;
    indicator.style.transform = `translateY(${top}px)`;
    indicator.style.opacity = height ? "1" : "0";
  }, []);
  React.useLayoutEffect(() => {
    const nav = navigationRef.current;
    if (!nav) return;
    const observer = new ResizeObserver(measureNavIndicator);
    observer.observe(nav);
    nav.querySelectorAll("a").forEach((link) => observer.observe(link));
    return () => observer.disconnect();
  }, [measureNavIndicator]);
  React.useLayoutEffect(measureNavIndicator, [
    location.pathname,
    isDesktop,
    measureNavIndicator,
  ]);
  React.useEffect(
    () => setNavOpen(false),
    [location.pathname, location.search, isDesktop]
  );
  React.useLayoutEffect(() => {
    if (sidebarRef.current) sidebarRef.current.inert = !isDesktop && !navOpen;
    if (mainRef.current) mainRef.current.inert = !isDesktop && navOpen;
    if (!navOpen || isDesktop) return;
    // Focus after the drawer's visible styles have committed, including the
    // reduced-motion fade. Focusing a still-hidden link can silently fail.
    const trigger = navToggleRef.current;
    const focusFrame = requestAnimationFrame(() => {
      const nav = sidebarRef.current;
      (
        nav?.querySelector<HTMLElement>('a[aria-current="page"]') ??
        nav?.querySelector<HTMLElement>("nav a")
      )?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      // Restore focus after the header has committed its accessible state.
      requestAnimationFrame(() => {
        if (
          trigger?.getClientRects().length &&
          trigger.getAttribute("aria-expanded") === "false"
        )
          trigger.focus();
      });
    };
  }, [navOpen, isDesktop]);

  const onNavKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (isDesktop || !navOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setNavOpen(false);
    } else if (event.key === "Tab") {
      const controls = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"]'
        ) ?? []
      ).filter((el) => el.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  return (
    <div className="flex min-h-0 h-full flex-col overflow-hidden lg:flex-row">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:border focus:border-border-2 focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary focus:shadow-lg"
      >
        Skip to content
      </a>
      <RecommendationLoader />
      <header
        aria-hidden={navOpen && !isDesktop ? true : undefined}
        className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-sidebar px-3 pt-[env(safe-area-inset-top)] sm:px-4 lg:hidden"
      >
        <Button
          ref={navToggleRef}
          size="icon"
          variant="ghost"
          className="shrink-0"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          aria-controls="app-navigation"
          tabIndex={navOpen ? -1 : 0}
          onClick={() => setNavOpen((v) => !v)}
        >
          {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
        {!isDesktop && <Brand />}
      </header>
      <div
        aria-hidden="true"
        data-state={navOpen ? "open" : "closed"}
        className="app-nav-scrim fixed inset-x-0 bottom-0 top-14 z-30 bg-black/40 lg:hidden"
        onClick={() => setNavOpen(false)}
      />
      <aside
        ref={sidebarRef}
        id="app-navigation"
        role={!isDesktop && navOpen ? "dialog" : undefined}
        aria-modal={!isDesktop && navOpen ? true : undefined}
        aria-label="Navigation"
        onKeyDown={onNavKeyDown}
        onTransitionEnd={(event) => {
          // A visibility transition interrupted by a media preference change can
          // postpone focus. Recover once the drawer itself finishes opening.
          if (
            event.target !== event.currentTarget ||
            !navOpen ||
            isDesktop ||
            event.currentTarget.contains(document.activeElement)
          )
            return;
          event.currentTarget
            .querySelector<HTMLElement>('a[aria-current="page"]')
            ?.focus();
        }}
        className={cn(
          "app-nav-drawer fixed bottom-0 left-0 top-14 z-40 flex w-[min(16rem,calc(100vw-2rem))] shrink-0 flex-col border-r border-border bg-sidebar pb-[env(safe-area-inset-bottom)] lg:static lg:inset-auto lg:w-60 lg:pb-0",
          navOpen && "app-nav-open"
        )}
      >
        <div className="flex justify-end px-3 pt-2 lg:hidden">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="hidden h-14 items-center border-b border-border px-4 lg:flex">
          {isDesktop && <Brand />}
        </div>
        <nav
          ref={navigationRef}
          aria-label="Primary navigation"
          className="relative isolate flex flex-1 flex-col gap-1 p-3"
        >
          <span
            ref={navIndicatorRef}
            aria-hidden="true"
            className="app-nav-indicator pointer-events-none absolute inset-x-3 top-0 rounded-lg bg-primary/10"
            style={NAV_INDICATOR_INITIAL}
          />
          {NAV.map((item) => (
            <div key={item.to} className="relative z-10">
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "app-nav-link ui-choice group flex h-9 items-center gap-2.5 rounded-lg px-3 pr-11 text-sm transition-colors duration-150",
                    isActive
                      ? "font-medium text-primary"
                      : "text-muted hover:bg-surface-2/70 hover:text-foreground"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className={cn(
                        "app-nav-icon h-4 w-4 shrink-0",
                        isActive
                          ? "text-primary"
                          : "text-muted group-hover:text-foreground"
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                  </>
                )}
              </NavLink>
              {item.to === "/libraries" && <LowConfidenceBadge />}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-1 border-t border-border px-3 py-2">
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted"
            title={username ?? undefined}
          >
            {username}
          </span>
          <ThemeToggle />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => void logout()}
            aria-label="Sign out"
            title="Sign out"
            className="shrink-0"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
        <UpdateIndicator />
        <KavitaIndicator />
        <SidebarStatus live={isDesktop || navOpen} />
      </aside>
      <main
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        {/* Padding lives on an inner wrapper, not on the scroll container itself: sticky
            page elements (tab bars) pin flush to the scrollport edge this way. */}
        <div className="p-3 sm:p-5 lg:p-8">
          <div key={pageKey} className="app-page">
            <PageErrorBoundary>
              <React.Suspense
                fallback={
                  <div className="flex h-40 items-center justify-center text-sm text-muted">
                    Loading…
                  </div>
                }
              >
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/libraries" element={<Libraries />} />
                  <Route
                    path="/libraries/review"
                    element={<Libraries review />}
                  />
                  <Route path="/libraries/:libraryId" element={<Libraries />} />
                  <Route path="/downloader" element={<Downloader />} />
                  <Route path="/jobs" element={<Jobs />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </React.Suspense>
            </PageErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
