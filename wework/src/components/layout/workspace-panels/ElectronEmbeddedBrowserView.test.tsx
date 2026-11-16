import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ElectronEmbeddedBrowserView } from './ElectronEmbeddedBrowserView'

const embeddedBrowserMocks = vi.hoisted(() => ({
  notifyEmbeddedBrowserAgentCursorArrived: vi.fn(),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

const resizeObserverCallbacks: Array<() => void> = []

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(() => callback([], this as unknown as ResizeObserver))
  }

  observe = vi.fn()
  disconnect = vi.fn()
}

describe('ElectronEmbeddedBrowserView', () => {
  beforeEach(() => {
    resizeObserverCallbacks.length = 0
    vi.useFakeTimers()
    embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived.mockReset()
    embeddedBrowserMocks.notifyEmbeddedBrowserAgentCursorArrived.mockResolvedValue(undefined)
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    document.querySelector('[data-wework-browser-webview-host-root]')?.remove()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.querySelector('[data-wework-browser-webview-host-root]')?.remove()
  })

  test('keeps one webview when ownership overlaps during a panel transition', async () => {
    const first = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-overlap"
        visualRect={null}
      />
    )
    const host = screen.getByTestId('workspace-browser-electron-webview')
    const webview = host.querySelector('webview')

    const second = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-overlap"
        visualRect={null}
      />
    )
    expect(screen.getAllByTestId('workspace-browser-electron-webview')).toEqual([host])
    expect(host.querySelector('webview')).toBe(webview)

    first.rerender(
      <ElectronEmbeddedBrowserView
        active={false}
        interactionBlocked
        label="workspace-browser-overlap"
        visualRect={null}
      />
    )
    expect(host.style.visibility).toBe('visible')
    expect(host.style.pointerEvents).toBe('auto')

    first.unmount()
    expect(screen.getByTestId('workspace-browser-electron-webview')).toBe(host)

    second.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('workspace-browser-electron-webview')).not.toBeInTheDocument()
  })

  test('restores the prior owner when the newer overlapping panel unmounts first', async () => {
    const first = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-overlap-reverse"
        visualRect={null}
      />
    )
    const host = screen.getByTestId('workspace-browser-electron-webview')
    const webview = host.querySelector('webview')
    const second = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-overlap-reverse"
        visualRect={null}
      />
    )

    second.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByTestId('workspace-browser-electron-webview')).toBe(host)
    expect(host.querySelector('webview')).toBe(webview)
    first.rerender(
      <ElectronEmbeddedBrowserView
        active={false}
        interactionBlocked
        label="workspace-browser-overlap-reverse"
        visualRect={null}
      />
    )
    expect(host.style.visibility).toBe('hidden')
    expect(host.style.pointerEvents).toBe('none')

    first.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('workspace-browser-electron-webview')).not.toBeInTheDocument()
  })

  test('ignores stale bounds updates after ownership moves to the task pane', () => {
    const source = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-overlap"
        visualRect={null}
      />
    )
    const sourcePlaceholder = source.getByTestId('workspace-browser-electron-webview-placeholder')
    vi.spyOn(sourcePlaceholder, 'getBoundingClientRect').mockReturnValue({
      height: 400,
      left: 10,
      top: 20,
      width: 600,
    } as DOMRect)
    resizeObserverCallbacks[0]?.()

    const destination = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-overlap"
        visualRect={null}
      />
    )
    const destinationPlaceholder = destination.container.querySelector<HTMLElement>(
      '[data-testid="workspace-browser-electron-webview-placeholder"]'
    )
    expect(destinationPlaceholder).not.toBeNull()
    const destinationRect = vi
      .spyOn(destinationPlaceholder, 'getBoundingClientRect')
      .mockReturnValue({
        height: 0,
        left: 0,
        top: 0,
        width: 0,
      } as DOMRect)
    resizeObserverCallbacks[1]?.()

    const host = screen.getByTestId('workspace-browser-electron-webview')
    expect(host.style.left).toBe('10px')
    expect(host.style.width).toBe('600px')

    destinationRect.mockReturnValue({
      height: 500,
      left: 700,
      top: 30,
      width: 800,
    } as DOMRect)
    resizeObserverCallbacks[1]?.()

    expect(host.style.left).toBe('700px')
    expect(host.style.width).toBe('800px')

    resizeObserverCallbacks[0]?.()

    expect(host.style.left).toBe('700px')
    expect(host.style.top).toBe('30px')
    expect(host.style.width).toBe('800px')
    expect(host.style.height).toBe('500px')
  })
})
