// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  embeddedBrowserHistoryNextCursor,
  searchEmbeddedBrowserHistory,
  type EmbeddedBrowserHistoryEntry,
} from './embedded-browser-history'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
}))

function entry(url: string, visitTimeMs: number, title: string | null = null) {
  return { id: `history-${visitTimeMs}`, url, title, visitTimeMs }
}

describe('embedded-browser-history', () => {
  beforeEach(() => {
    desktopHostMocks.invoke.mockReset()
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
    desktopHostMocks.invoke.mockResolvedValue([])
    await searchEmbeddedBrowserHistory('docs')
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.historySearch', {
      text: 'docs',
      endTimeMs: null,
      offset: 0,
      maxResults: 100,
    })
  })
})
