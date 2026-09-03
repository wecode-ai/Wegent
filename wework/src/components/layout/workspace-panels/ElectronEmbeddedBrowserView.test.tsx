import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ElectronEmbeddedBrowserView } from './ElectronEmbeddedBrowserView'
import {
  claimElectronEmbeddedBrowserView,
  relabelElectronEmbeddedBrowserView,
  releaseElectronEmbeddedBrowserView,
  retainElectronEmbeddedBrowserView,
} from './electronEmbeddedBrowserHost'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeRequestHandler: null as ((event: { label: string; nativeLabel: string }) => void) | null,
  listenEmbeddedBrowserCloseRequests: vi.fn(),
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
    embeddedBrowserMocks.closeRequestHandler = null
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockReset()
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockImplementation(handler => {
      embeddedBrowserMocks.closeRequestHandler = handler
      return Promise.resolve(() => {
        if (embeddedBrowserMocks.closeRequestHandler === handler) {
          embeddedBrowserMocks.closeRequestHandler = null
        }
      })
    })
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    document.querySelector('[data-wework-browser-webview-host-root]')?.remove()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

  test('reuses the loaded webview when a blank conversation becomes a task', async () => {
    const source = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-blank-0"
        visualRect={null}
      />
    )
    const sourceHost = screen.getByTestId('workspace-browser-electron-webview')
    const loadedWebview = sourceHost.querySelector('webview')

    retainElectronEmbeddedBrowserView('workspace-browser-blank-0')
    source.unmount()
    expect(screen.getByTestId('workspace-browser-electron-webview')).toBe(sourceHost)
    expect(sourceHost.style.visibility).toBe('hidden')
    expect(sourceHost.style.pointerEvents).toBe('none')

    const destination = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-blank-0"
        visualRect={null}
      />
    )
    const transferredHost = screen.getByTestId('workspace-browser-electron-webview')
    expect(transferredHost.querySelector('webview')).toBe(loadedWebview)

    destination.rerender(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-task-1"
        visualRect={null}
      />
    )
    expect(transferredHost).toHaveAttribute(
      'data-wework-browser-webview',
      'workspace-browser-task-1'
    )

    destination.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('workspace-browser-electron-webview')).not.toBeInTheDocument()
  })

  test('replaces a closed webview before the same route is reopened', async () => {
    render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser"
        visualRect={null}
      />
    )
    const host = screen.getByTestId('workspace-browser-electron-webview')
    const previousWebview = host.querySelector('webview')
    const previousPartition = previousWebview?.getAttribute('partition')

    await act(async () => {
      embeddedBrowserMocks.closeRequestHandler?.({
        label: 'workspace-browser',
        nativeLabel: 'electron-browser-1',
      })
    })

    const nextWebview = host.querySelector('webview')
    expect(nextWebview).not.toBe(previousWebview)
    expect(host.querySelectorAll('webview')).toHaveLength(1)
    expect(nextWebview?.getAttribute('partition')).not.toBe(previousPartition)
    expect(previousWebview?.isConnected).toBe(false)
    expect(host.style.visibility).toBe('visible')
    expect(host.style.pointerEvents).toBe('auto')
  })

  test('does not replace an active host while relabeling', () => {
    const sourceOwner = Symbol('source')
    const targetOwner = Symbol('target')
    const source = claimElectronEmbeddedBrowserView('workspace-browser-source', sourceOwner)
    const target = claimElectronEmbeddedBrowserView('workspace-browser-target', targetOwner)

    expect(() =>
      relabelElectronEmbeddedBrowserView(source, sourceOwner, 'workspace-browser-target')
    ).toThrow('Embedded browser label already has an active host')
    expect(source.destroyed).toBe(false)
    expect(target.destroyed).toBe(false)
    expect(source.container.isConnected).toBe(true)
    expect(target.container.isConnected).toBe(true)

    releaseElectronEmbeddedBrowserView(source, sourceOwner)
    releaseElectronEmbeddedBrowserView(target, targetOwner)
  })

  test('claims the retained blank webview when the task label renders first', async () => {
    const source = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-blank-0"
        visualRect={null}
      />
    )
    const sourceHost = screen.getByTestId('workspace-browser-electron-webview')
    const loadedWebview = sourceHost.querySelector('webview')
    const sourcePartition = loadedWebview?.getAttribute('partition')

    retainElectronEmbeddedBrowserView('workspace-browser-blank-0')
    source.unmount()

    const destination = render(
      <ElectronEmbeddedBrowserView
        active
        interactionBlocked={false}
        label="workspace-browser-runtime-1"
        transferFromLabel="workspace-browser-blank-0"
        visualRect={null}
      />
    )

    const transferredHost = screen.getByTestId('workspace-browser-electron-webview')
    expect(screen.getAllByTestId('workspace-browser-electron-webview')).toEqual([sourceHost])
    expect(transferredHost.querySelector('webview')).toBe(loadedWebview)
    expect(loadedWebview).toHaveAttribute('partition', sourcePartition)
    expect(transferredHost).toHaveAttribute(
      'data-wework-browser-webview',
      'workspace-browser-runtime-1'
    )

    destination.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('workspace-browser-electron-webview')).not.toBeInTheDocument()
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
