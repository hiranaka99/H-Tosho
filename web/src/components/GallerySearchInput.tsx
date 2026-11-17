import * as React from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import { api, type DoujinSource, type DoujinSuggestion } from '../lib/api';
import { cn } from '../lib/utils';
import { Input, Spinner } from './ui';

/** Whitespace inside quoted filters belongs to the same search term. */
function activeTermBounds(full: string, caret: number) {
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < full.length; index++) {
    const char = full[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (!quoted && /\s/.test(char)) {
      if (index >= caret) return { start, end: index };
      start = index + 1;
    } else if (char === '"') quoted = !quoted;
  }
  return { start, end: full.length };
}

const TYPE_STYLES: Record<string, string> = {
  artist: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/20 dark:text-violet-300',
  group: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300',
  character: 'bg-pink-500/10 text-pink-700 dark:bg-pink-400/20 dark:text-pink-300',
  parody: 'bg-blue-500/10 text-blue-700 dark:bg-blue-400/20 dark:text-blue-300',
  series: 'bg-cyan-500/10 text-cyan-700 dark:bg-cyan-400/20 dark:text-cyan-300',
  language: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300',
  category: 'bg-rose-500/10 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300',
  tag: 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/20 dark:text-slate-300',
};

interface GallerySearchInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  source: DoujinSource | 'unified';
  label: string;
  placeholder: string;
  clearLabel: string;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}

/** Shared by gallery search and watched queries; Enter selects or submits the form. */
export function GallerySearchInput({ id, value, onChange, source, label, placeholder, clearLabel, disabled = false, className, describedBy }: GallerySearchInputProps) {
  const generatedId = React.useId();
  const listId = `${generatedId}-suggestions`;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  const [closed, setClosed] = React.useState(false);
  const [caret, setCaret] = React.useState(value.length);
  const [suggestions, setSuggestions] = React.useState<DoujinSuggestion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [highlight, setHighlight] = React.useState(-1);
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const updateCaret = () => setCaret(input.selectionStart ?? input.value.length);
    input.addEventListener('select', updateCaret);
    return () => input.removeEventListener('select', updateCaret);
  }, []);
  const position = Math.min(caret, value.length);
  const bounds = activeTermBounds(value, position);
  let seed = value.slice(bounds.start, position);
  if (seed.includes(':')) seed = seed.slice(seed.indexOf(':') + 1);
  seed = seed.replace(/^[\s"']+|[\s"']+$/g, '');
  const lookup = value.slice(bounds.start, position).replace(/^[-–—]/, '');
  const context = source === 'hitomi' && /^(?:sort|order)by(?:key|direction)?:/i.test(lookup) ? value : undefined;

  React.useEffect(() => {
    setSuggestions([]);
    setHighlight(-1);
    if (!focused || closed || disabled || (source === 'hitomi' ? !lookup : seed.length < 2 && !lookup.includes(':'))) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.doujinSuggestions(source, lookup, context, controller.signal);
        if (!cancelled) setSuggestions(Array.isArray(result) ? result : []);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [source, seed, lookup, context, focused, closed, disabled]);

  const showDropdown = focused && !closed && (loading || suggestions.length > 0);
  function selectSuggestion(suggestion: DoujinSuggestion) {
    const input = inputRef.current;
    const full = input?.value ?? value;
    const currentCaret = input?.selectionStart ?? full.length;
    const { start, end } = activeTermBounds(full, currentCaret);
    const fragment = suggestion.filter ?? suggestion.name;
    const filter = /^[-–—]/.test(full.slice(start, end)) && !fragment.startsWith('-') ? `-${fragment}` : fragment;
    const suffix = full.slice(end);
    const nextCaret = start + filter.length + (suffix ? 0 : 1);
    onChange(full.slice(0, start) + filter + suffix + (suffix ? '' : ' '));
    setClosed(true);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (showDropdown && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setHighlight(current => event.key === 'ArrowDown' ? Math.min(suggestions.length - 1, current + 1) : current <= 0 ? suggestions.length - 1 : current - 1);
    } else if (showDropdown && event.key === 'Enter' && highlight >= 0 && suggestions[highlight]) {
      event.preventDefault();
      selectSuggestion(suggestions[highlight]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setClosed(true);
      setHighlight(-1);
    }
  }

  return <div className="relative min-w-0 flex-1">
    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    <Input
      ref={inputRef} id={id ?? generatedId} role="combobox" aria-label={label}
      aria-describedby={describedBy}
      aria-autocomplete="list" aria-expanded={showDropdown} aria-controls={listId}
      aria-activedescendant={showDropdown && highlight >= 0 ? `${listId}-${highlight}` : undefined}
      autoComplete="off" spellCheck={false} disabled={disabled} value={value} placeholder={placeholder}
      onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); setClosed(false); }}
      onSelect={event => setCaret(event.currentTarget.selectionStart ?? value.length)}
      onClick={event => setCaret(event.currentTarget.selectionStart ?? value.length)}
      onKeyUp={event => setCaret(event.currentTarget.selectionStart ?? value.length)}
      onKeyDown={onKeyDown} onFocus={() => { setFocused(true); setClosed(false); }}
      onBlur={() => { setFocused(false); setHighlight(-1); }}
      className={cn('shrink-0 pl-9 pr-11', className)}
    />
    {value && <button type="button" disabled={disabled} aria-label={clearLabel}
      onClick={() => { onChange(''); setCaret(0); setClosed(false); inputRef.current?.focus(); }}
      className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded text-muted hover:text-foreground disabled:opacity-50">
      <X className="h-4 w-4" />
    </button>}
    {showDropdown && <div id={listId} role="listbox" aria-label={`${label} suggestions`} className="absolute left-0 right-0 top-full z-50 mt-1 origin-top animate-scale-in overflow-hidden rounded-md border border-border bg-surface shadow-lg">
      {loading && !suggestions.length ? <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-muted"><Spinner />Searching tags…</div> :
        <div className="max-h-80 overflow-y-auto py-1">
          {suggestions.map((suggestion, index) => <button
            key={`${suggestion.type}-${suggestion.name}`} type="button" tabIndex={-1} id={`${listId}-${index}`} role="option"
            aria-selected={index === highlight} onMouseDown={event => event.preventDefault()}
            onClick={() => selectSuggestion(suggestion)} onPointerMove={event => { if (event.pointerType === 'mouse') setHighlight(index); }}
            className={cn('flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm', index === highlight ? 'bg-surface-2' : 'hover:bg-surface-2')}>
            <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide', TYPE_STYLES[suggestion.type] ?? TYPE_STYLES.tag)}>{suggestion.type}</span>
            <span className="min-w-0 truncate">{suggestion.name}</span>
            {typeof suggestion.count === 'number' && <span className="text-xs text-muted">{suggestion.count}</span>}
            <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" />
          </button>)}
        </div>}
    </div>}
  </div>;
}
