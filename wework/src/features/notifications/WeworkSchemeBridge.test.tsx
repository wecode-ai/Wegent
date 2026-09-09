import { act, cleanup, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { WeworkSchemeBridge } from './WeworkSchemeBridge'
import { openWeworkScheme } from './schemeEvents'

const { openTab, invokeDesktopHost, isElectronRuntime } = vi.hoisted(() => ({
  openTab: vi.fn(),
  invokeDesktopHost: vi.fn(),
  isElectronRuntime: vi.fn(() => false),
}))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => ({ openTab }),
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime }))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost,
  subscribeDesktopHostEvents: () => () => {},
}))

beforeEach(() => {
  vi.clearAllMocks()
  isElectronRuntime.mockReturnValue(false)
})
afterEach(cleanup)

describe('Wework scheme bridge', () => {
  it('acknowledges native links only after navigation, including StrictMode remounts', async () => {
    isElectronRuntime.mockReturnValue(true)
    const pending = [{ id: 1, url: 'wework://tasks/device/task' }]
    invokeDesktopHost.mockImplementation(async (capability: string) =>
      capability === 'navigation.pendingSchemes' ? pending : undefined
    )
    render(
      <StrictMode>
        <WeworkSchemeBridge />
      </StrictMode>
    )
    await waitFor(() =>
      expect(invokeDesktopHost).toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 1 })
    )
    expect(openTab).toHaveBeenCalledExactlyOnceWith('task', {
      contentRoute: '/runtime-tasks?deviceId=device&taskId=task',
    })
  })

  it('keeps native board requests unacknowledged until authentication is restored', async () => {
    isElectronRuntime.mockReturnValue(true)
    invokeDesktopHost.mockImplementation(async (capability: string) =>
      capability === 'navigation.pendingSchemes'
        ? [{ id: 2, url: 'wework://boards/12/issues/ISSUE-1' }]
        : undefined
    )
    const view = (connected: boolean) => (
      <CloudConnectionContext.Provider
        value={
          {
            status: connected ? 'connected' : 'restoring',
            isConnected: connected,
            token: connected ? 'test-token' : null,
          } as CloudConnectionContextValue
        }
      >
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )
    const rendered = render(view(false))
    await act(async () => {})
    expect(openTab).not.toHaveBeenCalled()
    expect(invokeDesktopHost).not.toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 2 })
    rendered.rerender(view(true))
    await waitFor(() =>
      expect(invokeDesktopHost).toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 2 })
    )
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('retains a board link until the cloud account reconnects', async () => {
    openTab.mockClear()
    const connection = {
      status: 'restoring',
      isConnected: false,
      token: null,
    } as CloudConnectionContextValue
    const view = (value: CloudConnectionContextValue) => (
      <CloudConnectionContext.Provider value={value}>
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )
    const rendered = render(view(connection))
    act(() => {
      openWeworkScheme('wework://boards/12/issues/ISSUE-1')
    })
    expect(openTab).not.toHaveBeenCalled()
    rendered.rerender(
      view({ ...connection, status: 'connected', isConnected: true, token: 'test-token' })
    )
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith('board', {
        contentRoute: '/todo?projectStore=backend&projectId=12&itemId=ISSUE-1',
      })
    )
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('opens the board homepage without a cloud account', () => {
    render(<WeworkSchemeBridge />)
    act(() => {
      openWeworkScheme('wework://boards')
    })
    expect(openTab).toHaveBeenCalledExactlyOnceWith('board', { contentRoute: '/todo' })
  })

  it('opens local task links without a cloud account and rejects unknown routes', () => {
    openTab.mockClear()
    render(<WeworkSchemeBridge />)
    act(() => {
      openWeworkScheme('wework://tasks/local-device/task-1')
    })
    expect(openTab).toHaveBeenCalledWith('task', {
      contentRoute: '/runtime-tasks?deviceId=local-device&taskId=task-1',
    })
    expect(openWeworkScheme('wework://shell/run')).toBe(false)
    expect(openTab).toHaveBeenCalledOnce()
  })
})
