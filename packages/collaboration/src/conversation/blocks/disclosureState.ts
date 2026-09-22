import { useCallback, useState, useSyncExternalStore } from "react";

const MAX_STORED_DISCLOSURES = 2000;

type DisclosureValue = boolean | string | null;

const disclosureByKey = new Map<string, DisclosureValue>();
const disclosureListeners = new Set<() => void>();

type ExpansionUpdate = boolean | ((value: boolean) => boolean);
type SelectionUpdate =
  | string
  | null
  | ((value: string | null) => string | null);

/**
 * Reader-owned disclosure state for what a message's process section shows.
 *
 * It lives outside React because the conversation is virtualized: a message that leaves
 * the rendered range unmounts, and component state would forget what the reader just
 * opened as soon as they scroll. Every entry is therefore stored against the identity of
 * the thing the reader opened — never against its position in the render tree, which is
 * derived from the answer while it streams. Callers pass an identity key built from
 * `disclosureKeys`; a missing key keeps the state local to the component.
 */
function subscribeToDisclosures(listener: () => void) {
  disclosureListeners.add(listener);
  return () => {
    disclosureListeners.delete(listener);
  };
}

function emitDisclosureChange() {
  for (const listener of Array.from(disclosureListeners)) listener();
}

function readDisclosure(key: string | undefined): DisclosureValue {
  return key ? (disclosureByKey.get(key) ?? null) : null;
}

function rememberDisclosure(key: string, value: DisclosureValue) {
  // Re-insert an existing key so the eviction order stays "least recently written"
  // instead of "first ever written"; otherwise a key still in use can be evicted as if
  // it were the oldest.
  disclosureByKey.delete(key);
  disclosureByKey.set(key, value);
  while (disclosureByKey.size > MAX_STORED_DISCLOSURES) {
    const oldestKey = disclosureByKey.keys().next().value;
    if (oldestKey === undefined) break;
    disclosureByKey.delete(oldestKey);
  }
  emitDisclosureChange();
}

function isOpenDisclosure(value: DisclosureValue): boolean {
  return value === true || (typeof value === "string" && value.length > 0);
}

export function usePersistentDisclosure(
  key: string | undefined,
  initialValue = false,
): readonly [boolean, (update: ExpansionUpdate) => void] {
  const [localExpanded, setLocalExpanded] = useState(initialValue);
  const getSnapshot = useCallback(() => {
    const stored = readDisclosure(key);
    return typeof stored === "boolean" ? stored : initialValue;
  }, [initialValue, key]);
  const persistedExpanded = useSyncExternalStore(
    subscribeToDisclosures,
    getSnapshot,
    getSnapshot,
  );
  const expanded = key ? persistedExpanded : localExpanded;

  const setPersistentExpanded = useCallback(
    (update: ExpansionUpdate) => {
      if (!key) {
        setLocalExpanded((current) =>
          typeof update === "function" ? update(current) : update,
        );
        return;
      }

      const stored = readDisclosure(key);
      const current = typeof stored === "boolean" ? stored : initialValue;
      const next = typeof update === "function" ? update(current) : update;
      rememberDisclosure(key, next);
    },
    [initialValue, key],
  );

  return [expanded, setPersistentExpanded];
}

/**
 * One-value disclosure, used where the reader picks a single item at a time (which
 * modified file shows its diff). `null` means nothing is open.
 */
export function usePersistentDisclosureSelection(
  key: string | undefined,
): readonly [string | null, (update: SelectionUpdate) => void] {
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const getSnapshot = useCallback(() => {
    const stored = readDisclosure(key);
    return typeof stored === "string" ? stored : null;
  }, [key]);
  const persistedSelection = useSyncExternalStore(
    subscribeToDisclosures,
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

      const stored = readDisclosure(key);
      const current = typeof stored === "string" ? stored : null;
      const next = typeof update === "function" ? update(current) : update;
      rememberDisclosure(key, next);
    },
    [key],
  );

  return [selection, setPersistentSelection];
}

/**
 * Whether any of the given disclosures is open, so a container can size itself from the
 * same state its rows are stored in instead of keeping a second copy in sync.
 */
export function useAnyDisclosureOpen(
  keys: readonly (string | undefined)[],
): boolean {
  const getSnapshot = useCallback(
    () => keys.some((key) => isOpenDisclosure(readDisclosure(key))),
    [keys],
  );
  return useSyncExternalStore(subscribeToDisclosures, getSnapshot, getSnapshot);
}
