import type { DownloadErrorCode } from '../../../server/src/contracts/downloads';
/** Recovery copy for download and provider failures; retain the original in details. */
export function downloadErrorHelp(message: string, code?: DownloadErrorCode | null): { message: string; settings?: boolean } {
  if (code) {
    const help: Record<DownloadErrorCode, { message: string; settings?: boolean }> = {
      cancelled: { message: 'Download cancelled. Retry when you’re ready.' },
      network: { message: 'Could not reach the source. Check your connection, then retry.' },
      'rate-limit': { message: 'The source is receiving too many requests. Wait a little, then retry.' },
      upstream: { message: 'The source is temporarily unavailable. Try again in a few minutes.' },
      'access-denied': { message: 'The source denied access. Check its connection settings before retrying.', settings: true },
      'output-missing': { message: 'Check the output folder in Downloader settings, then retry.', settings: true },
      permissions: { message: 'H-Tosho cannot write to the output folder. Check its permissions or choose another folder, then retry.', settings: true },
      'download-failed': { message: 'The request could not finish. Retry, or open technical details to investigate.' },
    };
    return help[code];
  }
  // Legacy API responses and pre-enqueue errors have no structured code.
  if (/cancelled by user/i.test(message)) return { message: 'Download cancelled. Retry when you’re ready.' };
  if (/download directory|output folder|downloadDirectory/i.test(message)) return { message: 'Set an output folder in Downloader settings, then retry.', settings: true };
  if (/EACCES|EPERM|permission denied|not writable/i.test(message)) return { message: 'H-Tosho cannot write to the output folder. Check its permissions or choose another folder, then retry.', settings: true };
  if (/ENOENT|no such file|directory.*not.*exist/i.test(message)) return { message: 'The output folder or a required file is missing. Check the folder in settings, then retry.', settings: true };
  if (/401|403|api.?key|unauthorized|forbidden/i.test(message)) return { message: 'The source denied access. Check its connection settings before retrying.', settings: true };
  if (/429|rate.?limit|too many requests/i.test(message)) return { message: 'The source is receiving too many requests. Wait a little, then retry.' };
  if (/50[234]|unavailable|bad gateway/i.test(message)) return { message: 'The source is temporarily unavailable. Try again in a few minutes.' };
  if (/timeout|timed out|fetch failed|network|ECONN|ENOTFOUND/i.test(message)) return { message: 'Could not reach the source. Check your connection, then retry.' };
  return { message: 'The request could not finish. Retry, or open technical details to investigate.' };
}
