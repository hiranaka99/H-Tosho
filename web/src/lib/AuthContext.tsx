import * as React from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import { api, type AuthStatus } from './api';
import { Button, Card, CardContent, Input, Label } from '../components/ui';
import { AuthContext } from './appContexts';

export interface AuthContextValue extends AuthStatus {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AuthStatus | null>(null);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await api.authStatus());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  React.useEffect(() => {
    const unauthorized = () => void refresh();
    window.addEventListener('htosho:unauthorized', unauthorized);
    return () => window.removeEventListener('htosho:unauthorized', unauthorized);
  }, [refresh]);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const logout = React.useCallback(async () => {
    await api.logout();
    setStatus({ setupRequired: false, authenticated: false, username: null });
  }, []);
  const value = React.useMemo<AuthContextValue | null>(() => status ? { ...status, refresh, logout } : null, [status, refresh, logout]);

  if (!status || !value) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" /> {error || 'Loading…'}</div>
      </div>
    );
  }

  if (!status.authenticated) {
    return <AuthScreen setupRequired={status.setupRequired} onAuthenticated={setStatus} />;
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

function AuthScreen({ setupRequired, onAuthenticated }: { setupRequired: boolean; onAuthenticated: (status: AuthStatus) => void }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (setupRequired && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setPending(true);
    setError('');
    try {
      const result = setupRequired ? await api.setup(username, password) : await api.login(username, password);
      onAuthenticated({ setupRequired: false, ...result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-3 sm:p-4">
      <Card className="w-full max-w-md overflow-hidden shadow-lg">
        <div className="flex flex-col items-center gap-3 border-b border-border bg-surface-2/50 px-6 py-7 text-center">
          <img src="/h-tosho-icon.png?v=26b1c759" alt="H-Tosho" width={64} height={64} decoding="async" className="h-16 w-16 rounded-xl object-contain" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{setupRequired ? 'Set up H-Tosho' : 'Welcome back'}</h1>
            <p className="mt-1 text-sm text-muted">{setupRequired ? 'Create the account used to protect this installation.' : 'Sign in to manage your library.'}</p>
          </div>
        </div>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-username">Username</Label>
              <Input id="auth-username" name="username" autoComplete="username" autoFocus required maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-password">Password</Label>
              <Input id="auth-password" name="password" type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            {setupRequired && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="auth-confirm-password">Confirm password</Label>
                <Input id="auth-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </div>
            )}
            {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" size="lg" disabled={pending || !username.trim() || password.length < 8 || (setupRequired && confirmPassword.length < 8)}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
              {setupRequired ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
