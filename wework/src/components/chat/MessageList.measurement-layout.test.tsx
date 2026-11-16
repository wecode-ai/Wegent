import type { WorkbenchMessage } from '@/types/workbench'
import { act, cleanup, render } from '@testing-library/react'
import {
  cacheConversationVirtualMeasurements,
  clearConversationViewportCache,
} from '@wegent/collaboration/conversation/conversationViewportCache'
import * as pretext from '@wegent/collaboration/conversation/messagePretextLayout'
import type { ConversationVirtualizer } from '@wegent/collaboration/conversation/useConversationVirtualizer'
import { afterEach, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

afterEach(() => {
  cleanup()
  clearConversationViewportCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture() {
  let width = 800
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  const observers = new Map<Element, Set<ResizeObserverCallback>>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        const callbacks = observers.get(element) ?? new Set()
        callbacks.add(this.callback)
        observers.set(element, callbacks)
      }
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  const viewport = document.createElement('div')
  Object.defineProperties(viewport, {
    clientWidth: { value: 800 },
    clientHeight: { value: 200 },
    offsetWidth: { value: 800 },
    offsetHeight: { value: 200 },
    scrollHeight: { value: 30000 },
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200)
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
  })
  const messages: WorkbenchMessage[] = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user',
    content: `message ${index}`,
    status: 'done',
    createdAt: '',
  }))
  cacheConversationVirtualMeasurements(
    'layout-cache',
    messages.map((message, index) => ({
      key: message.id,
      index,
      size: 987,
      start: 32 + index * 1003,
      end: 1019 + index * 1003,
      lane: 0,
    })),
    {
      key: JSON.stringify([800, null, pretext.readMessageLayoutTypography(viewport), 0]),
      messages: new Map(
        messages.map(message => [message.id, pretext.getMessageLayoutSignature(message)])
      ),
    }
  )
  const estimate = vi.spyOn(pretext, 'getMessagePretextIntrinsicHeight').mockReturnValue(220)
  const engine = { current: null as ConversationVirtualizer | null }
  const props = {
    virtualize: true,
    messages,
    conversationKey: 'layout-cache',
    scrollElementRef: { current: viewport },
    virtualizerRef: engine,
  }
  return {
    props,
    engine,
    estimate,
    narrow(column?: Element) {
      width = 400
      if (column)
        act(() => observers.get(column)?.forEach(callback => callback([], {} as ResizeObserver)))
    },
  }
}

test('exposes only existing numeric virtualizer state for on-demand failure diagnostics', () => {
  const current = fixture()
  current.props.scrollElementRef.current.dataset.testid = 'diagnostic-viewport'
  const view = render(<MessageList {...current.props} />)
  const list = view.container.querySelector<HTMLElement>('[data-conversation-message-list]')!
  const engine = current.engine.current!

  expect(list.dataset.conversationLayoutWidth).toBe('800')
  expect(list.dataset.conversationMessageCount).toBe('20')
  expect(list.dataset.conversationVisibleCount).toBe('20')
  expect(list.dataset.conversationVirtualMessages).toBe('true')
  expect(list.dataset.conversationViewportReady).toBe('true')
  expect(list.dataset.conversationVirtualizerEnabled).toBe('true')
  expect(list.dataset.conversationVirtualRowCount).toBe(String(engine.getVirtualItems().length))
  expect(JSON.parse(list.dataset.conversationVirtualRange!)).toEqual(engine.range)
  expect(JSON.parse(list.dataset.conversationScrollRect!)).toEqual(engine.scrollRect)
  expect(list.dataset.conversationScrollConnected).toBe('false')
  expect(list.dataset.conversationScrollElement).toBe('diagnostic-viewport')
})

test.each(['reopen', 'resize'] as const)(
  'rejects stale heights on column %s while the viewport width remains unchanged',
  action => {
    const current = fixture()
    if (action === 'reopen') current.narrow()
    const view = render(<MessageList {...current.props} />)
    if (action === 'resize') {
      expect(current.engine.current!.itemSizeCache.get('message-0')).toBe(987)
      current.narrow(view.container.querySelector('[data-message-row]')!.parentElement!)
    }
    expect(current.engine.current!.itemSizeCache.has('message-0')).toBe(false)
    expect(current.estimate).toHaveBeenCalled()
    expect(current.engine.current!.options.estimateSize(0)).toBe(220)
  }
)

test.each([600, 24])(
  'keeps retained rows in normal flow while measurements lag actual height %s',
  height => {
    const current = fixture()
    const heights = new Map<number, number>()
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return new DOMRect(
          0,
          0,
          800,
          this.hasAttribute('data-message-row')
            ? (heights.get(Number(this.dataset.index)) ?? 100)
            : 0
        )
      })
    const view = render(<MessageList {...current.props} />)
    const row = view.container.querySelector<HTMLElement>('[data-message-row]')!
    const index = Number(row.dataset.index)
    const message = current.props.messages[index]
    const before = current.engine.current!.getTotalSize()
    expect(current.engine.current!.itemSizeCache.get(message.id)).toBe(100)

    heights.set(index, height)
    const messages = current.props.messages.map((item, position) =>
      position === index ? { ...item, content: 'A longer updated message' } : item
    )
    view.rerender(<MessageList {...current.props} messages={messages} />)

    expect(view.container.querySelector(`[data-index="${index}"]`)).toBe(row)
    expect(current.engine.current!.itemSizeCache.get(message.id)).toBe(100)
    expect(current.engine.current!.getTotalSize()).toBe(before)
    expect(row.parentElement!.style.height).toBe('')
    expect(row.style.position).toBe('')
    expect(row.style.transform).toBe('')
    const reservedHeight = [...row.parentElement!.children].reduce((sum, child) => {
      const element = child as HTMLElement
      return (
        sum +
        (Number.parseFloat(element.style.marginTop) || 0) +
        (element.hasAttribute('data-message-row')
          ? (heights.get(Number(element.dataset.index)) ?? 100)
          : Number.parseFloat(element.style.height) || 0)
      )
    }, 0)
    expect(reservedHeight).toBe(before + height - 100)
    bounds.mockClear()
    view.rerender(<MessageList {...current.props} messages={[...messages]} />)
    expect(bounds.mock.calls).toHaveLength(0)
  }
)
