import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  embeddedBrowserHistoryEntryKey,
  embeddedBrowserHistoryNextCursor,
  removeEmbeddedBrowserHistoryEntries,
  searchEmbeddedBrowserHistory,
  type EmbeddedBrowserHistoryEntry,
} from './embedded-browser-history'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)

function entry(url: string, visitTimeMs: number, title: string | null = null) {
  return { id: `history-${visitTimeMs}`, url, title, visitTimeMs }
}

describe('embedded-browser-history', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('builds stable entry keys from url and visit time', () => {
    expect(embeddedBrowserHistoryEntryKey(entry('https://a.test', 1000))).toBe(
      'https://a.test 1000'
    )
  })

  test('returns no cursor when the last page was not full', () => {
    const entries = [entry('https://a.test', 2000), entry('https://b.test', 1000)]
    expect(embeddedBrowserHistoryNextCursor(entries, 2)).toBeNull()
  })

  test('computes the next cursor from all loaded entries', () => {
    const entries: EmbeddedBrowserHistoryEntry[] = [
      entry('https://a.test', 3000),
      entry('https://b.test', 2000),
      entry('https://c.test', 2000),
    ]
    const cursor = embeddedBrowserHistoryNextCursor(entries, 100)
    expect(cursor).toEqual({ endTimeMs: 2001, offset: 2 })
  })

  test('searches history with default pagination arguments', async () => {
    invokeMock.mockResolvedValue([])
    await searchEmbeddedBrowserHistory('docs')
    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_history_search', {
      text: 'docs',
      endTimeMs: null,
      offset: 0,
      maxResults: 100,
    })
  })

  test('searches history with a cursor', async () => {
    invokeMock.mockResolvedValue([])
    await searchEmbeddedBrowserHistory('', { endTimeMs: 5001, offset: 3 })
    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_history_search', {
      text: '',
      endTimeMs: 5001,
      offset: 3,
      maxResults: 100,
    })
  })

  test('removes history entries by selector', async () => {
    invokeMock.mockResolvedValue(2)
    const removed = await removeEmbeddedBrowserHistoryEntries([
      { url: 'https://a.test', visitTimeMs: 1000 },
      { url: 'https://b.test', visitTimeMs: 2000 },
    ])
    expect(removed).toBe(2)
    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_history_remove', {
      entries: [
        { url: 'https://a.test', visitTimeMs: 1000 },
        { url: 'https://b.test', visitTimeMs: 2000 },
      ],
    })
  })
})
