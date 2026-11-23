import type { DownloadErrorCode } from '../../../server/src/contracts/downloads';

/** Name the site when it is known; generic copy keeps working without one. */
function named(help: { message: string; settings?: boolean }, source?: string): { message: string; settings?: boolean } {
  if (!source) return help;
  return { ...help, message: help.message.replace(/^The source/, source).replace(/the source/g, source) };
}

/** Recovery copy for download and provider failures; retain the original in details. */
export function downloadErrorHelp(message: string, code?: DownloadErrorCode | null, source?: string): { message: string; settings?: boolean } {
  if (code) {
    const help: Record<DownloadErrorCode, { message: string; settings?: boolean }> = {
      cancelled: { message: 'Download cancelled. Retry when you’re ready.' },
      network: { message: 'Could not reach the source. Check your connection, then retry.' },
      'rate-limit': { message: 'The source is receiving too many requests. Wait a little, then retry.' },
      quota: { message: 'Your image quota on the source is exhausted. Wait for it to reset, then retry.' },
      upstream: { message: 'The source is temporarily unavailable. Try again in a few minutes.' },
      'access-denied': { message: 'The source denied access. Check its connection settings before retrying.', settings: true },
      'output-missing': { message: 'Check the output folder in Download settings, then retry.', settings: true },
      'disk-full': { message: 'The output drive is out of disk space. Free up space or choose another folder, then retry.', settings: true },
      permissions: { message: 'H-Tosho cannot write to the output folder. Check its permissions or choose another folder, then retry.', settings: true },
      'download-failed': { message: 'The request could not finish. Retry, or open technical details to investigate.' },
    };
    return named(help[code], source);
  }
  // Legacy API responses and pre-enqueue errors have no structured code.
  if (/cancelled by user/i.test(message)) return { message: 'Download cancelled. Retry when you’re ready.' };
  if (/ENOSPC|EDQUOT|no space left|disk full/i.test(message)) return { message: 'The output drive is out of disk space. Free up space or choose another folder, then retry.', settings: true };
  if (/download directory|output folder|downloadDirectory/i.test(message)) return { message: 'Set an output folder in Download settings, then retry.', settings: true };
  if (/EACCES|EPERM|permission denied|not writable/i.test(message)) return { message: 'H-Tosho cannot write to the output folder. Check its permissions or choose another folder, then retry.', settings: true };
  if (/ENOENT|no such file|directory.*not.*exist/i.test(message)) return { message: 'The output folder or a required file is missing. Check the folder in settings, then retry.', settings: true };
  if (/509|image.?quota|quota.*exhausted/i.test(message)) return named({ message: 'Your image quota on the source is exhausted. Wait for it to reset, then retry.' }, source);
  if (/401|403|api.?key|unauthorized|forbidden/i.test(message)) return named({ message: 'The source denied access. Check its connection settings before retrying.', settings: true }, source);
  if (/429|rate.?limit|too many requests/i.test(message)) return named({ message: 'The source is receiving too many requests. Wait a little, then retry.' }, source);
  if (/50[234]|unavailable|bad gateway/i.test(message)) return named({ message: 'The source is temporarily unavailable. Try again in a few minutes.' }, source);
  if (/timeout|timed out|fetch failed|network|ECONN|ENOTFOUND/i.test(message)) return named({ message: 'Could not reach the source. Check your connection, then retry.' }, source);
  return { message: 'The request could not finish. Retry, or open technical details to investigate.' };
}

/**
 * Why an automatic retry is waiting, phrased for a task H-Tosho is handling on
 * its own: no instruction to retry, because nothing is asked of the user.
 */
export function retryWaitReason(message: string | null, code: DownloadErrorCode | null, source: string): string {
  const kind = code ?? (message && /429|rate.?limit|too many requests/i.test(message) ? 'rate-limit'
    : message && /50[234]|unavailable|bad gateway/i.test(message) ? 'upstream'
      : 'network');
  if (kind === 'rate-limit') return `${source} is limiting requests.`;
  if (kind === 'upstream') return `${source} is temporarily unavailable.`;
  return `${source} could not be reached.`;
}
