import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { TaskActivityContent } from './TaskActivityContent'

let contentHeight = 100
let previewHeight = 240
let resized: () => void
const disconnect = vi.fn()

beforeEach(() => {
  contentHeight = 100
  previewHeight = 240
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    }
  )
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: () => `${previewHeight}px`,
      }) as unknown as CSSStyleDeclaration
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return {
      height: this.classList.contains('task-activity-content-body') ? contentHeight : previewHeight,
      top: 0,
      bottom: previewHeight,
    } as DOMRect
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  disconnect.mockClear()
})

describe('TaskActivityContent', () => {
  it('leaves short content visible without an expansion control', () => {
    render(<TaskActivityContent messageId="short">Short reply</TaskActivityContent>)
    expect(screen.getByText('Short reply')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('expands and collapses overflowing content without removing Markdown elements', () => {
    contentHeight = 600
    render(
      <TaskActivityContent messageId="long">
        <table>
          <tbody>
            <tr>
              <td>Full table</td>
            </tr>
          </tbody>
        </table>
        <pre>Full code</pre>
      </TaskActivityContent>
    )
    const toggle = screen.getByRole('button', { name: '展开全文' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(
      screen.getByRole('table')
    )
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('收起')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Full code')).toBeInTheDocument()
  })

  it('detects streamed or late-loading content and preserves the user expansion choice', () => {
    render(<TaskActivityContent messageId="stream">Streaming content</TaskActivityContent>)
    contentHeight = 400
    act(() => resized())
    const toggle = screen.getByRole('button', { name: '展开全文' })
    fireEvent.click(toggle)
    contentHeight = 800
    act(() => resized())
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    contentHeight = 100
    act(() => resized())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('remeasures the responsive preview limit and disconnects on unmount', () => {
    contentHeight = 220
    const { unmount } = render(
      <TaskActivityContent messageId="responsive">Content</TaskActivityContent>
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    previewHeight = 192
    act(() => resized())
    expect(screen.getByRole('button', { name: '展开全文' })).toBeInTheDocument()
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('returns a collapsed offscreen activity to the detail viewport', () => {
    contentHeight = 800
    const { container } = render(
      <div className="task-detail-left" data-testid="cloud-todo-detail-scroll">
        <article>
          <TaskActivityContent messageId="scroll">Long reply</TaskActivityContent>
        </article>
      </div>
    )
    const article = container.querySelector('article')!
    article.scrollIntoView = vi.fn()
    Object.defineProperty(article, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: -600 }) as DOMRect,
    })
    const toggle = screen.getByRole('button', { name: '展开全文' })
    fireEvent.click(toggle)
    expect(article.scrollIntoView).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(article.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
  })

  it('reveals clipped content when keyboard focus reaches an offscreen link', () => {
    contentHeight = 800
    render(
      <TaskActivityContent messageId="focus">
        <a href="#result">Result</a>
      </TaskActivityContent>
    )
    const toggle = screen.getByRole('button', { name: '展开全文' })
    const viewport = document.getElementById(toggle.getAttribute('aria-controls')!)!
    viewport.scrollTop = 200
    fireEvent.focus(screen.getByRole('link'))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(viewport.scrollTop).toBe(0)
  })
})
