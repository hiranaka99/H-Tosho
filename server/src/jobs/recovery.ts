import { classifyJobError, type JobErrorCode } from './errors.js';
export interface JobRecovery {
  explanation: string;
  actions: { label: string; href: string }[];
}
/** Fixed in-app destinations only: error messages cannot supply navigation URLs. */
export function jobRecovery(job: { status: string; type: string; payload: Record<string, unknown>; errorMessage: string | null; errorCode?: JobErrorCode | null }): JobRecovery | undefined {
  if (job.status !== 'failed' || !job.errorMessage || !job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) return;
  const message = job.errorMessage;
  const classified = classifyJobError(message);
  // Older jobs can have stored misleading mount/path classifications.
  const code = classified === 'path-too-long' ? classified : job.errorCode ?? classified;
  const fromMessage = /\bseries\s+(\d+)\b/i.exec(message)?.[1];
  const seriesId = Number(job.payload.seriesId ?? fromMessage);
  const hasSeries = Number.isSafeInteger(seriesId) && seriesId > 0;
  const file = typeof job.payload.path === 'string' ? job.payload.path : undefined;
  const editor = new URLSearchParams(hasSeries ? { series: String(seriesId), action: 'comicinfo' } : file ? { file } : {});
  const target = hasSeries ? `/libraries?series=${seriesId}` : '/libraries';
  if (job.type === 'restore-metadata') {
    return { explanation: 'Inspect current metadata and the recorded restore outcome, then create a fresh preview. This restore cannot be retried blindly.',
      actions: hasSeries ? [{ label: 'Review metadata history', href: `${target}&action=identify` }] : [{ label: 'Open Libraries', href: '/libraries' }] };
  }
  if (code === 'path-too-long') {
    return { explanation: 'A file name or path exceeds the filesystem limit. Shorten the affected name or parent path before retrying.',
      actions: hasSeries ? [{ label: 'Inspect series', href: target }] : [] };
  }
  if (code === 'conflicting-title') {
    const actions = [{ label: 'Inspect series', href: target }];
    const fields = job.payload.fields && typeof job.payload.fields === 'object' ? job.payload.fields as Record<string, unknown> : {};
    const title = typeof job.payload.selectedTitle === 'string' ? job.payload.selectedTitle : typeof fields.Series === 'string' ? fields.Series : '';
    if (title.trim()) actions.push({ label: 'Find conflicting title', href: `${target}${hasSeries ? '&' : '?'}q=${encodeURIComponent(title.trim())}` });
    if (job.type === 'edit-comicinfo' && (hasSeries || file)) actions.unshift({ label: 'Edit ComicInfo title', href: `/libraries?${editor.toString()}` });
    else if (hasSeries) actions.unshift({ label: 'Choose another title', href: `${target}&action=identify` });
    return { explanation: 'Kavita already has a series with that title. Inspect the series or choose a different title before retrying.', actions };
  }
  if (code === 'missing-files') {
    return { explanation: 'Check that the library is mounted into H-Tosho and its Kavita path maps to the correct local folder, then retry.',
      actions: [{ label: 'Configure library folders', href: '/settings?tab=general#library-folders' }, ...(hasSeries ? [{ label: 'Inspect series', href: target }] : [])] };
  }
  if (code === 'permissions') {
    return { explanation: 'H-Tosho needs write access to the mounted library folder. Check the mount and filesystem permissions before retrying.',
      actions: [{ label: 'Check library folders', href: '/settings?tab=general#library-folders' }] };
  }
  if (code === 'kavita-connection') {
    return { explanation: 'Verify the Kavita address and admin Auth Key, then use Save & test connection before retrying.',
      actions: [{ label: 'Check Kavita connection', href: '/settings?tab=general#kavita-connection' }] };
  }
  if (code === 'provider-configuration') {
    return { explanation: 'Check the provider configuration and test its connection before retrying.', actions: [{ label: 'Check providers', href: '/settings?tab=providers' }] };
  }
  if (code === 'upstream-unavailable') {
    return { explanation: 'The upstream service may be temporarily unavailable or rate-limited. Wait before retrying; check provider health if it persists.',
      actions: [{ label: 'Check providers', href: '/settings?tab=providers' }] };
  }
}
