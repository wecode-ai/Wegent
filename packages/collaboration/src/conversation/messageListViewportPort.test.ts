// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createMarkdownWindowingScope } from '../markdown/MarkdownWindowingScope'
import { createMessageListViewportPort } from './messageListViewportPort'
import type { ConversationVirtualizer } from './useConversationVirtualizer'

it('restores the bottom as soon as Markdown restores the native range', () => {
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  const row = document.createElement('div')
  const chunk = document.createElement('div')
  const clientHeight = 643
  let scrollHeight = 15_965
  Object.defineProperties(viewport, {
    clientHeight: { value: clientHeight },
    scrollHeight: { get: () => scrollHeight },
  })
  row.dataset.messageRow = ''
  row.dataset.index = '7'
  row.append(chunk)
  list.append(row)
  viewport.append(list)
  viewport.scrollTop = scrollHeight - clientHeight

  const port = createMessageListViewportPort()
  const scrollElementRef = { current: viewport }
  const scope = createMarkdownWindowingScope(scrollElementRef, element =>
    port.chunkLayout(scope, element)
  )
  const virtualizer = { options: { enabled: true } } as ConversationVirtualizer
  port.bind(list, {
    scope,
    virtual: true,
    ready: true,
    layoutKey: 'layout',
    measurementKey: null,
    measurementLayout: { key: 'layout', messages: new Map() },
    virtualizer,
    rows: [],
    totalSize: 20_936,
    scrollElementRef,
    measureRow: vi.fn(),
    measureRows: vi.fn(),
    onLayoutChange: () => {
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
    },
  })

  // The chunk's DOM has caught up with the cached virtual size. The row size
  // cache has no delta to publish, and native resize delivery is still pending.
  scrollHeight = 20_936
  scope.onChunkLayout(chunk)
  expect(viewport.scrollTop).toBe(20_293)

  viewport.scrollTop = 19_000
  scope.onChunkLayout(chunk)
  expect(viewport.scrollTop).toBe(19_000)
})
