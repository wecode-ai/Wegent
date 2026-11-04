import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
