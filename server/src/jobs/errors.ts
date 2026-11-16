export type JobErrorCode = 'review-required' | 'path-too-long' | 'conflicting-title' | 'missing-files' | 'permissions' | 'kavita-connection' | 'provider-configuration' | 'upstream-unavailable' | 'job-failed';
/** Normalize errors at the external/filesystem boundary. Legacy rows use this same decoder. */
export function classifyJobError(message: string): JobErrorCode {
  if (/review.required|changed after preview|restore.*(?:conflict|protected|interrupted)/i.test(message)) return 'review-required';
  if (/\bENAMETOOLONG\b|(?:file ?name|name|path) too long/i.test(message)) return 'path-too-long';
  if (/series with this name already exists|duplicate (?:series|title)|title.*already exists/i.test(message)) return 'conflicting-title';
  if (/could not locate.*(?:folder|file)|folder.*(?:not found|unavailable|inaccessible)|no .*cbz|ENOENT|not accessible|not readable|mount/i.test(message)) return 'missing-files';
  if (/EACCES|EPERM|permission denied|read.only|EROFS/i.test(message)) return 'permissions';
  if (/Kavita|Auth Key|HTTP (?:401|403)|ECONNREFUSED|ENOTFOUND|connection.*(?:timed out|timeout|failed)/i.test(message)) return 'kavita-connection';
  if (/credential|client.?id|provider.*(?:disabled|unavailable)|AniList|MangaDex|MyAnimeList/i.test(message)) return 'provider-configuration';
  if (/HTTP 429|rate.limit|HTTP 50\d|timed? ?out|ETIMEDOUT|network|fetch failed/i.test(message)) return 'upstream-unavailable';
  return 'job-failed';
}
