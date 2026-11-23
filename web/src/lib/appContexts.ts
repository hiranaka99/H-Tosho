import * as React from 'react';
import type { DownloadActionsApi, DownloadTasksApi, GalleryStatusStore } from './DownloadsContext';
import type { AuthContextValue } from './AuthContext';

/**
 * Context objects for providers whose modules import app UI or page code
 * (components/ui, pages/downloader/state, lib/toast, …).
 *
 * They live in this module, which imports only React, so a dev-server hot
 * update to any of those imports can re-run the provider modules without
 * minting new context objects. With fresh objects, the providers already
 * mounted at the app root keep serving the old ones: anything rendered after
 * the update (such as a lazily loaded dialog) reads an empty context, and the
 * page breaks until a full reload.
 */
export const DownloadActionsContext = React.createContext<DownloadActionsApi | null>(null);
export const DownloadTasksContext = React.createContext<DownloadTasksApi | null>(null);
export const GalleryStatusContext = React.createContext<GalleryStatusStore | null>(null);
export const AuthContext = React.createContext<AuthContextValue | null>(null);
