import * as React from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Library, Settings as SettingsIcon, ListChecks, BookOpenText, Download, Menu, X, LogOut, Monitor, Sun, Moon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { Libraries } from './pages/Libraries';
import { Downloader } from './pages/Downloader';
import { Jobs } from './pages/Jobs';
import { Settings } from './pages/Settings';
import { SidebarStatus } from './components/SidebarStatus';
import { Button } from './components/ui';
import { cn } from './lib/utils';
import { useAuth } from './lib/AuthContext';
import { useTheme } from './lib/theme';

function LowConfidenceBadge() {
  const { data } = useQuery({ queryKey: ['low-confidence'], queryFn: api.lowConfidenceCount, refetchInterval: 60_000 });
  if (!data || data.count === 0) return null;
  return (
    <span className="ml-auto rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-warning" title={`${data.count} matched series below ${Math.round(data.threshold * 100)}% confidence — review them in Libraries (filter: Low confidence)`}>
      {data.count}
    </span>
  );
}

/** Always-visible Kavita connection state — polled so a dead server is obvious from any page. */
function KavitaIndicator() {
  const { data } = useQuery({ queryKey: ['kavita-status'], queryFn: api.kavitaStatus, refetchInterval: 60_000 });
  if (!data) return null;
  const state = !data.configured ? 'off' : data.error ? 'error' : 'ok';
  const label = state === 'ok' ? (data.version ? `Kavita ${data.version}` : 'Kavita connected') : state === 'error' ? 'Kavita unreachable' : 'Kavita not configured';
  return (
    <div className="flex items-center gap-2 border-t border-border px-4 py-2.5" title={state === 'error' ? data.error ?? undefined : label}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', state === 'ok' ? 'bg-success' : state === 'error' ? 'animate-pulse-soft bg-danger' : 'bg-muted/50')} />
      <span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
    </div>
  );
}

/** Catches render errors inside a page so the rest of the app (sidebar etc.) stays intact. */
class PageErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="font-medium">Something went wrong on this page.</p>
          <p className="max-w-md break-all text-sm text-muted">{this.state.error.message}</p>
          <Button size="sm" onClick={() => this.setState({ error: null })}>Try again</Button>
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
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-white">
        <BookOpenText className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold leading-tight tracking-tight">H-Tosho</div>
        <div className="truncate text-xs leading-tight text-muted">Kavita metadata manager</div>
      </div>
    </div>
  );
}

/** Cycles system → light → dark; the choice persists across sessions. */
function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark';
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${label}. Switch to next theme.`}
      title={`Theme: ${label}`}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

const NAV = [
  { to: '/libraries', label: 'Libraries', icon: Library },
  { to: '/downloader', label: 'Downloader', icon: Download },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function App() {
  const location = useLocation();
  const { username, logout } = useAuth();

  const [navOpen, setNavOpen] = React.useState(false);
  React.useEffect(() => setNavOpen(false), [location.pathname]);
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4 lg:hidden">
        <Brand />
        <button type="button" aria-label={navOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)} className="flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground">
          {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>
      {navOpen && <button type="button" aria-label="Close navigation" className="fixed inset-0 top-14 z-30 bg-black/40 lg:hidden" onClick={() => setNavOpen(false)} />}
      <aside className={cn(
        'fixed inset-y-14 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200 ease-out lg:static lg:inset-auto lg:w-60 lg:translate-x-0',
        navOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="hidden h-14 items-center border-b border-border px-4 lg:flex">
          <Brand />
        </div>
        <nav aria-label="Primary navigation" className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => cn(
                'group flex h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors duration-150',
                isActive ? 'bg-surface-2 font-medium text-foreground' : 'text-muted hover:bg-surface-2/70 hover:text-foreground',
              )}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('h-4 w-4 shrink-0 transition-colors duration-150', isActive ? 'text-primary' : 'text-muted group-hover:text-foreground')} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.to === '/libraries' && <LowConfidenceBadge />}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1 border-t border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted" title={username ?? undefined}>{username}</span>
          <ThemeToggle />
          <button type="button" onClick={() => void logout()} aria-label="Sign out" title="Sign out" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        <KavitaIndicator />
        <SidebarStatus />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {/* Padding lives on an inner wrapper, not on the scroll container itself: sticky
            page elements (tab bars) pin flush to the scrollport edge this way. */}
        <div className="p-4 sm:p-6 lg:p-8">
          <div key={location.pathname} className="animate-fade-up">
            <PageErrorBoundary>
              <Routes>
                <Route path="/" element={<Navigate to="/libraries" replace />} />
                <Route path="/libraries" element={<Libraries />} />
                <Route path="/libraries/:libraryId" element={<Libraries />} />
                <Route path="/downloader" element={<Downloader />} />
                <Route path="/jobs" element={<Jobs />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/libraries" replace />} />
              </Routes>
            </PageErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
