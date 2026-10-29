import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

const MAX_STORED_EXPANSION_STATES = 2000;
const expansionStateByKey = new Map<string, boolean | string>();
const expansionStateListeners = new Set<() => void>();

type ExpansionUpdate = boolean | ((value: boolean) => boolean);
type SelectionUpdate =
  | string
  | null
  | ((value: string | null) => string | null);

export function getProcessingDetailStateKey(
  scopeKey: string,
  blockId: string,
): string {
  return `${scopeKey}:detail:${blockId}`;
}

export function usePersistentProcessingExpansion(
  key: string | readonly string[] | undefined,
  initialValue = false
): readonly [boolean, (update: ExpansionUpdate) => void] {
  const [localExpanded, setLocalExpanded] = useState(initialValue);
  const keys = useMemo(() => (typeof key === "string" ? (key ? [key] : []) : (key ?? [])), [key]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (keys.length === 0) return () => {};
      expansionStateListeners.add(listener);
      return () => expansionStateListeners.delete(listener);
    },
    [keys]
  );
  const getSnapshot = useCallback(
    () =>
      keys.length === 0 ? initialValue : keys.some(key => readExpansionState(key, initialValue)),
    [initialValue, keys]
  );
  const persistedExpanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const expanded = keys.length > 0 ? persistedExpanded : localExpanded;

  const setPersistentExpanded = useCallback(
    (update: ExpansionUpdate) => {
      if (keys.length === 0) {
        setLocalExpanded(current => (typeof update === "function" ? update(current) : update));
        return;
      }

      const current = keys.some(key => readExpansionState(key, initialValue));
      const next = typeof update === "function" ? update(current) : update;
      for (const key of keys) rememberExpansionState(key, next);
      emitExpansionStateChange();
    },
    [initialValue, keys]
  );

  return [expanded, setPersistentExpanded];
}

export function usePersistentProcessingSelection(
  key: string | undefined,
): readonly [string | null, (update: SelectionUpdate) => void] {
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      expansionStateListeners.add(listener);
      return () => expansionStateListeners.delete(listener);
    },
    [key],
  );
  const getSnapshot = useCallback(() => readSelectionState(key), [key]);
  const persistedSelection = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const selection = key ? persistedSelection : localSelection;

  const setPersistentSelection = useCallback(
    (update: SelectionUpdate) => {
      if (!key) {
        setLocalSelection((current) =>
          typeof update === "function" ? update(current) : update,
        );
        return;
      }

      const current = readSelectionState(key);
      const next = typeof update === "function" ? update(current) : update;
      rememberExpansionState(key, next ?? false);
      emitExpansionStateChange();
    },
    [key],
  );

  return [selection, setPersistentSelection];
}

export function useAnyPersistentProcessingExpansion(
  keys: readonly string[],
): boolean {
  const subscribe = useCallback((listener: () => void) => {
    expansionStateListeners.add(listener);
    return () => expansionStateListeners.delete(listener);
  }, []);
  const getSnapshot = useCallback(
    () => keys.some(hasStoredExpansionState),
    [keys],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function collapsePersistentProcessingExpansions(
  keys: readonly string[],
) {
  let changed = false;
  for (const key of keys) {
    if (!hasStoredExpansionState(key)) continue;
    expansionStateByKey.set(key, false);
    changed = true;
  }
  if (changed) emitExpansionStateChange();
}

export function clearPersistentProcessingExpansions() {
  if (expansionStateByKey.size === 0) return;
  expansionStateByKey.clear();
  emitExpansionStateChange();
}

function readExpansionState(
  key: string | undefined,
  initialValue: boolean,
): boolean {
  if (!key) return initialValue;
  const value = expansionStateByKey.get(key);
  return typeof value === "boolean" ? value : initialValue;
}

function readSelectionState(key: string | undefined): string | null {
  if (!key) return null;
  const value = expansionStateByKey.get(key);
  return typeof value === "string" ? value : null;
}

function hasStoredExpansionState(key: string): boolean {
  const value = expansionStateByKey.get(key);
  return typeof value === "string" ? value.length > 0 : Boolean(value);
}

function rememberExpansionState(key: string, value: boolean | string) {
  if (
    !expansionStateByKey.has(key) &&
    expansionStateByKey.size >= MAX_STORED_EXPANSION_STATES
  ) {
    const oldestKey = expansionStateByKey.keys().next().value;
    if (oldestKey) expansionStateByKey.delete(oldestKey);
  }
  expansionStateByKey.set(key, value);
}

function emitExpansionStateChange() {
  for (const listener of Array.from(expansionStateListeners)) {
    listener();
  }
}
