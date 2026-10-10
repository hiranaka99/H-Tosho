import * as React from 'react';

type DraftStatus = 'clean' | 'dirty' | 'pending' | 'saved' | 'error';
interface DraftEntry {
  label: string;
  value: unknown;
  baseline: unknown;
  initialized: boolean;
  pending: boolean;
  saved: boolean;
  error: string;
  valid: boolean;
  save?: () => Promise<void>;
}
interface DraftStore {
  entries: Map<string, DraftEntry>;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => number;
  notify: () => void;
}
const DraftContext = React.createContext<DraftStore | null>(null);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dirty = (entry: DraftEntry) => !equal(entry.value, entry.baseline);

export function SettingsDraftsProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState<DraftStore>(() => {
    let revision = 0;
    const listeners = new Set<() => void>();
    return {
      entries: new Map(),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      snapshot: () => revision,
      notify: () => { revision++; listeners.forEach((listener) => listener()); },
    };
  });
  // This provider lives inside AuthProvider, so logout destroys all in-memory
  // drafts, including passwords and keys. Nothing is written to browser storage.
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

function useStore() {
  const store = React.useContext(DraftContext);
  if (!store) throw new Error('Settings drafts require SettingsDraftsProvider');
  React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
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
  const store = useStore();
  if (!store.entries.has(id)) store.entries.set(id, {
    label, value: source ?? initial, baseline: source ?? initial,
    initialized: source !== undefined, pending: false, saved: false, error: '', valid: true,
  });
  const entry = store.entries.get(id)!;
  const callbacks = React.useRef({ save, valid });
  callbacks.current = { save, valid };
  const isValid = valid(entry.value as T);
  React.useLayoutEffect(() => {
    if (entry.valid !== isValid) { entry.valid = isValid; store.notify(); }
  }, [entry, isValid, store]);
  React.useEffect(() => {
    if (source === undefined || entry.pending || (entry.initialized && dirty(entry))) return;
    if (!entry.initialized || !equal(source, entry.baseline)) {
      entry.value = source;
      entry.baseline = source;
      entry.initialized = true;
      store.notify();
    }
  }, [source, entry, store]);
  const setValue = React.useCallback((next: React.SetStateAction<T>) => {
    entry.value = typeof next === 'function' ? (next as (previous: T) => T)(entry.value as T) : next;
    entry.saved = false;
    entry.error = '';
    entry.valid = callbacks.current.valid(entry.value as T);
    store.notify();
  }, [entry, store]);
  const saveDraft = React.useCallback(async () => {
    if (!dirty(entry)) return;
    if (entry.pending || !callbacks.current.valid(entry.value as T)) throw new Error(`${entry.label} has invalid or pending changes.`);
    const submitted = entry.value as T;
    entry.pending = true;
    entry.error = '';
    store.notify();
    try {
      const result = await callbacks.current.save(submitted);
      const persisted = result === undefined ? submitted : result;
      if (equal(entry.value, submitted)) entry.value = persisted;
      entry.baseline = persisted;
      entry.initialized = true;
      entry.saved = true;
    } catch (cause) {
      entry.error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      entry.pending = false;
      store.notify();
    }
  }, [entry, store]);
  React.useLayoutEffect(() => {
    entry.save = saveDraft;
    return () => { entry.save = undefined; };
  }, [entry, saveDraft]);
  const status: DraftStatus = entry.pending ? 'pending' : entry.error ? 'error' : dirty(entry) ? 'dirty' : entry.saved ? 'saved' : 'clean';
  return {
    value: entry.value as T, setValue, save: saveDraft,
    submit: () => { void saveDraft().catch(() => { /* The section displays the rejection. */ }); },
    dirty: dirty(entry), pending: entry.pending, valid: isValid, status, error: entry.error,
    canSave: dirty(entry) && isValid && !entry.pending,
  };
}

export function DraftFeedback({ draft }: { draft: { status: DraftStatus; error: string; valid: boolean } }) {
  if (draft.status === 'clean') return null;
  const text = draft.status === 'pending' ? 'Saving…' : draft.status === 'error' ? draft.error : draft.status === 'dirty' ? (draft.valid ? 'Unsaved changes' : 'Unsaved changes — fix the highlighted fields') : 'Saved';
  return <p role={draft.status === 'error' ? 'alert' : 'status'} className={`text-xs break-words ${draft.status === 'error' || !draft.valid ? 'text-danger' : draft.status === 'saved' ? 'text-success' : 'text-muted'}`}>{text}</p>;
}

export function useSettingsNavigation() {
  const store = useStore();
  const entries = [...store.entries.values()];
  const changed = entries.filter(dirty);
  return {
    dirty: changed.length > 0,
    pending: entries.some((entry) => entry.pending),
    labels: changed.map((entry) => entry.label),
    dirtyIds: [...store.entries].filter(([, entry]) => dirty(entry)).map(([id]) => id),
    canSave: changed.length > 0 && changed.every((entry) => entry.valid && !entry.pending && entry.save),
    saveAll: async () => {
      // Sequential saves avoid races between sections sharing settings queries.
      for (const entry of store.entries.values()) if (dirty(entry)) {
        if (!entry.valid || entry.pending || !entry.save) throw new Error(`${entry.label} cannot be saved yet.`);
        await entry.save();
      }
    },
    discardAll: () => {
      for (const entry of store.entries.values()) {
        entry.value = entry.baseline;
        entry.error = '';
        entry.saved = false;
      }
      store.notify();
    },
  };
}
