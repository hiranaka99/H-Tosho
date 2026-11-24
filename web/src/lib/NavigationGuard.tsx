import * as React from 'react';
import { useBlocker } from 'react-router';
import { useSettingsNavigation } from './SettingsDrafts';

const NavigationGuardDialog = React.lazy(() => import('./NavigationGuardDialog'));

export function NavigationGuard() {
  const drafts = useSettingsNavigation();
  const blocker = useBlocker(React.useCallback(({ currentLocation, nextLocation }) =>
    drafts.dirty && currentLocation.pathname === '/settings' && nextLocation.pathname !== '/settings', [drafts.dirty]));
  // A beforeunload listener makes the page ineligible for the back/forward
  // cache, so attach it only while there are unsaved drafts to protect.
  React.useEffect(() => {
    if (!drafts.dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [drafts.dirty]);
  // Mount the dialog once navigation is first blocked, then keep it mounted so it can animate closed.
  const [needed, setNeeded] = React.useState(false);
  if (blocker.state === 'blocked' && !needed) setNeeded(true);
  if (!needed) return null;
  return <React.Suspense fallback={null}><NavigationGuardDialog blocker={blocker} drafts={drafts} /></React.Suspense>;
}
