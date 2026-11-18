import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createWorkspaceTabsStore } from '@/features/workspace-tabs/workspaceTabsStore'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'

const mocks = vi.hoisted(() => ({
  createLocalAppServices: vi.fn(),
  notifyInstallationsChanged: vi.fn(),
  releaseRoutes: vi.fn(),
  stop: vi.fn(),
  unregister: vi.fn(),
}))

const modelApi = { unregisterProxy: vi.fn(), unregisterContext: vi.fn() }
const decisionApi = { unregister: vi.fn() }

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    stop: mocks.stop,
  },
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: mocks.createLocalAppServices,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('./harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notifyInstallationsChanged,
}))

vi.mock('./harnessAppTabs', () => ({
  unregisterHarnessAppTab: mocks.unregister,
}))

vi.mock('./harnessAppRoutes', () => ({
  releaseHarnessAppRoutes: mocks.releaseRoutes,
}))

describe('workspace tab Smart app synchronization', () => {
  beforeEach(() => {
    mocks.createLocalAppServices
      .mockReset()
      .mockReturnValue({ localHarnessModelApi: modelApi, localDecisionRouterApi: decisionApi })
    mocks.notifyInstallationsChanged.mockReset()
    mocks.releaseRoutes.mockReset().mockResolvedValue(undefined)
    mocks.stop.mockReset().mockResolvedValue(undefined)
    mocks.unregister.mockReset()
  })

  test('releases every route when stopping the runtime fails', async () => {
    mocks.stop.mockRejectedValueOnce(new Error('stop failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createWorkspaceTabsStore(
      {
        tabs: [
          {
            id: 'app-tab',
            kind: 'auxiliary',
            title: 'Smart app',
            fixed: false,
            contentRoute: '/app/harness-smart-app-1',
          } as WorkspaceTab,
        ],
      },
      (_state, tabs: WorkspaceTab[]) => ({ tabs })
    )
    store.dispatch([
      { id: 'task-tab', kind: 'task', title: 'Task', fixed: false, contentRoute: '/' },
    ])

    try {
      await waitFor(() =>
        expect(mocks.releaseRoutes).toHaveBeenCalledWith('smart-app-1', modelApi, decisionApi)
      )
      expect(mocks.notifyInstallationsChanged).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
