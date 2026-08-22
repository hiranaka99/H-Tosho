import * as React from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutDashboard, Library, Settings as SettingsIcon, ListChecks, BookOpenText, Download } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Libraries } from './pages/Libraries';
import { Downloader } from './pages/Downloader';
import { Jobs } from './pages/Jobs';
import { Settings } from './pages/Settings';
import { DownloadTray } from './components/DownloadTray';
import { cn } from './lib/utils';

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
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
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
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <BookOpenText className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">H-Tosho</div>
            <div className="text-[10px] text-muted leading-tight">Kavita metadata manager</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2 hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className={cn('flex-1 overflow-y-auto', inLibrary ? 'p-6' : 'p-8')}>
        <PageErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/libraries" element={<Libraries />} />
            <Route path="/libraries/:libraryId" element={<Libraries />} />
            <Route path="/downloader" element={<Downloader />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </PageErrorBoundary>
      </main>
      <DownloadTray />
    </div>
  );
}
