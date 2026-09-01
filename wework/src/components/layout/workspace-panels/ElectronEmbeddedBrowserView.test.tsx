import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ElectronEmbeddedBrowserView } from './ElectronEmbeddedBrowserView'

const embeddedBrowserMocks = vi.hoisted(() => ({
  notifyEmbeddedBrowserAgentCursorArrived: vi.fn(),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('ElectronEmbeddedBrowserView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived.mockReset()
    embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived.mockResolvedValue(undefined)
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    document.querySelector('[data-wework-browser-webview-host-root]')?.remove()
  })

  test('renders and acknowledges the host-layer AI cursor before a click continues', async () => {
    render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser"
        visualRect={null}
        cursorScale={1}
        cursor={{
          label: 'workspace-browser',
          visible: true,
          x: 100,
          y: 50,
          animateMovement: true,
          moveSequence: 7,
          createdAtUnixMs: Date.now(),
        }}
      />
    )

    const container = document.querySelector('[data-testid="workspace-browser-electron-webview"]')
    expect(container?.querySelector('webview')).not.toBeNull()
    expect(
      container?.querySelector('[data-testid="workspace-browser-agent-cursor-overlay"]')
    ).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(16)
    })
    expect(screen.getByTestId('workspace-browser-agent-cursor')).toHaveAttribute(
      'data-visible',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-agent-cursor')).toHaveStyle({
      transform: 'translate3d(97px, 47px, 0)',
    })

    await act(async () => {
      vi.advanceTimersByTime(180)
    })

    expect(embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived).toHaveBeenCalledWith(
      'workspace-browser',
      7
    )
  })

  test('keeps the cursor visible while it moves smoothly between agent targets', async () => {
    const cursor = {
      label: 'workspace-browser',
      visible: true,
      x: 100,
      y: 50,
      animateMovement: true,
      moveSequence: 7,
      createdAtUnixMs: Date.now(),
    }
    const view = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser"
        visualRect={null}
        cursorScale={1}
        cursor={cursor}
      />
    )

    await act(async () => {
      vi.advanceTimersByTime(180)
    })
    embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived.mockClear()

    view.rerender(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser"
        visualRect={null}
        cursorScale={1}
        cursor={{
          ...cursor,
          x: 500,
          y: 300,
          moveSequence: 8,
        }}
      />
    )

    await act(async () => {
      vi.advanceTimersByTime(160)
    })

    const movingStyle = screen.getByTestId('workspace-browser-agent-cursor').style.transform
    expect(movingStyle).not.toBe('translate3d(497px, 297px, 0)')
    expect(screen.getByTestId('workspace-browser-agent-cursor')).toHaveAttribute(
      'data-visible',
      'true'
    )

    await act(async () => {
      vi.advanceTimersByTime(1_200)
    })

    expect(screen.getByTestId('workspace-browser-agent-cursor')).toHaveStyle({
      transform: 'translate3d(497px, 297px, 0)',
    })
    expect(embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived).toHaveBeenCalledWith(
      'workspace-browser',
      8
    )
  })
})
