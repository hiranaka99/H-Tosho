import * as React from 'react';

type DraftStatus = 'clean' | 'dirty' | 'pending' | 'saved' | 'error';
interface DraftEntry {
  label: string;
  value: unknown;
  baseline: unknown;
  valueJson: string;
  baselineJson: string;
  isDirty: boolean;
  revision: number;
  initialized: boolean;
  pending: boolean;
  saved: boolean;
  error: string;
  valid: boolean;
  save?: () => Promise<void>;
}
interface DraftStore {
  entries: Map<string, DraftEntry>;
  subscribeEntry: (id: string, listener: () => void) => () => void;
  entryRevision: (id: string) => number;
  subscribeNav: (listener: () => void) => () => void;
  navRevision: () => number;
  notifyEntry: (id: string) => void;
  notifyAll: () => void;
}
const DraftContext = React.createContext<DraftStore | null>(null);
const serialize = (value: unknown) => JSON.stringify(value) ?? '';

function updateDirty(entry: DraftEntry, updateBaseline = false): void {
  entry.valueJson = serialize(entry.value);
  if (updateBaseline) entry.baselineJson = serialize(entry.baseline);
  entry.isDirty = entry.valueJson !== entry.baselineJson;
}

function navSignature(entries: Map<string, DraftEntry>): string {
  let out = '';
  for (const [id, entry] of entries) {
    if (entry.isDirty || entry.pending) {
      out += `${id}:${entry.isDirty ? 1 : 0}:${entry.pending ? 1 : 0}:${entry.valid ? 1 : 0}:${entry.save ? 1 : 0};`;
    }
  }
  return out;
}

export function SettingsDraftsProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState<DraftStore>(() => {
    const entries = new Map<string, DraftEntry>();
    const entryListeners = new Map<string, Set<() => void>>();
    const navListeners = new Set<() => void>();
    let navRev = 0;
    let lastNavSig = '';
    const maybeNotifyNav = () => {
      const nextSig = navSignature(entries);
      if (nextSig !== lastNavSig) {
        lastNavSig = nextSig;
        navRev++;
        navListeners.forEach((listener) => listener());
      }
    };
    return {
      entries,
      subscribeEntry: (id, listener) => {
        let set = entryListeners.get(id);
        if (!set) { set = new Set(); entryListeners.set(id, set); }
        set.add(listener);
        return () => {
          set!.delete(listener);
          if (set!.size === 0) entryListeners.delete(id);
        };
      },
      entryRevision: (id) => entries.get(id)?.revision ?? 0,
      subscribeNav: (listener) => {
        navListeners.add(listener);
        return () => { navListeners.delete(listener); };
      },
      navRevision: () => navRev,
      notifyEntry: (id) => {
        const entry = entries.get(id);
        if (entry) entry.revision++;
        entryListeners.get(id)?.forEach((listener) => listener());
        maybeNotifyNav();
      },
      notifyAll: () => {
        for (const [id, entry] of entries) {
          entry.revision++;
          entryListeners.get(id)?.forEach((listener) => listener());
        }
        maybeNotifyNav();
      },
    };
  });
  // This provider lives inside AuthProvider, so logout destroys all in-memory
  // drafts, including passwords and keys. Nothing is written to browser storage.
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

function useDraftStore() {
  const store = React.useContext(DraftContext);
  if (!store) throw new Error('Settings drafts require SettingsDraftsProvider');
  return store;
}

