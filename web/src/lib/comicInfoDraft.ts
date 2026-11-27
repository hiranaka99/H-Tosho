/** A form edit not yet written into `xml`; `recreate` means the element was removed first. */
interface FieldEdit {
  value: string;
  recreate: boolean;
}

export interface ComicInfoDraft {
  /** XML as of the last parse; form edits since then live in `fieldEdits` (see `comicInfoXml`). */
  xml: string;
  originalXml: string;
  values: Record<string, string>;
  originalValues: Record<string, string>;
  scalarFields: string[];
  mode: "form" | "raw";
  rawEdited: boolean;
  error: string | null;
  /** Tags present in the XML that are not editable scalars (repeated or nested). */
  opaqueFields: string[];
  /** Pending form edits in application order, folded into XML only when it is needed. */
  fieldEdits: Record<string, FieldEdit>;
}

export const EMPTY_COMICINFO =
  '<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo></ComicInfo>\n';

/** Keep nested metadata in XML; only scalar elements belong in form fields. */
function extractScalars(document: Document) {
  const values: Record<string, string> = {};
  const scalarFields: string[] = [];
  const opaque = new Set<string>();
  const counts = new Map<string, number>();
  for (const element of document.documentElement.children) {
    counts.set(element.tagName, (counts.get(element.tagName) ?? 0) + 1);
  }
  for (const element of document.documentElement.children) {
    // Repeated tags cannot be edited unambiguously through one scalar input.
    if (element.children.length || (counts.get(element.tagName) ?? 0) > 1) {
      opaque.add(element.tagName);
      continue;
    }
    scalarFields.push(element.tagName);
    values[element.tagName] = element.textContent ?? "";
  }
  return { values, scalarFields, opaqueFields: [...opaque] };
}

/** Write one field into a parsed document: blank removes the first matching element. */
function applyField(
  document: Document,
  field: string,
  value: string,
  recreate = false
) {
  const root = document.documentElement;
  let existing: Element | undefined;
  for (const element of root.children) {
    if (element.tagName === field) {
      existing = element;
      break;
    }
  }
  if (recreate && existing) {
    existing.remove();
    existing = undefined;
  }
  if (!value.trim()) existing?.remove();
  else {
    const element = existing ?? document.createElement(field);
    element.textContent = value;
    if (!existing) root.appendChild(element);
  }
}

/** Parse `xml` and replay the pending form edits onto it. */
function documentWithEdits(draft: ComicInfoDraft): Document {
  const { document } = readDocument(draft.xml);
  for (const [field, edit] of Object.entries(draft.fieldEdits))
    applyField(document, field, edit.value, edit.recreate);
  return document;
}

/** The draft's full XML, including form edits (built on demand, not per keystroke). */
export function comicInfoXml(draft: ComicInfoDraft): string {
  if (!Object.keys(draft.fieldEdits).length) return draft.xml;
  return new XMLSerializer().serializeToString(documentWithEdits(draft));
}

function readDocument(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (
    document.querySelector("parsererror") ||
    document.documentElement?.tagName !== "ComicInfo"
  ) {
    throw new Error(
      "Enter valid XML with a single ComicInfo root element. Your draft is kept; fix the XML before saving or switching to Fields."
    );
  }
  return { document, ...extractScalars(document) };
}

export function createComicInfoDraft(xml: string | null): ComicInfoDraft {
  const source = xml ?? EMPTY_COMICINFO;
  try {
    const parsed = readDocument(source);
    return {
      xml: source,
      originalXml: source,
      values: parsed.values,
      originalValues: { ...parsed.values },
      scalarFields: parsed.scalarFields,
      mode: "form",
      rawEdited: false,
      error: null,
      opaqueFields: parsed.opaqueFields,
      fieldEdits: {},
    };
  } catch (error) {
    return {
      xml: source,
      originalXml: source,
      values: {},
      originalValues: {},
      scalarFields: [],
      mode: "raw",
      rawEdited: false,
      error: (error as Error).message,
      opaqueFields: [],
      fieldEdits: {},
    };
  }
}

export function editComicInfoXml(
  draft: ComicInfoDraft,
  xml: string
): ComicInfoDraft {
  try {
    const parsed = readDocument(xml);
    return {
      ...draft,
      xml,
      values: parsed.values,
      scalarFields: parsed.scalarFields,
      opaqueFields: parsed.opaqueFields,
      fieldEdits: {},
      rawEdited: true,
      error: null,
    };
  } catch (error) {
    return {
      ...draft,
      xml,
      fieldEdits: {},
      rawEdited: true,
      error: (error as Error).message,
    };
  }
}

export function editComicInfoField(
  draft: ComicInfoDraft,
  field: string,
  value: string
): ComicInfoDraft {
  // Unreadable XML cannot take form edits; the error stays on the draft.
  if (draft.error) return draft;
  if (draft.opaqueFields.includes(field)) {
    // Repeated/nested tags change shape when edited: take the full round-trip
    // (rare) so values and scalar fields stay exactly what the XML says.
    const document = documentWithEdits(draft);
    applyField(document, field, value);
    const xml = new XMLSerializer().serializeToString(document);
    const { values, scalarFields, opaqueFields } = extractScalars(document);
    return {
      ...draft,
      xml,
      values,
      scalarFields,
      opaqueFields,
      fieldEdits: {},
      error: null,
    };
  }
  // Scalar fields: O(1) value update per keystroke; XML is built when needed.
  const blank = !value.trim();
  const values = { ...draft.values };
  if (blank) delete values[field];
  else values[field] = value;
  const present = field in draft.values;
  const scalarFields = blank
    ? present
      ? draft.scalarFields.filter((name) => name !== field)
      : draft.scalarFields
    : present
      ? draft.scalarFields
      : [...draft.scalarFields, field];
  const fieldEdits = { ...draft.fieldEdits };
  const previous = fieldEdits[field];
  if (blank) {
    // Removal goes last; a later re-add appends a fresh element (as in the XML).
    delete fieldEdits[field];
    fieldEdits[field] = { value: "", recreate: previous?.recreate ?? false };
  } else if (previous && !previous.value.trim()) {
    delete fieldEdits[field];
    fieldEdits[field] = { value, recreate: true };
  } else {
    fieldEdits[field] = { value, recreate: previous?.recreate ?? false };
  }
  return { ...draft, values, scalarFields, fieldEdits, error: null };
}

export function changedComicInfoFields(draft: ComicInfoDraft): string[] {
  return [
    ...new Set([
      ...Object.keys(draft.values),
      ...Object.keys(draft.originalValues),
    ]),
  ].filter(
    (field) =>
      (draft.values[field] ?? "") !== (draft.originalValues[field] ?? "")
  );
}

export function comicInfoHasChanges(draft: ComicInfoDraft): boolean {
  return draft.rawEdited
    ? comicInfoXml(draft) !== draft.originalXml
    : changedComicInfoFields(draft).length > 0;
}
