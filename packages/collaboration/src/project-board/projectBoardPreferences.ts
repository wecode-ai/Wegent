// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  readProjectBoardColumnSorts,
  type ProjectBoardColumnSorts,
  type ProjectBoardSort,
} from './projectBoardSorting'

import type { ProjectBoardGroupBy } from './useProjectBoardState'

const emptyColumnSorts: ProjectBoardColumnSorts = {}

export const boardSortStorageChanged = 'collaboration:board-sort-storage-changed'

function migrateBoardSortPreferences(storageKey: string): void {
  const previous = localStorage.getItem(storageKey)
  if (previous === null) return
  for (const [lane, value] of Object.entries(readProjectBoardColumnSorts(previous))) {
    const key = `${storageKey}:${lane}`
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value))
  }
  localStorage.removeItem(storageKey)
}

function readBoardSortPreferences(storageKey: string): ProjectBoardColumnSorts {
  const entries: Record<string, unknown> = {
    ...readProjectBoardColumnSorts(localStorage.getItem(storageKey)),
  }
  const prefix = `${storageKey}:`
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    const lane = key.slice(prefix.length)
    try {
      entries[lane] = JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      entries[lane] = null
    }
  }
  return readProjectBoardColumnSorts(JSON.stringify(entries))
}

/** Column preferences expose stable snapshots; legacy writes happen only after subscription. */
export function createBoardSortPreferences(storageKey: string | null) {
  let snapshot =
    storageKey && typeof window !== 'undefined'
      ? readBoardSortPreferences(storageKey)
      : emptyColumnSorts
  const listeners = new Set<() => void>()
  const publish = (next: ProjectBoardColumnSorts) => {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const refresh = () => {
    if (storageKey) {
      migrateBoardSortPreferences(storageKey)
      publish(readBoardSortPreferences(storageKey))
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (
      (!event.storageArea || event.storageArea === localStorage) &&
      (event.key === null || event.key === storageKey || event.key?.startsWith(`${storageKey}:`))
    )
      refresh()
  }
  const onLocalChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail === storageKey) refresh()
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => emptyColumnSorts,
    subscribe(listener: () => void) {
      if (storageKey && !listeners.size) refresh()
      listeners.add(listener)
      if (storageKey && listeners.size === 1) {
        window.addEventListener('storage', onStorage)
        window.addEventListener(boardSortStorageChanged, onLocalChange)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          window.removeEventListener('storage', onStorage)
          window.removeEventListener(boardSortStorageChanged, onLocalChange)
        }
      }
    },
    select(lane: string, value: ProjectBoardSort) {
      if (!storageKey) {
        publish({ ...snapshot, [lane]: value })
        return
      }
      localStorage.setItem(`${storageKey}:${lane}`, JSON.stringify(value))
      refresh()
      window.dispatchEvent(new CustomEvent(boardSortStorageChanged, { detail: storageKey }))
    },
  }
}

/** Focus is a per-board preference whose user actions own persistence. */
export function createBoardFocusPreference(storageKey: string | null) {
  let snapshot =
    storageKey && typeof window !== 'undefined'
      ? localStorage.getItem(storageKey) === 'true'
      : false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => false,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    toggle() {
      const next = !snapshot
      if (storageKey) {
        if (next) localStorage.setItem(storageKey, 'true')
        else localStorage.removeItem(storageKey)
      }
      snapshot = next
      listeners.forEach(listener => listener())
    },
  }
}

/** Grouping is a validated preference scoped to the selected view. */
export function createBoardGroupPreference(
  scope: string,
  storageKey: string | null,
  fallback: ProjectBoardGroupBy
) {
  const saved =
    storageKey && typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null
  let snapshot =
    saved === 'status' || saved === 'priority' || saved === 'assignee' || saved === 'tag'
      ? saved
      : fallback
  const listeners = new Set<() => void>()
  return {
    scope,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => fallback,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select(value: ProjectBoardGroupBy) {
      if (storageKey) localStorage.setItem(storageKey, value)
      snapshot = value
      listeners.forEach(listener => listener())
    },
  }
}
