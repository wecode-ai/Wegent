import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export const EMBEDDED_BROWSER_HISTORY_PAGE_SIZE = 100

export interface EmbeddedBrowserHistoryEntry {
  id: string
  url: string
  title: string | null
  visitTimeMs: number
}

// Cursor for history pagination: entries strictly older than endTimeMs are
// returned, and offset skips previously returned entries that fall inside the
// cursor window.
export interface EmbeddedBrowserHistoryCursor {
  endTimeMs: number
  offset: number
}

export function embeddedBrowserHistoryEntryKey(entry: EmbeddedBrowserHistoryEntry): string {
  return entry.id
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
  return invokeDesktopHost<EmbeddedBrowserHistoryEntry[]>('browser.historySearch', {
    text,
    endTimeMs: cursor?.endTimeMs ?? null,
    offset: cursor?.offset ?? 0,
    maxResults: EMBEDDED_BROWSER_HISTORY_PAGE_SIZE,
  })
}

export async function removeEmbeddedBrowserHistoryEntries(ids: string[]): Promise<number> {
  return invokeDesktopHost<number>('browser.historyRemove', { ids })
}
