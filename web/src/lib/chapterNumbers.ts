/** Blank chapters are optional; numbered chapters use positive decimal values. */
export function chapterNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) &&
    number > 0 &&
    number < Number.MAX_SAFE_INTEGER
    ? number
    : null;
}

/** Check proposed changes without rejecting untouched legacy metadata. */
export function chapterErrors(
  entries: { key: string; value: string; changed: boolean }[]
): Record<string, string> {
  const errors: Record<string, string> = {};
  const numbered = new Map<number, { key: string; changed: boolean }[]>();
  for (const entry of new Map(
    entries.map((entry) => [entry.key, entry])
  ).values()) {
    if (!entry.value.trim()) continue;
    const number = chapterNumber(entry.value);
    if (number === null) {
      if (entry.changed)
        errors[entry.key] =
          "Use a chapter number greater than 0, or leave blank.";
      continue;
    }
    numbered.set(number, [...(numbered.get(number) ?? []), entry]);
  }
  for (const [number, matches] of numbered) {
    if (matches.length > 1 && matches.some((entry) => entry.changed)) {
      for (const entry of matches)
        errors[entry.key] =
          `Chapter ${number} is used more than once. Choose a different number.`;
    }
  }
  return errors;
}
