import type { EmbeddedBrowserHistoryEntry } from '@/lib/embedded-browser-history'

export function historyEntry(
  id: string,
  url: string,
  visitTimeMs: number,
  title: string | null = null
): EmbeddedBrowserHistoryEntry {
  return { id, url, title, visitTimeMs }
}
export function historyEntries(
  count = 100,
  prefix = 'history',
  visitTimeMs = new Date(2026, 0, 15, 12).getTime()
): EmbeddedBrowserHistoryEntry[] {
  return Array.from({ length: count }, (_, i) =>
    historyEntry(
      `${prefix}-${i}`,
      `https://example.test/${prefix}/${i}`,
      visitTimeMs - i,
      `${prefix} ${i}`
    )
  )
}
