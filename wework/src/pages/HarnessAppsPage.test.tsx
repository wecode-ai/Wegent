import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { HarnessAppPreview } from '@/api/local/harnessApps'
import type { UnifiedModel } from '@/types/api'
import { HarnessAppsPage } from './HarnessAppsPage'

const mocks = vi.hoisted(() => ({
  api: {
    delete: vi.fn(),
    install: vi.fn(),
    list: vi.fn(),
    preview: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
  closeTab: vi.fn(),
  openTab: vi.fn(),
  register: vi.fn(),
  resolveLaunch: vi.fn(),
  selectTab: vi.fn(),
  t: vi.fn((_key: string, fallback?: string) => fallback ?? _key),
  unregister: vi.fn(),
  unregisterProxy: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: mocks.api,
}))

vi.mock('@/components/layout/DesktopTopBar', () => ({
  DesktopTopBar: () => null,
}))

vi.mock('@/features/harness-apps/harnessAppTabs', async importOriginal => {
  const original = await importOriginal<typeof import('@/features/harness-apps/harnessAppTabs')>()
  return {
    ...original,
    registerHarnessAppTab: mocks.register,
    unregisterHarnessAppTab: mocks.unregister,
  }
})

const model: UnifiedModel = {
  name: 'local-model:model-1',
  type: 'runtime',
  provider: 'local',
  displayName: 'Local Model',
  modelId: 'local-upstream',
  config: { weworkModelKind: 'model-interface' },
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: [model] },
    services: {
      localHarnessModelApi: {
        resolveLaunch: mocks.resolveLaunch,
        unregisterProxy: mocks.unregisterProxy,
      },
    },
  }),
}))

const workspaceTabs = {
  tabs: [] as Array<{ id: string; kind: 'auxiliary'; title: string; contentRoute: string }>,
  activeTabId: 'task-1',
  activeTab: { id: 'task-1', kind: 'task' as const, title: 'Task', contentRoute: '/' },
  openTab: mocks.openTab,
  selectTab: mocks.selectTab,
  closeTab: mocks.closeTab,
  closeOtherTabs: vi.fn(),
  restoreClosedTab: vi.fn(),
  moveTab: vi.fn(),
  updateActiveTab: vi.fn(),
}

vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useOptionalWorkspaceTabs: () => workspaceTabs,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mocks.t,
  }),
}))

const installed: HarnessAppInstallation = {
  id: 'dsh-ops-text-classifier',
  manifest: {
    name: 'dsh-ops-text-classifier',
    displayName: 'DSH operations',
    version: '0.1.0-rc.7',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Classify operations text',
    entry: {
      installPackage: 'packages/bundle/ops-app',
      profile: 'ops',
      webUrl: 'http://127.0.0.1:3080/',
    },
    requirements: { dsh: '0.1.0-rc.7', node: '>=22' },
  },
  packagePath: '/tmp/package',
  sha256: 'hash',
  modelKey: 'wework:runtime:::local-model%3Amodel-1',
  runtimeVersion: null,
  state: 'installed',
  webUrl: null,
  error: null,
}

const running: HarnessAppInstallation = {
  ...installed,
  runtimeVersion: '0.1.0-rc.7',
  state: 'running',
  webUrl: 'http://127.0.0.1:39000/',
}

const preview: HarnessAppPreview = {
  valid: true,
  archivePath: '/tmp/dsh-ops-text-classifier.zip',
  sha256: 'preview-hash',
  manifest: installed.manifest,
  issues: [],
}