export function useSettingsDraft<T>({ id, label, initial, source, valid = () => true, save }: {
  id: string;
  label: string;
  initial: T;
  source?: T;
  valid?: (value: T) => boolean;
  save: (value: T) => Promise<T | void>;
}) {
  const store = useDraftStore();
  if (!store.entries.has(id)) {
    const initialValue = source ?? initial;
    const json = serialize(initialValue);
    store.entries.set(id, {
      label, value: initialValue, baseline: initialValue, valueJson: json, baselineJson: json,
      isDirty: false, revision: 0, initialized: source !== undefined, pending: false, saved: false, error: '', valid: true,
    });
  }
  const subscribe = React.useCallback((listener: () => void) => store.subscribeEntry(id, listener), [store, id]);
  const getSnapshot = React.useCallback(() => store.entryRevision(id), [store, id]);
  React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const entry = store.entries.get(id)!;
  const callbacks = React.useRef({ save, valid });
  callbacks.current = { save, valid };
  const isValid = valid(entry.value as T);
  React.useLayoutEffect(() => {
    if (entry.valid !== isValid) { entry.valid = isValid; store.notifyEntry(id); }
  }, [entry, id, isValid, store]);
  React.useEffect(() => {
    if (source === undefined || entry.pending || (entry.initialized && entry.isDirty)) return;
    const sourceJson = serialize(source);
    if (!entry.initialized || sourceJson !== entry.baselineJson) {
      entry.value = source;
      entry.baseline = source;
      entry.valueJson = sourceJson;
      entry.baselineJson = sourceJson;
      entry.isDirty = false;
      entry.initialized = true;
      store.notifyEntry(id);
    }
  }, [source, entry, id, store]);
  const setValue = React.useCallback((next: React.SetStateAction<T>) => {
    entry.value = typeof next === 'function' ? (next as (previous: T) => T)(entry.value as T) : next;
    entry.saved = false;
    entry.error = '';
    entry.valid = callbacks.current.valid(entry.value as T);
    updateDirty(entry);
    store.notifyEntry(id);
  }, [entry, id, store]);
  const saveDraft = React.useCallback(async () => {
    if (!entry.isDirty) return;
    if (entry.pending || !callbacks.current.valid(entry.value as T)) throw new Error(`${entry.label} has invalid or pending changes.`);
    const submitted = entry.value as T;
    const submittedJson = serialize(submitted);
    entry.pending = true;
    entry.error = '';
    store.notifyEntry(id);
    try {
      const result = await callbacks.current.save(submitted);
      const persisted = result === undefined ? submitted : result;
      if (entry.valueJson === submittedJson) entry.value = persisted;
      entry.baseline = persisted;
      updateDirty(entry, true);
      entry.initialized = true;
      entry.saved = true;
    } catch (cause) {
      entry.error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      entry.pending = false;
      store.notifyEntry(id);
    }
  }, [entry, id, store]);
  React.useLayoutEffect(() => {
    entry.save = saveDraft;
    store.notifyEntry(id);
    return () => { entry.save = undefined; };
  }, [entry, id, saveDraft, store]);
  const status: DraftStatus = entry.pending ? 'pending' : entry.error ? 'error' : entry.isDirty ? 'dirty' : entry.saved ? 'saved' : 'clean';
  return {
    value: entry.value as T, setValue, save: saveDraft,
    submit: () => { void saveDraft().catch(() => { /* The section displays the rejection. */ }); },
    discard: () => { entry.value = entry.baseline; entry.valueJson = entry.baselineJson; entry.isDirty = false; entry.error = ''; entry.saved = false; store.notifyEntry(id); },
    dirty: entry.isDirty, pending: entry.pending, valid: isValid, status, error: entry.error,
    canSave: entry.isDirty && isValid && !entry.pending,
  };
}

/** A section's own save state; the page-level save bar owns the Save action. */
export function DraftFeedback({ draft, hideSaved = false, hideError = false }: { draft: { status: DraftStatus; error: string; valid: boolean }; hideSaved?: boolean; hideError?: boolean }) {
  if (draft.status === 'clean' || (hideSaved && draft.status === 'saved') || (hideError && draft.status === 'error')) return null;
  const text = draft.status === 'pending' ? 'Saving…' : draft.status === 'error' ? draft.error : draft.status === 'dirty' ? (draft.valid ? 'Unsaved' : 'Fix highlighted fields') : 'Saved';
  return <p role={draft.status === 'error' ? 'alert' : 'status'} className={`text-xs break-words ${draft.status === 'error' || (draft.status === 'dirty' && !draft.valid) ? 'text-danger' : draft.status === 'saved' ? 'text-success' : 'text-muted'}`}>{text}</p>;
}

export function useSettingsNavigation() {
  const store = useDraftStore();
  React.useSyncExternalStore(store.subscribeNav, store.navRevision, store.navRevision);
  const entries = [...store.entries.values()];
  const changed = entries.filter((entry) => entry.isDirty);
  return {
    dirty: changed.length > 0,
    pending: entries.some((entry) => entry.pending),
    labels: changed.map((entry) => entry.label),
    dirtyIds: [...store.entries].filter(([, entry]) => entry.isDirty).map(([id]) => id),
    /** Changed sections that cannot be saved until a field is fixed. */
    invalid: [...store.entries].filter(([, entry]) => entry.isDirty && !entry.valid).map(([id, entry]) => ({ id, label: entry.label })),
    canSave: changed.length > 0 && changed.every((entry) => entry.valid && !entry.pending && entry.save),
    saveAll: async () => {
      // Sequential saves avoid races between sections sharing settings queries.
      for (const entry of store.entries.values()) if (entry.isDirty) {
        if (!entry.valid || entry.pending || !entry.save) throw new Error(`${entry.label} cannot be saved yet.`);
        try { await entry.save(); }
        catch (cause) { throw new Error(`${entry.label} was not saved. ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
    },
    discardAll: () => {
      for (const entry of store.entries.values()) {
        entry.value = entry.baseline;
        entry.valueJson = entry.baselineJson;
        entry.isDirty = false;
        entry.error = '';
        entry.saved = false;
      }
      store.notifyAll();
    },
  };
}
