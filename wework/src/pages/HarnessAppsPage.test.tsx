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
    update: vi.fn(),
  },
  closeTab: vi.fn(),
  dialogOpen: vi.fn(),
  navigateTo: vi.fn(),
  openTab: vi.fn(),
  register: vi.fn(),
  resolveLaunch: vi.fn(),
  selectTab: vi.fn(),
  proxyTokens: new Map<string, string>(),
  t: vi.fn((_key: string, fallback?: string) => fallback ?? _key),
  unregister: vi.fn(),
  unregisterProxy: vi.fn(),
  unregisterContext: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: mocks.api,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.dialogOpen,
}))

vi.mock('@/components/layout/DesktopTopBar', () => ({
  DesktopTopBar: () => null,
}))

vi.mock('@/features/harness-apps/harnessAppTabs', async importOriginal => {
  const original = await importOriginal<typeof import('@/features/harness-apps/harnessAppTabs')>()
  return {
    ...original,
    registerHarnessAppTab: mocks.register,
    storeHarnessAppProxyToken: async (installationId: string, token: string) => {
      mocks.proxyTokens.set(installationId, token)
    },
    storeHarnessAppContextToken: async () => undefined,
    takeHarnessAppProxyToken: async (installationId: string) => {
      const token = mocks.proxyTokens.get(installationId) ?? null
      mocks.proxyTokens.delete(installationId)
      return token
    },
    takeHarnessAppContextToken: async () => null,
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

const secondModel: UnifiedModel = {
  ...model,
  name: 'local-model:model-2',
  displayName: 'Second Model',
  modelId: 'local-upstream-2',
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: [model, secondModel] },
    services: {
      localHarnessModelApi: {
        resolveLaunch: mocks.resolveLaunch,
        unregisterProxy: mocks.unregisterProxy,
        unregisterContext: mocks.unregisterContext,
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

vi.mock('@/lib/navigation', () => ({
  navigateTo: (path: string) => mocks.navigateTo(path),
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
  resident: false,
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
    mocks.dialogOpen.mockReset()
    mocks.navigateTo.mockReset()
    mocks.openTab.mockReset()
    mocks.register.mockReset()
    mocks.resolveLaunch.mockReset()
    mocks.selectTab.mockReset()
    mocks.unregister.mockReset()
    mocks.unregisterProxy.mockReset()
    mocks.proxyTokens.clear()
    workspaceTabs.tabs = []
    mocks.api.stop.mockResolvedValue(undefined)
    mocks.dialogOpen.mockResolvedValue('/tmp/dsh-ops-text-classifier.zip')
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

  test('opens package selection when the marketplace requests a local import', async () => {
    mocks.api.list.mockResolvedValue([])
    mocks.api.preview.mockResolvedValue(preview)

    render(<HarnessAppsPage importRequested />)

    await waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalledOnce())
    expect(mocks.navigateTo).toHaveBeenCalledWith('/sites?app_type=smart_app&view=installed')
    await waitFor(() =>
      expect(mocks.api.preview).toHaveBeenCalledWith('/tmp/dsh-ops-text-classifier.zip')
    )
    expect(await screen.findByTestId('harness-app-preview')).toBeInTheDocument()
  })

  test('starts an installed app, stores its proxy token, and opens one app tab', async () => {
    mocks.api.list.mockResolvedValue([installed])
    mocks.api.start.mockResolvedValue(running)

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-start-${installed.id}`))

    expect(mocks.openTab).toHaveBeenCalledWith('auxiliary', {
      title: installed.manifest.displayName,
      contentRoute: `/app/harness-${installed.id}`,
    })
    await waitFor(() => {
      expect(mocks.api.start).toHaveBeenCalledWith(
        installed.id,
        'http://127.0.0.1:41000/v1/harness-router/proxy-token'
      )
    })
    expect(mocks.proxyTokens.get(installed.id)).toBe('proxy-token')
    expect(mocks.register).toHaveBeenCalledWith(running)
    expect(mocks.openTab).toHaveBeenCalledTimes(1)
  })

  test('changes the model of an installed Smart app', async () => {
    const nextModelKey = 'wework:runtime:::local-model%3Amodel-2'
    const updated = { ...installed, modelKey: nextModelKey }
    mocks.api.list.mockResolvedValueOnce([installed]).mockResolvedValueOnce([updated])
    mocks.api.update.mockResolvedValue(updated)

    render(<HarnessAppsPage />)
    fireEvent.change(await screen.findByTestId(`harness-app-model-${installed.id}`), {
      target: { value: nextModelKey },
    })

    await waitFor(() =>
      expect(mocks.api.update).toHaveBeenCalledWith(installed.id, { modelKey: nextModelKey })
    )
    expect(await screen.findByTestId(`harness-app-model-${installed.id}`)).toHaveValue(nextModelKey)
  })

  test('toggles whether a Smart app stays resident across launches', async () => {
    const resident = { ...installed, resident: true }
    mocks.api.list.mockResolvedValueOnce([installed]).mockResolvedValueOnce([resident])
    mocks.api.update.mockResolvedValue(resident)

    render(<HarnessAppsPage />)
    const residentButton = await screen.findByTestId(`harness-app-resident-${installed.id}`)
    expect(residentButton).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(residentButton)

    await waitFor(() =>
      expect(mocks.api.update).toHaveBeenCalledWith(installed.id, { resident: true })
    )
    expect(await screen.findByTestId(`harness-app-resident-${installed.id}`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
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
    expect(mocks.proxyTokens.has(installed.id)).toBe(false)
    expect(mocks.openTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  test('preserves the model proxy when a started app cannot be rolled back', async () => {
    mocks.api.list
      .mockResolvedValueOnce([installed])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([running])
    mocks.api.start.mockResolvedValue(running)
    mocks.api.stop.mockRejectedValue(new Error('stop failed'))

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-start-${installed.id}`))

    await waitFor(() => expect(mocks.api.stop).toHaveBeenCalledWith(installed.id))
    expect(mocks.unregister).not.toHaveBeenCalled()
    expect(mocks.unregisterProxy).not.toHaveBeenCalled()
    expect(mocks.proxyTokens.get(installed.id)).toBe('proxy-token')
    expect(mocks.register).toHaveBeenCalledWith(running)
    expect(mocks.openTab).toHaveBeenCalledTimes(1)
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
    mocks.proxyTokens.set(running.id, 'proxy-token')
    mocks.api.list.mockResolvedValue([running])

    render(<HarnessAppsPage />)
    fireEvent.click(await screen.findByTestId(`harness-app-stop-${running.id}`))

    await waitFor(() => expect(mocks.api.stop).toHaveBeenCalledWith(running.id))
    expect(mocks.unregister).toHaveBeenCalledWith(running.id)
    expect(mocks.closeTab).toHaveBeenCalledWith('harness-tab')
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(mocks.proxyTokens.has(running.id)).toBe(false)
  })

  test('closes a mounted app surface after its tab route has changed', async () => {
    workspaceTabs.tabs = [
      {
        id: 'harness-tab',
        kind: 'auxiliary',
        title: running.manifest.displayName,
        contentRoute: '/sites?app_type=smart_app&view=installed',
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
