import * as React from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Library, Settings as SettingsIcon, ListChecks, BookOpenText, Download } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { Libraries } from './pages/Libraries';
import { Downloader } from './pages/Downloader';
import { Jobs } from './pages/Jobs';
import { Settings } from './pages/Settings';
import { SidebarStatus } from './components/SidebarStatus';
import { cn } from './lib/utils';
function LowConfidenceBadge() {
  const { data } = useQuery({ queryKey: ['low-confidence'], queryFn: api.lowConfidenceCount, refetchInterval: 60_000 });
  if (!data || data.count === 0) return null;
  return (
    <span className="ml-auto rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold text-warning" title={`${data.count} matched series below ${Math.round(data.threshold * 100)}% confidence — review them in Libraries (filter: Low confidence)`}>
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
    <div className="flex items-center gap-2 border-t border-border px-4 py-2" title={state === 'error' ? data.error ?? undefined : label}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', state === 'ok' ? 'bg-success' : state === 'error' ? 'animate-pulse-soft bg-danger' : 'bg-border-2')} />
      <span className="min-w-0 flex-1 truncate text-[10px] text-muted">{label}</span>
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
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV = [
  { to: '/libraries', label: 'Libraries', icon: Library },
  { to: '/downloader', label: 'Downloader', icon: Download },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function App() {
  const location = useLocation();
  const inLibrary = location.pathname.startsWith('/libraries');

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface/80 backdrop-blur-sm">
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary-hover text-white shadow-lg shadow-primary/30">
            <BookOpenText className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight tracking-tight">H-Tosho</div>
            <div className="truncate text-[10px] leading-tight text-muted">Kavita metadata manager</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150 hover:translate-x-0.5',
                  isActive
                    ? 'bg-gradient-to-r from-primary/20 to-primary/5 font-medium text-primary'
                    : 'text-muted hover:bg-surface-2 hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('h-4 w-4 shrink-0 transition-transform duration-150', isActive ? 'scale-110' : 'group-hover:scale-105')} />
                  {item.label}
                  {item.to === '/libraries' && <LowConfidenceBadge />}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <KavitaIndicator />
        <SidebarStatus />
      </aside>
      <main className={cn('min-w-0 flex-1 overflow-y-auto', inLibrary ? 'p-6' : 'p-8')}>
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
      </main>
    </div>
  );
}
