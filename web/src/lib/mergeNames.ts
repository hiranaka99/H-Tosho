/** Series names are metadata; generated folder names also need filesystem-safe characters. */
export function folderNameFrom(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
}

export function mergeSeriesNameError(name: string): string | null {
  if (!name.trim()) return 'Enter a series name.';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Use a series name without control characters.';
  return null;
}
