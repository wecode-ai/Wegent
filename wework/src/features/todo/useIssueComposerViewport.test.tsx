import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useIssueComposerViewport } from '../../../../packages/collaboration/src/issue-detail/useIssueComposerViewport'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('refreshes a question moved by preceding content without resizing the viewport or question', () => {
  const observed = new Set<Element>()
  let resize!: ResizeObserverCallback
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe = (element: Element) => observed.add(element)
      unobserve = (element: Element) => observed.delete(element)
      disconnect = vi.fn()
    }
  )
  let questionTop = 200
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('task-detail-human-request'))
      return { top: questionTop, bottom: questionTop + 100, height: 100 } as DOMRect
    return { top: 0, bottom: 440, height: 94 } as DOMRect
  })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element =>
    element.tagName === 'FOOTER'
      ? ({
          position:
            (element as HTMLElement).dataset.humanRequestVisible === 'true' ? 'static' : 'sticky',
          bottom: '16px',
        } as CSSStyleDeclaration)
      : computed(element)
  )
  function Fixture() {
    const ref = useIssueComposerViewport(true)
    return (
      <div data-testid="viewport" style={{ overflowY: 'auto' }}>
        <div data-testid="content">
          <div>Description</div>
          <section className="task-detail-human-request">Question</section>
          <footer ref={ref} />
        </div>
      </div>
    )
  }
  render(<Fixture />)
  const viewport = screen.getByTestId('viewport')
  expect(viewport.style.scrollPaddingBottom).toBe('')
  questionTop = 600
  act(() => {
    const content = screen.getByTestId('content')
    if (observed.has(content))
      resize([{ target: content } as ResizeObserverEntry], {} as ResizeObserver)
  })
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
})

it('reserves the current composer footprint for browser scrolling and restores the viewport', () => {
  let resize!: ResizeObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = disconnect
    }
  )
  let height = 94
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ height }) as DOMRect
  )
  function Composer({ enabled }: { enabled: boolean }) {
    const ref = useIssueComposerViewport(enabled)
    return <footer ref={ref} style={{ position: 'sticky', bottom: 16 }} />
  }
  const view = (enabled: boolean) => (
    <div data-testid="viewport" style={{ overflowY: 'auto', scrollPaddingBottom: 12 }}>
      <Composer enabled={enabled} />
    </div>
  )
  const { rerender } = render(view(true))
  const viewport = screen.getByTestId('viewport')
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  height = 126
  act(() => resize([], {} as ResizeObserver))
  expect(viewport.style.scrollPaddingBottom).toBe('142px')
  rerender(view(false))
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  expect(disconnect).toHaveBeenCalledOnce()
})

it('releases the inset while an inline human question owns the reading surface', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  let questionBottom = 200
  let viewportBottom = 440
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('task-detail-human-requests'))
      return { top: questionBottom - 100, bottom: questionBottom, height: 100 } as DOMRect
    return { top: 0, bottom: viewportBottom, height: 94 } as DOMRect
  })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    if (element instanceof HTMLElement && element.tagName === 'FOOTER')
      return {
        position: element.dataset.humanRequestVisible === 'true' ? 'static' : 'sticky',
        bottom: '16px',
      } as CSSStyleDeclaration
    return computed(element)
  })
  function Fixture({ question }: { question: boolean }) {
    const ref = useIssueComposerViewport(true)
    return (
      <div data-testid="viewport" style={{ overflowY: 'auto', scrollPaddingBottom: 12 }}>
        {question && (
          <section className="task-detail-human-requests" style={{ scrollMarginBottom: 8 }}>
            Question
          </section>
        )}
        <footer ref={ref} />
      </div>
    )
  }
  const { rerender } = render(<Fixture question={false} />)
  const viewport = screen.getByTestId('viewport')
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  await act(async () => rerender(<Fixture question />))
  const question = screen.getByText('Question')
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  expect(question.style.scrollMarginBottom).toBe('8px')
  questionBottom = -10
  fireEvent.scroll(viewport)
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  expect(question.style.scrollMarginBottom).toBe('-100px')
  questionBottom = 200
  fireEvent.scroll(viewport)
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  expect(question.style.scrollMarginBottom).toBe('8px')
  viewportBottom = 50
  fireEvent(window, new Event('resize'))
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  viewportBottom = 440
  fireEvent(window, new Event('resize'))
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  await act(async () => rerender(<Fixture question={false} />))
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  expect(question.style.scrollMarginBottom).toBe('8px')
})
