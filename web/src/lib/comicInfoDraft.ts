export interface ComicInfoDraft {
  xml: string;
  originalXml: string;
  values: Record<string, string>;
  originalValues: Record<string, string>;
  scalarFields: string[];
  mode: 'form' | 'raw';
  rawEdited: boolean;
  error: string | null;
}

export const EMPTY_COMICINFO = '<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo></ComicInfo>\n';

/** Keep nested metadata in XML; only scalar elements belong in form fields. */
function readDocument(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement?.tagName !== 'ComicInfo') {
    throw new Error('Enter valid XML with a single ComicInfo root element. Your draft is kept; fix the XML before saving or switching to Fields.');
  }
  const values: Record<string, string> = {};
  const scalarFields: string[] = [];
  for (const element of document.documentElement.children) {
    // Repeated tags cannot be edited unambiguously through one scalar input.
    if (element.children.length || scalarFields.includes(element.tagName)) continue;
    if ([...document.documentElement.children].filter(child => child.tagName === element.tagName).length > 1) continue;
    scalarFields.push(element.tagName);
    values[element.tagName] = element.textContent ?? '';
  }
  return { document, values, scalarFields };
}

export function createComicInfoDraft(xml: string | null): ComicInfoDraft {
  const source = xml ?? EMPTY_COMICINFO;
  try {
    const parsed = readDocument(source);
    return { xml: source, originalXml: source, values: parsed.values, originalValues: { ...parsed.values }, scalarFields: parsed.scalarFields, mode: 'form', rawEdited: false, error: null };
  } catch (error) {
    return { xml: source, originalXml: source, values: {}, originalValues: {}, scalarFields: [], mode: 'raw', rawEdited: false, error: (error as Error).message };
  }
}

export function editComicInfoXml(draft: ComicInfoDraft, xml: string): ComicInfoDraft {
  try {
    const parsed = readDocument(xml);
    return { ...draft, xml, values: parsed.values, scalarFields: parsed.scalarFields, rawEdited: true, error: null };
  } catch (error) {
    return { ...draft, xml, rawEdited: true, error: (error as Error).message };
  }
}

export function editComicInfoField(draft: ComicInfoDraft, field: string, value: string): ComicInfoDraft {
  const { document } = readDocument(draft.xml);
  const root = document.documentElement;
  const existing = [...root.children].find(element => element.tagName === field);
  if (!value.trim()) existing?.remove();
  else {
    const element = existing ?? document.createElement(field);
    element.textContent = value;
    if (!existing) root.appendChild(element);
  }
  const parsed = readDocument(new XMLSerializer().serializeToString(document));
  return { ...draft, xml: new XMLSerializer().serializeToString(document), values: parsed.values, scalarFields: parsed.scalarFields, error: null };
}

export function changedComicInfoFields(draft: ComicInfoDraft): string[] {
  return [...new Set([...Object.keys(draft.values), ...Object.keys(draft.originalValues)])]
    .filter(field => (draft.values[field] ?? '') !== (draft.originalValues[field] ?? ''));
}

export function comicInfoHasChanges(draft: ComicInfoDraft): boolean {
  return draft.rawEdited ? draft.xml !== draft.originalXml : changedComicInfoFields(draft).length > 0;
}
