/** Lossless edits: keep the current document, replacing only selected top-level elements. */
export const RESTORABLE_COMICINFO_FIELDS = ['Title', 'Series', 'Number', 'Volume', 'Artist', 'Writer', 'Publisher', 'Summary', 'Tags', 'Genre', 'Language', 'LanguageISO', 'Year', 'Web'] as const;
export type ComicInfoRestoreField = typeof RESTORABLE_COMICINFO_FIELDS[number];
interface ElementSpan { start: number; end: number }
interface DocumentSpans { fields: Map<string, ElementSpan>; close: number; selfClosed?:ElementSpan; namespace:string }

function decodeText(value:string):string {
  const decoded = value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,(_,entity:string) => {
    if (entity.startsWith('#')) {
      const code=Number.parseInt(entity.slice(entity[1]==='x'?2:1),entity[1]==='x'?16:10);
      if (!(code===9 || code===10 || code===13 || (code>=32 && code<=0xd7ff) || (code>=0xe000 && code<=0xfffd) || (code>=0x10000 && code<=0x10ffff))) throw new Error('ComicInfo XML contains an invalid character reference');
      return String.fromCodePoint(code);
    }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity];
  });
  if (/&(?!(?:#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/.test(value)) throw new Error('ComicInfo XML contains an unsupported entity');
  return decoded;
}

/** Reject ambiguous/unsupported XML rather than reserializing it and losing attributes or nested data. */
function spans(xml: string): DocumentSpans {
  const fields = new Map<string, ElementSpan>();
  const stack: { name: string; start: number }[] = [];
  let position = 0, root = false, finished = false, close = -1;
  let selfClosed:ElementSpan|undefined;
  let namespace='';
  const invalid = (): never => { throw new Error('ComicInfo XML is malformed or ambiguous; exact selective restoration is unavailable'); };
  while (position < xml.length) {
    const start = xml.indexOf('<', position);
    const text = xml.slice(position, start < 0 ? xml.length : start);
    if ((!stack.length && text.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) invalid();
    decodeText(text);
    if (start < 0) break;
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4); if (end < 0 || xml.slice(start+4,end).includes('--')) invalid(); position = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9); if (end < 0 || !stack.length) invalid(); position = end + 3; continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2); if (end < 0) invalid(); position = end + 2; continue;
    }
    const token = /^<(\/?)([A-Za-z_][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/.exec(xml.slice(start));
    if (!token) invalid();
    const end = start + token![0].length, name = token![2], closing = !!token![1];
    const selfClosing = /\/$/.test(token![3]);
    if (closing) {
      if (token![3].trim() || !stack.length || stack[stack.length-1].name !== name) invalid();
      const open = stack.pop()!;
      if (stack.length === 1) {
        if (fields.has(name)) invalid();
        fields.set(name, {start:open.start,end});
      }
      if (!stack.length) { close = start; finished = true; }
    } else {
      const attributes = selfClosing ? token![3].slice(0,-1) : token![3];
      const attributeNames=new Set<string>();
      let rest=attributes;
      while(rest.trim()) {
        const attribute=/^\s+([A-Za-z_][\w.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(rest);
        if(!attribute || attributeNames.has(attribute[1]))invalid();
        attributeNames.add(attribute![1]);decodeText(attribute![2].slice(1,-1));rest=rest.slice(attribute![0].length);
      }
      if (!stack.length) {
        if (root || finished || name !== 'ComicInfo') invalid();
        root = true;
        const defaultNamespace=/\sxmlns\s*=\s*(["'])(.*?)\1/.exec(attributes);
        namespace=defaultNamespace?decodeText(defaultNamespace[2]):'';
        if(selfClosing){finished=true;close=end-2;selfClosed={start,end};}
      }
      if (selfClosing && stack.length === 1) {
        if (fields.has(name)) invalid();
        fields.set(name, {start,end});
      } else if (!selfClosing) stack.push({name,start});
    }
    position = end;
  }
  if (!root || !finished || stack.length || close < 0) invalid();
  return {fields,close,selfClosed,namespace};
}

export function validateRestoreXml(xml: string | null): void { if (xml !== null) spans(xml); }

export function comicInfoFieldValue(xml: string | null,name:string): string | null {
  if (xml === null) return null;
  const field = spans(xml).fields.get(name);
  if (!field) return null;
  const element = xml.slice(field.start,field.end);
  if (/\/\s*>$/.test(element)) return '';
  const body = element.slice(element.indexOf('>')+1,element.lastIndexOf('</'));
  let position=0,value='';
  while(position<body.length) {
    if(body.startsWith('<![CDATA[',position)) {
      const end=body.indexOf(']]>',position+9);
      if(end<0)throw new Error('ComicInfo XML contains unclosed CDATA');
      value+=body.slice(position+9,end);position=end+3;
    } else {
      const next=body.indexOf('<',position),end=next<0?body.length:next;
      if(end===position)throw new Error(`ComicInfo.${name} contains unsupported nested or mixed markup; use complete XML replacement`);
      value+=decodeText(body.slice(position,end));position=end;
    }
  }
  return value;
}
export const comicInfoSeries = (xml:string|null) => comicInfoFieldValue(xml,'Series');

export function restoreComicInfoFields(current: string | null, historical: string | null, fields: readonly string[]): string | null {
  if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !RESTORABLE_COMICINFO_FIELDS.includes(field as ComicInfoRestoreField))) {
    throw new Error('Unsupported ComicInfo restore fields');
  }
  const source = historical === null ? null : spans(historical);
  // An absent historical field means removal, including when current XML is absent.
  if (current === null && fields.every(field => !source?.fields.has(field))) return null;
  let document = current ?? '<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo>\n</ComicInfo>\n';
  let live = spans(document);
  if(live.selfClosed) {
    if(fields.every(field=>!source?.fields.has(field)))return document;
    document=document.slice(0,live.close)+'></ComicInfo>'+document.slice(live.selfClosed.end);
    live=spans(document);
  }
  const replacements: {start:number;end:number;text:string}[] = [];
  const append: string[] = [];
  for (const field of fields) {
    comicInfoFieldValue(current,field);comicInfoFieldValue(historical,field);
    const saved = source?.fields.get(field), existing = live.fields.get(field);
    if(saved && source!.namespace!==live.namespace)throw new Error('ComicInfo default namespaces differ; use complete XML replacement');
    const text = saved ? historical!.slice(saved.start,saved.end) : '';
    if(/\s[\w.-]+:[\w.-]+\s*=/.test(text.slice(0,text.indexOf('>'))))throw new Error('Selected XML uses namespace-prefixed attributes; use complete XML replacement');
    if (existing) replacements.push({...existing,text});
    else if (text) append.push(text);
  }
  if (append.length) replacements.push({start:live.close,end:live.close,text:append.join('\n') + '\n'});
  return replacements.sort((a,b) => b.start-a.start).reduce((xml, edit) => xml.slice(0,edit.start)+edit.text+xml.slice(edit.end),document);
}

export function restoreComicInfoSeries(current: string | null, title: string): string {
  const escaped = title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return restoreComicInfoFields(current,`<ComicInfo><Series>${escaped}</Series></ComicInfo>`,['Series'])!;
}
