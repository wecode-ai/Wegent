import { invoke } from '@tauri-apps/api/core'

export const EMBEDDED_BROWSER_HISTORY_PAGE_SIZE = 100

export interface EmbeddedBrowserHistoryEntry {
  id: string
  url: string
  title: string | null
  visitTimeMs: number
}

export interface EmbeddedBrowserHistorySelector {
  url: string
  visitTimeMs: number
}

// Cursor for history pagination: entries strictly older than endTimeMs are
// returned, and offset skips previously returned entries that fall inside the
// cursor window.
export interface EmbeddedBrowserHistoryCursor {
  endTimeMs: number
  offset: number
}

export function embeddedBrowserHistoryEntryKey(
  entry: EmbeddedBrowserHistoryEntry | EmbeddedBrowserHistorySelector
): string {
  return `${entry.url} ${entry.visitTimeMs}`
}

export function embeddedBrowserHistoryNextCursor(
  allEntries: EmbeddedBrowserHistoryEntry[],
  lastPageSize: number
): EmbeddedBrowserHistoryCursor | null {
  if (allEntries.length === 0 || lastPageSize < EMBEDDED_BROWSER_HISTORY_PAGE_SIZE) return null
  const last = allEntries[allEntries.length - 1]
  const endTimeMs = last.visitTimeMs + 1
  const offset = allEntries.filter(entry => entry.visitTimeMs < endTimeMs).length
  return { endTimeMs, offset }
}

export async function searchEmbeddedBrowserHistory(
  text: string,
  cursor?: EmbeddedBrowserHistoryCursor
): Promise<EmbeddedBrowserHistoryEntry[]> {
  return invoke<EmbeddedBrowserHistoryEntry[]>('embedded_browser_history_search', {
    text,
    endTimeMs: cursor?.endTimeMs ?? null,
    offset: cursor?.offset ?? 0,
    maxResults: EMBEDDED_BROWSER_HISTORY_PAGE_SIZE,
  })
}

export async function removeEmbeddedBrowserHistoryEntries(
  entries: EmbeddedBrowserHistorySelector[]
): Promise<number> {
  return invoke<number>('embedded_browser_history_remove', { entries })
}
