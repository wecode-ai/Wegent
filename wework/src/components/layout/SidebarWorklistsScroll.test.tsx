import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarWorklistsScroll } from './SidebarWorklistsScroll'

let contentHeight = 300
const resizes = new Set<() => void>()

beforeEach(() => {
  contentHeight = 300
  resizes.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      callback: () => void
      constructor(callback: ResizeObserverCallback) {
        this.callback = () => callback([], this)
        resizes.add(this.callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizes.delete(this.callback)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'sidebar-worklists-scroll' ? contentHeight : 100
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function resize() {
  act(() => resizes.forEach(callback => callback()))
}

describe('SidebarWorklistsScroll', () => {
  it('extends the overlay scrollbar through the sidebar padding without widening content', () => {
    render(
      <SidebarWorklistsScroll
        viewportRef={createRef<HTMLDivElement>()}
        scrolled={false}
        locked={false}
        onScroll={() => {}}
      >
        <div>Tasks</div>
      </SidebarWorklistsScroll>
    )

    expect(screen.getByTestId('sidebar-worklists-scroll-area')).toHaveClass('-mr-1.5', 'pr-1.5')
    expect(screen.getByTestId('sidebar-worklists-scroll')).toHaveClass('w-full')
  })

  it('keeps its overlay scrollbar mounted at the top, middle and bottom', async () => {
    const viewportRef = createRef<HTMLDivElement>()
    render(
      <SidebarWorklistsScroll
        viewportRef={viewportRef}
        scrolled={false}
        locked={false}
        onScroll={() => {}}
      >
        <div>Tasks</div>
      </SidebarWorklistsScroll>
    )
    resize()
    const scrollbar = await screen.findByTestId('sidebar-worklists-scrollbar')
    const viewport = screen.getByTestId('sidebar-worklists-scroll')
    expect(viewportRef.current).toBe(viewport)
    expect(viewport.contains(scrollbar)).toBe(false)
    for (const scrollTop of [0, 100, 200, 0]) {
      fireEvent.scroll(viewport, { target: { scrollTop } })
      expect(screen.getByTestId('sidebar-worklists-scrollbar')).toBe(scrollbar)
      expect(scrollbar).toHaveAttribute('data-state', 'visible')
    }
  })

  it('shows the scrollbar only while the content overflows', async () => {
    contentHeight = 80
    render(
      <SidebarWorklistsScroll
        viewportRef={createRef<HTMLDivElement>()}
        scrolled={false}
        locked={false}
        onScroll={() => {}}
      >
        <div>Tasks</div>
      </SidebarWorklistsScroll>
    )
    resize()
    expect(screen.queryByTestId('sidebar-worklists-scrollbar')).not.toBeInTheDocument()
    contentHeight = 300
    resize()
    await screen.findByTestId('sidebar-worklists-scrollbar')
    contentHeight = 80
    resize()
    await waitFor(() =>
      expect(screen.queryByTestId('sidebar-worklists-scrollbar')).not.toBeInTheDocument()
    )
  })
})
