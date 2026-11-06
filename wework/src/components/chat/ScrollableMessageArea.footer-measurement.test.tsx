import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import { allResizeCallbacks, installScrollTestEnvironment } from './scrollableMessageTestHelpers'

const messages = [
  {
    id: 'reply',
    role: 'assistant' as const,
    content: 'Reply',
    status: 'streaming' as const,
    createdAt: '',
  },
]

describe('conversation footer measurement', () => {
  installScrollTestEnvironment()
  afterEach(() => vi.restoreAllMocks())

  test('keeps footer geometry current without rereading it for every virtual row commit', () => {
    let controller: ReturnType<typeof useConversationScrollController>
    let footerHeight = 32
    const measure = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'footer' ? footerHeight : 0
      })
    function Conversation({ showFooter = true }: { showFooter?: boolean }) {
      controller = useConversationScrollController({
        messages,
        conversationKey: 'footer-measurement',
      })
      return (
        <div ref={controller.scrollRef}>
          <div ref={controller.contentRef} />
          {showFooter && <div ref={controller.stickyFooterRef} data-testid="footer" />}
        </div>
      )
    }
    const view = render(<Conversation />)
    expect(controller!.scrollTailHeight).toBe(32)
    measure.mockClear()

    act(() => {
      for (let index = 0; index < 520; index++) controller.handleContentLayoutChange()
    })
    expect(measure).not.toHaveBeenCalled()

    footerHeight = 64
    act(() => {
      for (const callback of allResizeCallbacks) callback([], {} as ResizeObserver)
    })
    expect(controller!.scrollTailHeight).toBe(64)

    view.rerender(<Conversation showFooter={false} />)
    expect(controller!.scrollTailHeight).toBe(0)
    view.rerender(<Conversation />)
    expect(controller!.scrollTailHeight).toBe(64)
  })
})
