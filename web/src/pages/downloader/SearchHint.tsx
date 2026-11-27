/** One short syntax line for every search scope, tied to its input with aria-describedby. */
export function SearchHint({ id }: { id: string }) {
  return (
    <p id={id} className="break-words text-xs text-muted">
      Filters: artist:, group:, parody:, character:, language: · “quoted phrase”
      · -exclude
    </p>
  );
}
