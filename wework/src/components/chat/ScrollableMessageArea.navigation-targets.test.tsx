import { act, fireEvent, render, screen } from '@testing-library/react'
import { MessageTurnNavigation } from '@wegent/collaboration/conversation'
import { StrictMode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import {
  allResizeCallbacks,
  installScrollTestEnvironment,
  messageText,
  mockRect,
  mockScrollRelativeRect,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: navigation-targets', () => {
  installScrollTestEnvironment()

  test('cancels an unfinished target when another question opens, including queued layout callbacks', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    vi.mocked(window.requestAnimationFrame).mockImplementation(callback => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.mocked(window.cancelAnimationFrame).mockImplementation(id => {
      frames.delete(id)
    })
    const scroller = document.createElement('div')
    const content = document.createElement('div')
    const first = document.createElement('article')
    const second = document.createElement('article')
    first.dataset.messageId = 'first'
    second.dataset.messageId = 'second'
    content.append(first, second)
    scroller.append(content)
    document.body.append(scroller)
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 700, writable: true, configurable: true })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top
    })
    mockRect(scroller, 0, 300)
    mockScrollRelativeRect(first, scroller, 120, 60)
    mockScrollRelativeRect(second, scroller, 760, 60)
    const scrollRef = { current: scroller }
    const contentRef = { current: content }
    const onTarget = vi.fn()
    const messages = [
      { id: 'first', role: 'user' as const, content: 'First question' },
      { id: 'second', role: 'user' as const, content: 'Second question' },
    ]
    const pane = (messageId: string) => (
      <MessageTurnNavigation
        translate={key => key}
        messages={messages}
        scrollRef={scrollRef}
        contentRef={contentRef}
        messageTarget={{ messageId, requestKey: messageId }}
        onNavigationScrollTargetChange={onTarget}
      />
    )
    const view = render(pane('first'))
    expect(scroller.scrollTop).toBe(24)
    const oldFrames = [...frames.values()]
    const oldResize = [...allResizeCallbacks]
    view.rerender(pane('second'))
    expect(scroller.scrollTop).toBe(664)
    mockScrollRelativeRect(first, scroller, 240, 60)
    act(() => {
      oldResize.forEach(callback => callback([], {} as ResizeObserver))
      oldFrames.forEach(callback => callback(0))
    })
    expect(scroller.scrollTop).toBe(664)
    expect(onTarget).toHaveBeenLastCalledWith('second')
    view.unmount()
    scroller.remove()
  })

  test.each([false, true])(
    'locates a delayed native anchor after StrictMode replay unless the user cancels (cancel=%s)',
    async cancel => {
      const scroller = document.createElement('div')
      const content = document.createElement('div')
      scroller.append(content)
      document.body.append(scroller)
      Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
      Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
      Object.defineProperty(scroller, 'scrollTop', {
        value: 700,
        writable: true,
        configurable: true,
      })
      scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        if (typeof top === 'number') scroller.scrollTop = top
      })
      mockRect(scroller, 0, 300)
      const pane = () => (
        <StrictMode>
          <MessageTurnNavigation
            translate={key => key}
            messages={[{ id: 'delayed-source', role: 'user', content: 'Older context' }]}
            messageTarget={{ messageId: 'delayed-source', requestKey: 'request' }}
            scrollRef={{ current: scroller }}
            contentRef={{ current: content }}
            onNavigationScrollTargetChange={vi.fn()}
          />
        </StrictMode>
      )
      const view = render(pane())
      if (cancel) fireEvent.wheel(scroller, { deltaY: 100 })
      view.rerender(pane())
      const anchor = document.createElement('article')
      anchor.dataset.messageId = 'delayed-source'
      mockScrollRelativeRect(anchor, scroller, 120, 60)
      await act(async () => {
        content.append(anchor)
        await Promise.resolve()
      })
      expect(scroller.scrollTop).toBe(cancel ? 700 : 24)
      view.unmount()
      scroller.remove()
    }
  )

  test('navigates an opening message target with native turn navigation and leaves later user scrolling alone', () => {
    const messages = [
      { id: 'source', role: 'user' as const, content: '原问题上下文', status: 'done' as const },
      { id: 'later', role: 'assistant' as const, content: '后续无关内容', status: 'done' as const },
    ]
    const view = render(
      <ScrollableMessageArea conversationKey="notification-target" messages={messages} />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    const anchor = messageText('原问题上下文').closest('[data-message-id]')!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 700, writable: true, configurable: true })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top
    })
    mockRect(scroller, 0, 300)
    mockScrollRelativeRect(anchor, scroller, 120, 60)
    view.rerender(
      <ScrollableMessageArea
        conversationKey="notification-target"
        messages={messages}
        messageTarget={{ messageId: 'source', requestKey: 'notice' }}
      />
    )
    expect(scroller.scrollTop).toBe(24)
    fireEvent.wheel(scroller, { deltaY: 100 })
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    view.rerender(
      <ScrollableMessageArea
        conversationKey="notification-target"
        messages={messages}
        messageTarget={{ messageId: 'source', requestKey: 'notice' }}
      />
    )
    expect(scroller.scrollTop).toBe(400)
  })
})