describe('HarnessAppsPage', () => {
  beforeEach(() => {
    Object.values(mocks.api).forEach(mock => mock.mockReset())
    mocks.closeTab.mockReset()
    mocks.openTab.mockReset()
    mocks.register.mockReset()
    mocks.resolveLaunch.mockReset()
    mocks.selectTab.mockReset()
    mocks.unregister.mockReset()
    mocks.unregisterProxy.mockReset()
    sessionStorage.clear()
    workspaceTabs.tabs = []
    mocks.api.stop.mockResolvedValue(undefined)
    mocks.resolveLaunch.mockResolvedValue({
      modelId: 'wework-selected',
      env: {},
      proxyToken: 'proxy-token',
      baseUrl: 'http://127.0.0.1:41000/v1/harness-router/proxy-token',
    })
  })

  test('restores running Harness app registrations after a frontend reload', async () => {
    mocks.api.list.mockResolvedValue([running])

    render(<HarnessAppsPage />)

    await screen.findByTestId(`harness-app-stop-${running.id}`)
    expect(mocks.register).toHaveBeenCalledWith(running)
  })

  test('starts an installed app, stores its proxy token, and opens one app tab', async () => {
    mocks.api.list.mockResolvedValue([installed])
    mocks.api.start.mockResolvedValue(running)

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-start-${installed.id}`))

    await waitFor(() => {
      expect(mocks.api.start).toHaveBeenCalledWith(
        installed.id,
        'http://127.0.0.1:41000/v1/harness-router/proxy-token'
      )
    })
    expect(sessionStorage.getItem(`wework:harness-app:${installed.id}:proxy-token`)).toBe(
      'proxy-token'
    )
    expect(mocks.register).toHaveBeenCalledWith(running)
    expect(mocks.openTab).toHaveBeenCalledWith('auxiliary', {
      title: running.manifest.displayName,
      contentRoute: `/app/harness-${running.id}`,
    })
  })

  test('rolls back a started app when the post-start refresh fails', async () => {
    mocks.api.list
      .mockResolvedValueOnce([installed])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([installed])
    mocks.api.start.mockResolvedValue(running)

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-start-${installed.id}`))

    await waitFor(() => expect(mocks.api.stop).toHaveBeenCalledWith(installed.id))
    expect(mocks.unregister).toHaveBeenCalledWith(installed.id)
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(sessionStorage.getItem(`wework:harness-app:${installed.id}:proxy-token`)).toBeNull()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  test('preserves the model proxy when a started app cannot be rolled back', async () => {
    mocks.api.list
      .mockResolvedValueOnce([installed])
      .mockRejectedValueOnce(new Error('refresh failed'))
    mocks.api.start.mockResolvedValue(running)
    mocks.api.stop.mockRejectedValue(new Error('stop failed'))

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-start-${installed.id}`))

    await waitFor(() => expect(mocks.api.stop).toHaveBeenCalledWith(installed.id))
    expect(mocks.unregister).not.toHaveBeenCalled()
    expect(mocks.unregisterProxy).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(`wework:harness-app:${installed.id}:proxy-token`)).toBe(
      'proxy-token'
    )
  })

  test('clears an old preview when replacement package inspection fails', async () => {
    mocks.api.list.mockResolvedValue([])
    mocks.api.preview
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new Error('invalid replacement'))

    render(<HarnessAppsPage />)
    const dropZone = await screen.findByTestId('harness-app-drop-zone')
    const dropPackage = (path: string) =>
      fireEvent.drop(dropZone, {
        dataTransfer: {
          getData: () => `file://${path}`,
        },
      })

    dropPackage('/tmp/dsh-ops-text-classifier.zip')
    expect(await screen.findByTestId('harness-app-preview')).toBeInTheDocument()

    dropPackage('/tmp/invalid-replacement.zip')
    await waitFor(() => expect(screen.queryByTestId('harness-app-preview')).not.toBeInTheDocument())
    expect(await screen.findByTestId('harness-app-error')).toHaveTextContent('invalid replacement')
  })

  test('stops an app, unregisters its model proxy, and closes stale tabs', async () => {
    const route = `/app/harness-${running.id}`
    workspaceTabs.tabs = [
      {
        id: 'harness-tab',
        kind: 'auxiliary',
        title: running.manifest.displayName,
        contentRoute: route,
      },
    ]
    sessionStorage.setItem(`wework:harness-app:${running.id}:proxy-token`, 'proxy-token')
    mocks.api.list.mockResolvedValue([running])

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-stop-${running.id}`))

    await waitFor(() => expect(mocks.api.stop).toHaveBeenCalledWith(running.id))
    expect(mocks.unregister).toHaveBeenCalledWith(running.id)
    expect(mocks.closeTab).toHaveBeenCalledWith('harness-tab')
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(sessionStorage.getItem(`wework:harness-app:${running.id}:proxy-token`)).toBeNull()
  })

  test('closes a mounted app surface after its tab route has changed', async () => {
    workspaceTabs.tabs = [
      {
        id: 'harness-tab',
        kind: 'auxiliary',
        title: running.manifest.displayName,
        contentRoute: '/harness-apps',
      },
    ]
    mocks.api.list.mockResolvedValue([running])
    const mountedSurface = document.createElement('div')
    mountedSurface.dataset.testid = `app-iframe-harness-${running.id}`
    mountedSurface.dataset.workspaceTabId = 'harness-tab'
    document.body.appendChild(mountedSurface)

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-stop-${running.id}`))

    await waitFor(() => expect(mocks.api.stop).toHaveBeenCalledWith(running.id))
    expect(mocks.closeTab).toHaveBeenCalledWith('harness-tab')
  })
})
