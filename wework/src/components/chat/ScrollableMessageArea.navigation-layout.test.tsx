import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { flushScheduledTimers, installScrollTestEnvironment } from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: navigation-layout', () => {
  installScrollTestEnvironment()

  test('keeps message navigation available while a cached external scroller is hidden', () => {
    const resizeObservers: Array<{
      callback: ResizeObserverCallback
      targets: Set<Element>
    }> = []
    const originalResizeObserver = globalThis.ResizeObserver
    class ResizeObserverMock {
      private readonly entry: (typeof resizeObservers)[number]

      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() }
        resizeObservers.push(this.entry)
      }

      observe(target: Element) {
        this.entry.targets.add(target)
      }

      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      const externalScrollRef = createRef<HTMLDivElement>()
      render(
        <div ref={externalScrollRef}>
          <ScrollableMessageArea
            externalScrollRef={externalScrollRef}
            messages={[
              {
                id: 'cached-user-1',
                role: 'user',
                content: '缓存会话第一条需求',
                status: 'done',
                createdAt: '2026-05-29T00:00:00.000Z',
              },
              {
                id: 'cached-assistant-1',
                role: 'assistant',
                content: '缓存会话第一条回复',
                status: 'done',
                createdAt: '2026-05-29T00:00:01.000Z',
              },
              {
                id: 'cached-user-2',
                role: 'user',
                content: '缓存会话第二条需求',
                status: 'done',
                createdAt: '2026-05-29T00:00:02.000Z',
              },
            ]}
          />
        </div>
      )

      const scroller = externalScrollRef.current!
      const scrollerObserver = resizeObservers.find(observer => observer.targets.has(scroller))
      expect(scrollerObserver).toBeDefined()
      flushScheduledTimers()

      expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })
})
