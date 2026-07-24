import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import {
  clearRuntimeConversationCacheForTests,
  getConversationVirtualHeights,
} from '@/features/workbench/runtimeConversationCache'
import '@/i18n'

interface ResizeObserverRecord {
  callback: ResizeObserverCallback
  targets: Set<Element>
}

const resizeObserverRecords: ResizeObserverRecord[] = []

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

describe('MessageList Tauri virtualization', () => {
  beforeEach(() => {
    resizeObserverRecords.length = 0
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        private readonly record: ResizeObserverRecord

        constructor(callback: ResizeObserverCallback) {
          this.record = { callback, targets: new Set() }
          resizeObserverRecords.push(this.record)
        }

        observe(target: Element) {
          this.record.targets.add(target)
        }

        unobserve(target: Element) {
          this.record.targets.delete(target)
        }

        disconnect() {
          this.record.targets.clear()
        }
      }
    )
  })

  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    vi.unstubAllGlobals()
  })

  test('uses the unified virtual layout and renders every short-conversation message', () => {
    const scrollElement = createScrollElement(1_000)
    const intersectionObserver = vi.fn()
    vi.stubGlobal('IntersectionObserver', intersectionObserver)

    render(
      <MessageList
        messages={buildMessages(5, 'short')}
        scrollElementRef={{ current: scrollElement }}
      />
    )

    expect(screen.getAllByTestId('message-user')).toHaveLength(5)
    expect(screen.getByText('short message 0')).toBeInTheDocument()
    expect(screen.getByText('short message 4')).toBeInTheDocument()
    expect(screen.getByText('short message 0').closest('[data-index]')).toHaveStyle({
      position: 'absolute',
    })
    expect(intersectionObserver).not.toHaveBeenCalled()
  })

  test('calculates the initial visible window from the bottom with overscan', () => {
    const scrollElement = createScrollElement(200)

    render(
      <MessageList
        messages={buildMessages(100, 'long')}
        scrollElementRef={{ current: scrollElement }}
      />
    )

    expect(screen.getByText('long message 99')).toBeInTheDocument()
    expect(screen.getByText('long message 98')).toBeInTheDocument()
    expect(screen.queryByText('long message 0')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('message-user').length).toBeLessThan(10)
  })

  test('keeps a forced navigation target mounted outside the visible window', () => {
    const scrollElement = createScrollElement(200)

    render(
      <MessageList
        messages={buildMessages(100, 'navigation')}
        scrollElementRef={{ current: scrollElement }}
        forceVirtualMessageId="user-80"
      />
    )

    expect(screen.getByText('navigation message 80')).toBeInTheDocument()
    expect(screen.getByText('navigation message 99')).toBeInTheDocument()
  })

  test('measures rendered rows with ResizeObserver and caches their heights', () => {
    const scrollElement = createScrollElement(200)
    const { unmount } = render(
      <MessageList
        conversationKey="measured-conversation"
        messages={buildMessages(20, 'measured')}
        scrollElementRef={{ current: scrollElement }}
      />
    )
    const row = screen.getByText('measured message 19').closest('[data-index]')!
    const rowObserver = resizeObserverRecords.find(record => record.targets.has(row))
    expect(rowObserver).toBeDefined()

    act(() => {
      rowObserver?.callback(
        [
          {
            target: row,
            borderBoxSize: [{ blockSize: 144, inlineSize: 600 }],
            contentBoxSize: [],
            contentRect: { height: 144 },
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver
      )
    })
    unmount()

    expect(getConversationVirtualHeights('measured-conversation')).toMatchObject({
      'user-19': 144,
    })
  })
})

function buildMessages(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${index}`,
    role: 'user' as const,
    content: `${prefix} message ${index}`,
    status: 'done' as const,
    createdAt: '2026-07-24T00:00:00Z',
  }))
}

function createScrollElement(clientHeight: number): HTMLDivElement {
  const scrollElement = document.createElement('div')
  Object.defineProperty(scrollElement, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  })
  Object.defineProperty(scrollElement, 'scrollTop', {
    configurable: true,
    value: 0,
    writable: true,
  })
  scrollElement.getBoundingClientRect = () =>
    ({
      bottom: clientHeight,
      height: clientHeight,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) satisfies DOMRect
  return scrollElement
}
