import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, ApiError, type DoujinSearchResult, type DuplicateCheck } from '../../lib/api';
import { useDownloadActions } from '../../lib/DownloadsContext';
import { useDuplicateReview } from '../../components/DuplicateReview';
import { downloadErrorHelp } from '../../lib/downloadErrors';
import { toast } from '../../lib/toast';
import { DOWNLOADER_SETTINGS_URL, type DownloadSetup } from './state';

/** The same setup, duplicate review and queue workflow on Home and Downloader. */
export function useGalleryDownload() {
  const navigate = useNavigate();
  const { startDownload } = useDownloadActions();
  const { checkDuplicates, reviewCheck, dialog: duplicateDialog } = useDuplicateReview();
  const settings = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  const { isError: settingsFailed, data: settingsData, refetch: refetchSettings } = settings;
  // Stable between renders so memoized consumers (selection bar destination) can skip work.
  const setup = React.useMemo<DownloadSetup>(() => ({
    status: settingsFailed ? 'error' : !settingsData ? 'loading' : settingsData.downloadDirectory.trim() ? 'ready' : 'missing',
    directory: settingsData?.downloadDirectory,
    format: settingsData?.format,
    onRetry: () => { void refetchSettings(); },
  }), [settingsFailed, settingsData, refetchSettings]);
  const status = setup.status;
  const ensureDownloadReady = React.useCallback(() => {
    if (status === 'ready') return true;
    if (status === 'missing') void navigate(DOWNLOADER_SETTINGS_URL);
    else toast({ tone: 'info', title: status === 'loading' ? 'Checking download settings' : 'Download settings unavailable', description: 'Retry the settings check before starting a download.' });
    return false;
  }, [status, navigate]);
  const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(new Set());
  const inFlight = React.useRef(new Set<string>());
  const doStartDownload = React.useCallback(async (item: DoujinSearchResult) => {
    const key = `${item.source}:${item.galleryId}`;
    if (inFlight.current.has(key) || !ensureDownloadReady()) return;
    inFlight.current.add(key);
    setPendingKeys(current => new Set(current).add(key));
    try {
      const approved = await checkDuplicates([item]);
      if (approved === null) return;
      const input = { source: item.source, galleryId: item.galleryId, url: item.url, title: item.title, allowDuplicate: approved.has(key) };
      try { await startDownload(input); }
      catch (error) {
        if (!(error instanceof ApiError) || error.message !== 'possible-duplicate') throw error;
        const approval = await reviewCheck(error.details as unknown as DuplicateCheck);
        if (approval !== null) await startDownload({ ...input, allowDuplicate: approval.has(key) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'already-downloaded') toast({ tone: 'info', title: 'Already downloaded', description: 'Open Downloads and choose Download again to get another copy.' });
      else if (message !== 'already-queued') toast({ tone: 'danger', title: 'Could not start download', description: downloadErrorHelp(message).message });
    } finally {
      inFlight.current.delete(key);
      setPendingKeys(current => new Set([...current].filter(value => value !== key)));
    }
  }, [startDownload, ensureDownloadReady, checkDuplicates, reviewCheck]);
  return { setup, ensureDownloadReady, startDownload, checkDuplicates, reviewCheck, duplicateDialog, pendingKeys, doStartDownload };
}
