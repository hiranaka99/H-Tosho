import fs from 'node:fs';

/** Last path segment, tolerant of both separator styles (works cross-platform). */
export function lastSegment(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? '';
}

/** True when candidate is root itself or a descendant, never merely a shared prefix. */
export function pathContains(root: string, candidate: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function safeRealpath(value: string): string {
  try { return fs.realpathSync(value); } catch { return value; }
}
