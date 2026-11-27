export function formatSpeed(bps: number | null): string {
  if (!bps || bps <= 0) return "";
  const mb = bps / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatEta(remainingBytes: number, bps: number | null): string {
  if (
    !bps ||
    bps <= 0 ||
    !Number.isFinite(remainingBytes) ||
    remainingBytes <= 0
  )
    return "";
  const seconds = Math.ceil(remainingBytes / bps);
  if (seconds < 60) return `~${seconds}s left`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `~${mins}m ${secs}s left` : `~${mins}m left`;
  }
  let hours = Math.floor(seconds / 3600);
  let mins = Math.round((seconds % 3600) / 60);
  if (mins === 60) {
    hours += 1;
    mins = 0;
  }
  return mins > 0 ? `~${hours}h ${mins}m left` : `~${hours}h left`;
}
