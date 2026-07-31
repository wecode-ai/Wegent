import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceTab } from './workspaceTabs'

const once = vi.fn()
const show = vi.fn().mockResolvedValue(undefined)
const setFocus = vi.fn().mockResolvedValue(undefined)
const destroy = vi.fn().mockResolvedValue(undefined)
const WebviewWindow = vi.fn(function MockWebviewWindow() {
  return { once, show, setFocus, destroy }
})

vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow }))
vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
}))

const tab: WorkspaceTab = {
  id: 'board-project-1',
  kind: 'board',
  title: '产品规划',
  contentRoute: '/todo?projectId=project-1',
}

describe('openWorkspaceTabWindow', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
    once.mockImplementation((eventName: string, callback: () => void) => {
      if (eventName === 'tauri://created') callback()
      return Promise.resolve(vi.fn())
    })
  })

  test('uses a browser window outside Tauri', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openWorkspaceTabWindow } = await import('./workspaceWindow')

    await openWorkspaceTabWindow(tab)

    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('/todo?projectId=project-1&workspaceTab=board-project-1'),
      '_blank',
      'noopener,noreferrer'
    )
    expect(WebviewWindow).not.toHaveBeenCalled()
  })

  test('creates, reveals and focuses an isolated Tauri workspace window', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    const { openWorkspaceTabWindow } = await import('./workspaceWindow')

    await openWorkspaceTabWindow(tab)

    expect(WebviewWindow).toHaveBeenCalledWith(
      expect.stringMatching(/^workspace-board-project-1-\d+$/),
      expect.objectContaining({
        title: '产品规划',
        visible: false,
        transparent: true,
        titleBarStyle: 'overlay',
        tabbingIdentifier: 'io.wecode.wework.workspace',
      })
    )
    expect(show).toHaveBeenCalledOnce()
    expect(setFocus).toHaveBeenCalledOnce()
    expect(destroy).not.toHaveBeenCalled()
  })

  test('destroys a hidden Tauri window when creation reports an error', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    once.mockImplementation(
      (eventName: string, callback: (event: { payload: unknown }) => void) => {
        if (eventName === 'tauri://error') callback({ payload: 'window failed' })
        return Promise.resolve(vi.fn())
      }
    )
    const { openWorkspaceTabWindow } = await import('./workspaceWindow')

    await expect(openWorkspaceTabWindow(tab)).rejects.toThrow('window failed')

    expect(destroy).toHaveBeenCalledOnce()
    expect(show).not.toHaveBeenCalled()
  })

  test('destroys a hidden Tauri window when creation times out', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    once.mockResolvedValue(vi.fn())
    const { openWorkspaceTabWindow } = await import('./workspaceWindow')

    const opening = openWorkspaceTabWindow(tab)
    const rejection = expect(opening).rejects.toThrow('Timed out creating workspace window')
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(destroy).toHaveBeenCalledOnce()
    expect(show).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
