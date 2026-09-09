import { describe, expect, test, vi } from 'vitest'
import {
  installLocalWorkspaceOpenListener,
  takePendingLocalWorkspaceOpenRequests,
} from './localWorkspaceOpen'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
  electronRuntime: vi.fn(() => true),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
  subscribeDesktopHostEvents: desktopHostMocks.subscribe,
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: desktopHostMocks.electronRuntime,
}))

describe('localWorkspaceOpen', () => {
  test('does not install the Electron listener in a browser runtime', () => {
    desktopHostMocks.electronRuntime.mockReturnValueOnce(false)

    expect(installLocalWorkspaceOpenListener(vi.fn())).toBeNull()
    expect(desktopHostMocks.invoke).not.toHaveBeenCalled()
    expect(desktopHostMocks.subscribe).not.toHaveBeenCalled()
  })

  test('takes pending workspace requests from the Electron host', async () => {
    desktopHostMocks.invoke.mockResolvedValueOnce([{ path: '/workspace/project' }])

    await expect(takePendingLocalWorkspaceOpenRequests()).resolves.toEqual([
      { path: '/workspace/project' },
    ])
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('workspace.takePendingOpenRequests')
  })

  test('drains startup and event-triggered workspace requests', async () => {
    const openWorkspace = vi.fn()
    let eventHandler: ((event: { type: string }) => void) | null = null
    const unsubscribe = vi.fn()
    desktopHostMocks.subscribe.mockImplementation(handler => {
      eventHandler = handler
      return unsubscribe
    })
    desktopHostMocks.invoke
      .mockResolvedValueOnce([{ path: ' /workspace/one ', label: ' One ' }])
      .mockResolvedValueOnce([{ path: '/workspace/two' }])

    const listener = installLocalWorkspaceOpenListener(openWorkspace)
    await vi.waitFor(() =>
      expect(openWorkspace).toHaveBeenCalledWith('local-device', '/workspace/one', 'One')
    )
    eventHandler?.({ type: 'wework-open-local-workspace-requested' })
    await vi.waitFor(() =>
      expect(openWorkspace).toHaveBeenCalledWith('local-device', '/workspace/two', undefined)
    )

    expect(await listener).toBe(unsubscribe)
  })
})
