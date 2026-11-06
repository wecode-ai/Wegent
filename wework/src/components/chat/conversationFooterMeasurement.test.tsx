import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('retains footer geometry through content updates and observes actual footer resizing', () => {
  const observers = new Map<Element, ResizeObserverCallback>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observers.set(element, this.callback)
      }
      disconnect() {
        for (const [element, callback] of observers) {
          if (callback === this.callback) observers.delete(element)
        }
      }
    }
  )
  let footerHeight = 100
  const heightReads = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'footer' ? footerHeight : 20
    })
  let contentLayout!: () => void
  function Conversation() {
    const controller = useConversationScrollController({ messages: [], loading: true })
    contentLayout = controller.handleContentLayoutChange
    return (
      <div ref={controller.scrollRef}>
        <div ref={controller.contentRef} data-testid="content" />
        <div ref={controller.contentFooterRef} />
        <div ref={controller.stickyFooterRef} data-testid="footer" />
        <output data-testid="tail-height">{controller.scrollTailHeight}</output>
      </div>
    )
  }
  render(<Conversation />)
  expect(screen.getByTestId('tail-height')).toHaveTextContent('120')
  heightReads.mockClear()

  act(() => {
    contentLayout()
    const content = screen.getByTestId('content')
    observers.get(content)!([{ target: content } as ResizeObserverEntry], {} as ResizeObserver)
  })
  expect(heightReads).not.toHaveBeenCalled()
  expect(screen.getByTestId('tail-height')).toHaveTextContent('120')

  footerHeight = 160
  act(() => {
    const footer = screen.getByTestId('footer')
    observers.get(footer)!([{ target: footer } as ResizeObserverEntry], {} as ResizeObserver)
  })
  expect(screen.getByTestId('tail-height')).toHaveTextContent('180')
})
