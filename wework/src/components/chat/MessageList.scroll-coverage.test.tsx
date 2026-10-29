import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ConversationTranslationProvider, MessageList } from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { ConversationVirtualizer } from '@wegent/collaboration/conversation/useConversationVirtualizer'
import * as pretext from '@wegent/collaboration/conversation/messagePretextLayout'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import * as presentation from '../../../../packages/collaboration/src/conversation/assistantMessagePresentation'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([false, true])(
  'keeps mixed rows contiguous with scroll controller %s',
  async controlled => {
    const resizeObservers = new Set<{ deliver: () => void }>()
    // Deliver the browser's initial border-box observations before paint, including rows
    // mounted during scrolling. JSDOM's default observer never delivers entries.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        targets = new Set<Element>()
        queued = false
        constructor(private callback: ResizeObserverCallback) {
          resizeObservers.add(this)
        }
        deliver() {
          if (!this.targets.size) return
          this.callback(
            [...this.targets].map(target => {
              const rect = target.getBoundingClientRect()
              return {
                target,
                borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
                contentRect: rect,
              } as unknown as ResizeObserverEntry
            }),
            this as unknown as ResizeObserver
          )
        }
        observe(target: Element) {
          this.targets.add(target)
          if (this.queued) return
          this.queued = true
          queueMicrotask(() => {
            this.queued = false
            this.deliver()
          })
        }
        unobserve(target: Element) {
          this.targets.delete(target)
        }
        disconnect() {
          this.targets.clear()
        }
      }
    )
    const processingRenders = vi.spyOn(presentation, 'splitProcessingBlocks')
    const heights = Array.from({ length: 30 }, (_, index) =>
      index % 6 === 1 ? 3000 : index % 2 === 0 ? 48 : 120
    )
    const messages: WorkbenchMessage[] = heights.map((_, index) => ({
      id: `mixed-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${index}`,
      status: 'done',
      createdAt: '',
    }))
    vi.spyOn(pretext, 'getMessagePretextIntrinsicHeight').mockImplementation(message =>
      message.role === 'user' ? 80 : 1800
    )
    const engine = { current: null as ConversationVirtualizer | null }
    const viewport = document.createElement('div')
    document.body.append(viewport)
    const committedHeight = () => {
      const rows = [...viewport.querySelectorAll<HTMLElement>('[data-message-row]')]
      return Math.max(
        600,
        Number.parseFloat(rows[0]?.parentElement?.style.height ?? '') || 0,
        ...rows.map(
          row =>
            Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0) +
            heights[Number(row.dataset.index)]
        )
      )
    }
    let scrollTop = 0
    let scrollQueued = false
    const scroll = (value: number) => {
      const next = Math.max(0, Math.min(value, committedHeight() - 600))
      if (next === scrollTop) return
      scrollTop = next
      if (!scrollQueued) {
        scrollQueued = true
        queueMicrotask(() => {
          scrollQueued = false
          viewport.dispatchEvent(new Event('scroll'))
        })
      }
    }
    Object.defineProperties(viewport, {
      clientHeight: { value: 600 },
      clientWidth: { value: 800 },
      offsetHeight: { value: 600 },
      offsetWidth: { value: 800 },
      scrollHeight: { get: committedHeight },
      scrollTop: {
        // Layout can shrink the range without a scrollTo call during a switch.
        get: () => Math.min(scrollTop, Math.max(0, committedHeight() - 600)),
        set: scroll,
      },
    })
    viewport.scrollTo = ({ top = 0 }: ScrollToOptions) => {
      viewport.scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - 600))
    }
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === viewport) return new DOMRect(0, 0, 800, 600)
      const row = this.closest<HTMLElement>('[data-message-row][data-index]')
      const index = Number(row?.dataset.index)
      const top = row ? Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0) : 0
      return new DOMRect(0, top - viewport.scrollTop, 800, row ? heights[index] : 0)
    })
    const scrollElementRef = { current: viewport }
    const listProps = {
      messages,
      scrollElementRef,
      initialDistanceFromBottomPx: 100000,
      virtualAnchorToEnd: false,
      userMessageServices: {
        images: {
          identity: (image: { id: string | number }) => String(image.id),
          load: vi.fn(),
          download: vi.fn(),
        },
      },
    }
    function Conversation({
      conversationMessages = messages,
      conversationKey = 'initial',
      suspended = false,
    }: {
      conversationMessages?: WorkbenchMessage[]
      conversationKey?: string
      suspended?: boolean
    }) {
      const controller = useConversationScrollController({
        messages: conversationMessages,
        conversationKey,
        externalScrollRef: scrollElementRef,
        loading: false,
        isWaitingForAssistant: false,
        autoScrollSuspended: suspended,
        initialScrollPosition: 'latest',
      })
      return (
        <div ref={controller.contentRef}>
          <MessageList
            {...listProps}
            key={conversationKey}
            messages={conversationMessages}
            conversationKey={conversationKey}
            initialDistanceFromBottomPx={0}
            virtualizerRef={controller.virtualizerRef}
            onVirtualLayoutChange={() => {
              engine.current = controller.virtualizerRef.current
              controller.handleContentLayoutChange()
            }}
            onVirtualScrollAdjustment={controller.onVirtualScrollAdjustment}
            virtualAnchorToEnd={controller.virtualAnchorToEnd}
            virtualAnchor={controller.virtualAnchor}
            virtualScrollAdjustmentEnabled={controller.virtualScrollAdjustmentEnabled}
          />
        </div>
      )
    }
    const view = render(
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        {controlled ? <Conversation /> : <MessageList {...listProps} virtualizerRef={engine} />}
      </ConversationTranslationProvider>,
      { container: viewport }
    )
    if (!controlled) {
      const measurements = engine.current!.measurementsCache
      const indexes = engine.current!.getVirtualItems().map(row => row.index)
      processingRenders.mockClear()
      await act(async () => {
        viewport.scrollTop = 10
        fireEvent.scroll(viewport)
      })
      expect(engine.current!.getVirtualItems().map(row => row.index)).toEqual(indexes)
      expect.soft(engine.current!.measurementsCache).toBe(measurements)
      expect.soft(processingRenders).not.toHaveBeenCalled()
    }
    for (let offset = 0; offset < 14000; offset += 350) {
      await act(async () => {
        fireEvent.wheel(viewport, { deltaY: offset - viewport.scrollTop })
        viewport.scrollTop = offset
        fireEvent.scroll(viewport)
      })
      const rows = [...view.container.querySelectorAll<HTMLElement>('[data-message-row]')]
      expect(
        rows.some(row => {
          const rect = row.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < 600
        })
      ).toBe(true)
      for (const row of rows) {
        const index = Number(row.dataset.index)
        expect(engine.current!.itemSizeCache.get(messages[index].id)).toBe(heights[index])
        const next = rows.find(element => Number(element.dataset.index) === index + 1)
        if (next)
          expect(next.getBoundingClientRect().top - row.getBoundingClientRect().bottom).toBe(16)
      }
    }
    if (controlled) {
      view.rerender(
        <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
          <Conversation suspended />
        </ConversationTranslationProvider>
      )
      const rows = [...view.container.querySelectorAll<HTMLElement>('[data-message-row]')]
      const precedingRow = rows.find(row => row.getBoundingClientRect().bottom < 0)!
      const readingRow = rows.find(row => row.getBoundingClientRect().bottom > 0)!
      expect(precedingRow).toBeDefined()
      const readingTop = readingRow.getBoundingClientRect().top
      const previousOffset = viewport.scrollTop
      heights[Number(precedingRow.dataset.index)] += 200
      await act(async () => resizeObservers.forEach(observer => observer.deliver()))
      // Opening find pauses following, but a late image above the reader must not
      // move the visible text. Exercise real ResizeObserver-to-virtualizer sizing.
      expect(viewport.scrollTop).toBe(previousOffset + 200)
      expect(readingRow.getBoundingClientRect().top).toBe(readingTop)

      const runningMessages = messages.map((message, index) => ({
        ...message,
        id: `running-${index}`,
        status: index === messages.length - 1 ? ('streaming' as const) : ('done' as const),
      }))
      view.rerender(
        <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
          <Conversation conversationKey="running" conversationMessages={runningMessages} />
        </ConversationTranslationProvider>
      )
      // Assert before animation frames and again after native row observations.
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBe(0)
      await act(async () => {})
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBe(0)
      expect(engine.current!.getVirtualItems().at(-1)?.index).toBe(messages.length - 1)
    }
    view.unmount()
    viewport.remove()
  }
)
