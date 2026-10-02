export interface JobRecovery {
  explanation: string;
  actions: { label: string; href: string }[];
}
/** Fixed in-app destinations only: error messages cannot supply navigation URLs. */
export function jobRecovery(job: { status: string; type: string; payload: Record<string, unknown>; errorMessage: string | null }): JobRecovery | undefined {
  if (job.status !== 'failed' || !job.errorMessage || !job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) return;
  const message = job.errorMessage;
  const fromMessage = /\bseries\s+(\d+)\b/i.exec(message)?.[1];
  const seriesId = Number(job.payload.seriesId ?? fromMessage);
  const hasSeries = Number.isSafeInteger(seriesId) && seriesId > 0;
  const file = typeof job.payload.path === 'string' ? job.payload.path : undefined;
  const editor = new URLSearchParams(hasSeries ? { series: String(seriesId), action: 'comicinfo' } : file ? { file } : {});
  const target = hasSeries ? `/libraries?series=${seriesId}` : '/libraries';
  if (/series with this name already exists|duplicate (?:series|title)|title.*already exists/i.test(message)) {
    const actions = [{ label: 'Inspect series', href: target }];
    const fields = job.payload.fields && typeof job.payload.fields === 'object' ? job.payload.fields as Record<string, unknown> : {};
    const title = typeof job.payload.selectedTitle === 'string' ? job.payload.selectedTitle : typeof fields.Series === 'string' ? fields.Series : '';
    if (title.trim()) actions.push({ label: 'Find conflicting title', href: `${target}${hasSeries ? '&' : '?'}q=${encodeURIComponent(title.trim())}` });
    if (job.type === 'edit-comicinfo' && (hasSeries || file)) actions.unshift({ label: 'Edit ComicInfo title', href: `/libraries?${editor}` });
    else if (hasSeries) actions.unshift({ label: 'Choose another title', href: `${target}&action=identify` });
    return { explanation: 'Kavita already has a series with that title. Inspect the series or choose a different title before retrying.', actions };
  }
  if (/could not locate.*(?:folder|file)|folder.*(?:not found|unavailable|inaccessible)|no .*cbz|ENOENT|not accessible|not readable|mount/i.test(message)) {
    return { explanation: 'Check that the library is mounted into H-Tosho and its Kavita path maps to the correct local folder, then retry.',
      actions: [{ label: 'Configure library folders', href: '/settings?tab=general#library-folders' }, ...(hasSeries ? [{ label: 'Inspect series', href: target }] : [])] };
  }
  if (/EACCES|EPERM|permission denied|read.only|EROFS/i.test(message)) {
    return { explanation: 'H-Tosho needs write access to the mounted library folder. Check the mount and filesystem permissions before retrying.',
      actions: [{ label: 'Check library folders', href: '/settings?tab=general#library-folders' }] };
  }
  if (/Kavita|Auth Key|HTTP (?:401|403)|ECONNREFUSED|ENOTFOUND|connection.*(?:timed out|timeout|failed)/i.test(message)) {
    return { explanation: 'Verify the Kavita address and admin Auth Key, then use Save & test connection before retrying.',
      actions: [{ label: 'Check Kavita connection', href: '/settings?tab=general#kavita-connection' }] };
  }
  if (/credential|client.?id|provider.*(?:disabled|unavailable)|AniList|MangaDex|MyAnimeList/i.test(message)) {
    return { explanation: 'Check the provider configuration and test its connection before retrying.', actions: [{ label: 'Check providers', href: '/settings?tab=providers' }] };
  }
  if (/HTTP 429|rate.limit|HTTP 50\d|timed? ?out|ETIMEDOUT|network|fetch failed/i.test(message)) {
    return { explanation: 'The upstream service may be temporarily unavailable or rate-limited. Wait before retrying; check provider health if it persists.',
      actions: [{ label: 'Check providers', href: '/settings?tab=providers' }] };
  }
}
