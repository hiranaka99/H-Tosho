import * as React from 'react';

export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'h-tosho:theme';

function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Toggle the `dark` class on <html>. Mirrors the pre-paint script in index.html. */
function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

interface ThemeContextValue {
  /** The user's choice; 'system' follows the OS preference. */
  theme: Theme;
  /** What is actually rendered right now. */
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  /** system → light → dark → system, for compact icon toggles. */
  cycle: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = React.useState<Theme>(storedTheme);
  const [systemDark, setSystemDark] = React.useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Track OS preference changes while the user is on 'system'.
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  React.useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable (private mode) — theme still applies for the session */
    }
  }, [theme]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolved: theme === 'system' ? (systemDark ? 'dark' : 'light') : theme,
      setTheme,
      cycle: () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system')),
    }),
    [theme, systemDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
