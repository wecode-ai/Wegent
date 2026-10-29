import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  cacheConversationVirtualMeasurements,
  clearConversationViewportCache,
} from '@wegent/collaboration/conversation/conversationViewportCache'
import type { ConversationVirtualizer } from '@wegent/collaboration/conversation/useConversationVirtualizer'
import * as pretext from '@wegent/collaboration/conversation/messagePretextLayout'

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

test('hydrates the real virtualizer only after validating the message column', () => {
  const current = fixture()
  const view = render(<MessageList {...current.props} />)
  expect(current.engine.current!.itemSizeCache.get('message-0')).toBe(987)
  expect(current.estimate).not.toHaveBeenCalled()
  view.unmount()
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

test('measures and renders when the first messages arrive after an empty mount', () => {
  const current = fixture()
  const view = render(<MessageList {...current.props} messages={[]} />)
  expect(view.container).toBeEmptyDOMElement()
  view.rerender(<MessageList {...current.props} />)
  expect(current.engine.current).not.toBeNull()
  expect(screen.getAllByTestId('message-user').length).toBeGreaterThan(0)
})
