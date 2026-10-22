// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  readProjectBoardColumnSorts,
  type ProjectBoardColumnSorts,
  type ProjectBoardSort,
} from './projectBoardSorting'

export const boardSortStorageChanged = 'collaboration:board-sort-storage-changed'

export function loadBoardSortPreferences(storageKey: string): ProjectBoardColumnSorts {
  const previous = localStorage.getItem(storageKey)
  if (previous !== null) {
    // Move the previous project-wide document into independent lane entries once.
    for (const [lane, value] of Object.entries(readProjectBoardColumnSorts(previous))) {
      const key = `${storageKey}:${lane}`
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value))
    }
    localStorage.removeItem(storageKey)
  }
  const entries: Record<string, unknown> = {}
  const prefix = `${storageKey}:`
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    try {
      entries[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      // Invalid preferences are ignored by the same validator as migrated values.
    }
  }
  return readProjectBoardColumnSorts(JSON.stringify(entries))
}

export function saveBoardSortPreference(
  storageKey: string,
  lane: string,
  value: ProjectBoardSort
): void {
  localStorage.setItem(`${storageKey}:${lane}`, JSON.stringify(value))
  window.dispatchEvent(new CustomEvent(boardSortStorageChanged, { detail: storageKey }))
}
