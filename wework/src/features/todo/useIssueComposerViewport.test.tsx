import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useIssueComposerViewport } from '../../../../packages/collaboration/src/issue-detail/useIssueComposerViewport'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
      disconnect = vi.fn()
    }
  )
  let questionBottom = 200
  let viewportBottom = 440
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('task-detail-human-requests'))
      return { top: questionBottom - 100, bottom: questionBottom } as DOMRect
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
        {question && <section className="task-detail-human-requests">Question</section>}
        <footer ref={ref} />
      </div>
    )
  }
  const { rerender } = render(<Fixture question={false} />)
  const viewport = screen.getByTestId('viewport')
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  await act(async () => rerender(<Fixture question />))
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  questionBottom = -10
  fireEvent.scroll(viewport)
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  questionBottom = 200
  fireEvent.scroll(viewport)
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  viewportBottom = 50
  fireEvent(window, new Event('resize'))
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
  viewportBottom = 440
  fireEvent(window, new Event('resize'))
  expect(viewport.style.scrollPaddingBottom).toBe('12px')
  await act(async () => rerender(<Fixture question={false} />))
  expect(viewport.style.scrollPaddingBottom).toBe('110px')
})
