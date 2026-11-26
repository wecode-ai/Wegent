// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createMarkdownWindowingScope } from '../markdown/MarkdownWindowingScope'
import { createMessageListViewportPort } from './messageListViewportPort'
import {
  evictConversationViewport,
  getConversationVirtualMeasurements,
} from './conversationViewportCache'
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
  port.attach(list)
  port.update({
    scope,
    virtual: true,
    ready: true,
    layoutKey: 'layout',
    layoutWidth: 640,
    layoutPropertiesKey: 'properties',
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

it('treats the first rendered width as initialization when a restored pane docks', () => {
  const list = document.createElement('div')
  const port = createMessageListViewportPort()
  const options = { enabled: false }
  const measure = vi.fn()
  const virtualizer = { options, measure } as unknown as ConversationVirtualizer
  const measureRows = vi.fn()
  const onLayoutChange = vi.fn()
  const input = {
    scope: createMarkdownWindowingScope(undefined, vi.fn()),
    virtual: true,
    ready: true,
    layoutKey: 'wide',
    layoutWidth: 736,
    layoutPropertiesKey: 'properties',
    measurementKey: null,
    measurementLayout: { key: 'wide', messages: new Map() },
    virtualizer,
    rows: [],
    totalSize: 210,
    measureRow: vi.fn(),
    measureRows,
    onLayoutChange,
  }
  port.attach(list)
  port.update(input)

  // The same engine becomes enabled before React commits its first rows.
  options.enabled = true
  port.update({ ...input, totalSize: 1000 })
  onLayoutChange.mockClear()

  port.update({
    ...input,
    layoutKey: 'narrow',
    layoutWidth: 624,
    measurementLayout: { key: 'narrow', messages: new Map() },
    rows: [{ key: 'reply', index: 0, start: 0, end: 1000, size: 1000, lane: 0 }],
    totalSize: 1000,
  })
  // Initial scroll restoration must run in the layout commit instead of
  // waiting for a resize measurement batch for geometry that never existed.
  expect(onLayoutChange).toHaveBeenCalledExactlyOnceWith()
  expect(measureRows).not.toHaveBeenCalled()
  expect(measure).not.toHaveBeenCalled()
})

it('retains live geometry on resize but persists only heights measured for the committed layout', async () => {
  const conversationKey = 'viewport-width-change'
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  viewport.append(list)
  const rows = ['visible', 'offscreen', 'late', 'provisional'].map((id, index) => {
    const row = document.createElement('div')
    const article = document.createElement('article')
    row.dataset.messageRow = ''
    row.dataset.index = String(index)
    article.dataset.messageId = id
    row.append(article)
    list.append(row)
    return row
  })
  const messages = new Map([
    ['visible', 'visible-content'],
    ['offscreen', 'offscreen-content'],
    ['late', 'late-content'],
    ['provisional', 'provisional-content'],
  ])
  // This row has a real Markdown height at the old width, but retains it
  // while the narrower layout reflows the rest of the message.
  const placeholder = document.createElement('div')
  placeholder.dataset.markdownWindowPlaceholder = ''
  placeholder.dataset.markdownPlaceholderRowWidth = '640'
  rows[3].append(placeholder)
  const wide = { key: 'wide', messages }
  const narrow = { key: 'narrow', messages }
  let snapshot = [...messages.keys()].map((key, index) => ({
    key,
    index,
    start: index * 100,
    end: (index + 1) * 100,
    size: 100,
    lane: 0,
  }))
  const measure = vi.fn()
  const virtualizer = {
    options: { enabled: true },
    measure,
    takeSnapshot: () => snapshot,
  } as unknown as ConversationVirtualizer
  const port = createMessageListViewportPort()
  const scrollElementRef = { current: viewport }
  const scope = createMarkdownWindowingScope(scrollElementRef, element =>
    port.chunkLayout(scope, element)
  )
  const onLayoutChange = vi.fn()
  let complete: (() => void) | undefined
  const input = {
    scope,
    virtual: true,
    ready: true,
    layoutKey: wide.key,
    layoutWidth: 640,
    layoutPropertiesKey: 'properties',
    measurementKey: conversationKey,
    measurementLayout: wide,
    virtualizer,
    rows: snapshot,
    totalSize: 400,
    scrollElementRef,
    measureRow: vi.fn(),
    measureRows: (_rows: HTMLElement[], onComplete?: () => void) => {
      complete = onComplete
    },
    onLayoutChange,
  }
  const release = port.attach(list)
  try {
    rows.forEach(row => port.recordMeasurement(row, 640, 100, 640, wide))
    port.update(input)
    onLayoutChange.mockClear()
    rows[1].remove()

    const resized = {
      ...input,
      layoutKey: narrow.key,
      layoutWidth: 320,
      measurementLayout: narrow,
    }
    port.update(resized)
    expect(measure).not.toHaveBeenCalled()
    expect(getConversationVirtualMeasurements(conversationKey, wide)).toHaveLength(4)

    // The old element notification can arrive after the new layout commit.
    port.recordMeasurement(rows[2], 640, 100, 320, narrow)
    port.recordMeasurement(rows[0], 320, 150, 320, narrow)
    port.recordMeasurement(rows[3], 320, 100, 320, narrow)
    snapshot = [{ ...snapshot[0], size: 150, end: 150 }, ...snapshot.slice(1)]
    scope.onChunkLayout(rows[0].firstElementChild as HTMLElement)
    port.update({ ...resized, rows: snapshot, totalSize: 450 })
    expect(onLayoutChange).not.toHaveBeenCalled()

    complete?.()
    expect(onLayoutChange).toHaveBeenCalledExactlyOnceWith('resize')

    // Changing typography still invalidates the active geometry. The snapshot
    // from the narrower layout includes only its verified real measurement.
    port.update({
      ...resized,
      layoutKey: 'new-font',
      layoutPropertiesKey: 'new-font',
      measurementLayout: { key: 'new-font', messages },
    })
    expect(measure).toHaveBeenCalledOnce()
    expect(getConversationVirtualMeasurements(conversationKey, narrow)).toEqual([snapshot[0]])
  } finally {
    release()
    await Promise.resolve()
    evictConversationViewport(conversationKey)
  }
})

it('revalidates provisional Markdown rows on detach even when the measured size did not change', async () => {
  const conversationKey = 'viewport-placeholder-measurement'
  const list = document.createElement('div')
  const ids = ['became-provisional', 'became-real', 'valid-placeholder']
  const rows = ids.map((id, index) => {
    const row = document.createElement('div')
    const article = document.createElement('article')
    const placeholder = document.createElement('div')
    row.dataset.messageRow = ''
    row.dataset.index = String(index)
    article.dataset.messageId = id
    placeholder.dataset.markdownWindowPlaceholder = ''
    if (index !== 1) placeholder.dataset.markdownPlaceholderRowWidth = '320'
    article.append(placeholder)
    row.append(article)
    list.append(row)
    return { row, placeholder }
  })
  const layout = { key: 'narrow', messages: new Map(ids.map(id => [id, id])) }
  const snapshot = ids.map((key, index) => ({
    key,
    index,
    start: index * 100,
    end: (index + 1) * 100,
    size: 100,
    lane: 0,
  }))
  const port = createMessageListViewportPort()
  const release = port.attach(list)
  try {
    rows.forEach(({ row }) => port.recordMeasurement(row, 320, 100, 320, layout))
    port.update({
      scope: createMarkdownWindowingScope(undefined, vi.fn()),
      virtual: true,
      ready: true,
      layoutKey: layout.key,
      layoutWidth: 320,
      layoutPropertiesKey: 'properties',
      measurementKey: conversationKey,
      measurementLayout: layout,
      virtualizer: {
        options: { enabled: true },
        takeSnapshot: () => snapshot,
      } as unknown as ConversationVirtualizer,
      rows: snapshot,
      totalSize: 300,
      measureRow: vi.fn(),
      measureRows: vi.fn(),
    })

    // A new scope or estimate can invalidate a placeholder at the same size.
    delete rows[0].placeholder.dataset.markdownPlaceholderRowWidth
    port.recordMeasurement(rows[0].row, 320, 100, 320, layout)
    // Another chunk becomes rich Markdown without changing the outer size.
    rows[1].placeholder.remove()
    port.recordMeasurement(rows[1].row, 320, 100, 320, layout)
    // No size delta triggers another parent capture before switching tasks.
    release()
    await Promise.resolve()
    expect(getConversationVirtualMeasurements(conversationKey, layout)).toEqual(snapshot.slice(1))
  } finally {
    release()
    await Promise.resolve()
    evictConversationViewport(conversationKey)
  }
})
