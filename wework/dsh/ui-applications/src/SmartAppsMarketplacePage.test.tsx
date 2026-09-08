import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import type { UnifiedModel } from '@/types/api'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'

const trackMock = vi.hoisted(() => vi.fn())
const navigateTo = vi.fn()
const queuePluginReferenceTrial = vi.fn()
const queueSmartAppDevelopmentPreview = vi.fn()
const ensureBundledPluginInstalled = vi.fn()
const listInstalled = vi.fn()
const downloadPackage = vi.fn()
const installPackage = vi.fn()
const previewPackage = vi.fn()
const invokeDesktopHost = vi.fn()
const deleteInstalled = vi.fn()
const stopInstalled = vi.fn()
const updateInstalled = vi.fn()
const exportToDownloads = vi.fn()
const addPlugin = vi.fn()
const createDirectory = vi.fn()
const linkDirectory = vi.fn()
const copyToDirectory = vi.fn()
const revealLocalFile = vi.fn()
const getLocalExecutorDeviceId = vi.fn()

vi.mock('@/hooks/useTranslation', () => {
  const translate = (_key: string, fallback?: string) => fallback ?? _key
  return { useTranslation: () => ({ t: translate }) }
})
vi.mock('@/lib/navigation', () => ({ navigateTo: (path: string) => navigateTo(path) }))
vi.mock('@/lib/local-terminal', () => ({
  getLocalExecutorDeviceId: () => getLocalExecutorDeviceId(),
  revealLocalFile: (path: string) => revealLocalFile(path),
}))
vi.mock('@/features/plugins/pluginTrial', () => ({
  queuePluginReferenceTrial: (options: unknown) => queuePluginReferenceTrial(options),
}))
vi.mock('@/features/harness-apps/smartAppDevelopmentPreview', () => ({
  queueSmartAppDevelopmentPreview: (options: unknown) => queueSmartAppDevelopmentPreview(options),
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureBundledPluginInstalled: (name: string) => ensureBundledPluginInstalled(name),
}))
vi.mock('@/telemetry/client', () => ({ track: trackMock }))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => invokeDesktopHost(...args),
}))

const harnessModel: UnifiedModel = {
  name: 'local-model:model-1',
  type: 'runtime',
  provider: 'local',
  displayName: 'Local Model',
  modelId: 'local-upstream',
  config: { weworkModelKind: 'model-interface' },
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: [harnessModel] },
    services: { localHarnessModelApi: null },
  }),
}))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', async importOriginal => {
  const original =
    await importOriginal<typeof import('@/features/workspace-tabs/workspaceTabsContextValue')>()
  return {
    ...original,
    useWorkspaceTabs: () => ({
      tabs: [],
      openTab: vi.fn(),
      closeTab: vi.fn(),
    }),
  }
})
vi.mock('@/features/harness-apps/harnessAppTabs', () => ({
  harnessAppRoute: (id: string) => `/app/harness-${id}`,
  openHarnessAppTab: vi.fn(),
  registerHarnessAppTab: vi.fn(),
  takeHarnessAppContextToken: vi.fn().mockResolvedValue(null),
  takeHarnessAppProxyToken: vi.fn().mockResolvedValue(null),
  unregisterHarnessAppTab: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    list: () => listInstalled(),
    download: (value: unknown) => downloadPackage(value),
    preview: (path: string) => previewPackage(path),
    install: (...args: unknown[]) => installPackage(...args),
    delete: (id: string) => deleteInstalled(id),
    stop: (id: string) => stopInstalled(id),
    update: (id: string, updates: unknown) => updateInstalled(id, updates),
    exportToDownloads: (id: string) => exportToDownloads(id),
    addPlugin: (id: string, spec: string) => addPlugin(id, spec),
    createDirectory: (input: unknown) => createDirectory(input),
    linkDirectory: (path: string) => linkDirectory(path),
    copyToDirectory: (id: string, input: unknown) => copyToDirectory(id, input),
  },
}))

function item(overrides: Partial<SmartAppMarketplaceItem> = {}): SmartAppMarketplaceItem {
  return {
    id: 7,
    name: 'research-desk',
    displayName: '研究工作台',
    summary: '整理本地研究资料',
    descriptionMd: '# 研究工作台',
    sourceType: 'official',
    ownerUserId: 0,
    ownerDisplayName: 'Wework',
    accessRole: 'official',
    visibility: 'public',
    tags: ['data_analysis'],
    iconUrl: '',
    screenshotUrls: [],
    featured: true,
    latestReleaseId: 17,
    version: '1.2.0',
    releaseNotes: 'New release',
    sizeBytes: 1024,
    requirements: {},
    extensions: {},
    releaseExtensions: {},
    scanStatus: 'passed',
    updatedAt: '2026-08-20T00:00:00Z',
    publishedAt: '2026-08-20T00:00:00Z',
    ...overrides,
  }
}

function api(items: SmartAppMarketplaceItem[] = [item()]): SmartAppsApi {
  return {
    listMarketplace: vi.fn().mockResolvedValue({ items }),
    listOwned: vi.fn().mockResolvedValue({ items }),
    listTags: vi.fn().mockResolvedValue({ version: 1, items: [] }),
    getDownload: vi.fn().mockResolvedValue({
      smartAppId: 7,
      releaseId: 17,
      version: '1.2.0',
      filename: 'research.zip',
      downloadUrl: 'https://download.test/research.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      expiresAt: '2026-08-20T00:10:00Z',
    }),
    getItem: vi.fn(),
    getAccess: vi.fn(),
    updateAccess: vi.fn(),
    searchUsers: vi.fn(),
    searchGroups: vi.fn(),
    initSubmission: vi.fn(),
    completeSubmission: vi.fn(),
    cancelSubmission: vi.fn(),
    publish: vi.fn(),
  }
}

const importedInstallation = {
  id: 'research-desk',
  manifest: {
    name: 'research-desk',
    displayName: '研究工作台',
    version: '1.2.0',
    type: 'deepseek-harness-plugin-bundle' as const,
    description: '整理本地研究资料',
    entry: {
      installPackage: 'packages/research-desk',
      profile: 'research',
    },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
  },
  packagePath: '/tmp/research-desk',
  sha256: 'a'.repeat(64),
  modelKey: null,
  resident: false,
  runtimeVersion: null,
  state: 'installed' as const,
  webUrl: null,
  error: null,
  source: 'managed' as const,
}

describe('SmartAppsMarketplacePage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    trackMock.mockReset()
    navigateTo.mockReset()
    queuePluginReferenceTrial.mockReset().mockReturnValue(true)
    queueSmartAppDevelopmentPreview.mockReset()
    ensureBundledPluginInstalled.mockReset().mockResolvedValue(undefined)
    listInstalled.mockReset().mockResolvedValue([])
    deleteInstalled.mockReset().mockResolvedValue(undefined)
    stopInstalled.mockReset().mockResolvedValue(undefined)
    updateInstalled.mockReset()
    exportToDownloads.mockReset().mockResolvedValue({
      archivePath: '/tmp/research-desk.zip',
      destinationPath: '/Downloads/research-desk-1.2.0.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      manifest: importedInstallation.manifest,
    })
    addPlugin.mockReset().mockResolvedValue(importedInstallation)
    getLocalExecutorDeviceId.mockReset().mockResolvedValue('local-device-1')
    downloadPackage.mockReset().mockResolvedValue({
      valid: true,
      archivePath: '/tmp/research.zip',
      sha256: 'a'.repeat(64),
      manifest: importedInstallation.manifest,
      issues: [],
    })
    installPackage.mockReset().mockResolvedValue(importedInstallation)
    previewPackage.mockReset()
    invokeDesktopHost.mockReset()
    createDirectory.mockReset().mockResolvedValue({
      ...importedInstallation,
      id: 'blank-workbench',
      packagePath: '/tmp/blank-workbench',
      source: 'linked',
      manifest: {
        ...importedInstallation.manifest,
        name: 'blank-workbench',
        displayName: '空白工作台',
      },
    })
    linkDirectory.mockReset()
    copyToDirectory.mockReset()
    revealLocalFile.mockReset().mockResolvedValue(undefined)
  })

  test('shows official, public, and shared marketplace metadata', async () => {
    render(
      <SmartAppsMarketplacePage
        api={api([
          item(),
          item({
            id: 8,
            sourceType: 'user',
            ownerDisplayName: 'Alice',
            accessRole: 'recipient',
            visibility: 'restricted',
          }),
          item({
            id: 9,
            sourceType: 'user',
            ownerDisplayName: 'Bob',
            accessRole: 'public',
          }),
          item({
            id: 10,
            sourceType: 'user',
            ownerDisplayName: 'Current user',
            accessRole: 'owner',
          }),
        ])}
      />
    )

    expect(await screen.findAllByText('研究工作台')).toHaveLength(4)
    expect(screen.getByText('官方')).toBeInTheDocument()
    expect(screen.getByText('我发布的')).toBeInTheDocument()
    expect(screen.getAllByText('分享给我')).toHaveLength(2)
    expect(screen.getAllByText('全员应用')).toHaveLength(2)
    expect(screen.getByTestId('smart-apps-marketplace-sort')).toHaveValue('recommended')
    expect(screen.queryByText('智能工作台市场')).not.toBeInTheDocument()
    expect(
      screen.queryByText('发现官方工作台，以及成员定向分享给你的工作台。')
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('smart-apps-created-create')).not.toBeInTheDocument()
    expect(screen.queryByTestId('smart-apps-import-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('applications-context-toolbar')).toHaveClass('md:h-9')
    expect(screen.getByTestId('smart-app-marketplace-item-7')).toHaveClass('min-h-52')
  })

  test('merges local installation and exposes a manual update', async () => {
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        id: 'market-7',
        smartAppId: 7,
        releaseId: 16,
        modelKey: 'model-a',
      },
    ])
    render(<SmartAppsMarketplacePage api={api()} />)

    expect(await screen.findByRole('button', { name: /更新/ })).toBeInTheDocument()
  })

  test('downloads an authorized package from the detail view', async () => {
    const smartAppsApi = api()
    render(<SmartAppsMarketplacePage api={smartAppsApi} />)

    fireEvent.click(await screen.findByText('研究工作台'))
    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }))

    await waitFor(() => expect(smartAppsApi.getDownload).toHaveBeenCalledWith(7))
    expect(downloadPackage).toHaveBeenCalledWith(expect.objectContaining({ smartAppId: 7 }))
  })

  test('tracks a marketplace installation only after the installation succeeds', async () => {
    let resolveInstallation: (installation: typeof importedInstallation) => void = () => undefined
    const installationPromise = new Promise<typeof importedInstallation>(resolve => {
      resolveInstallation = resolve
    })
    installPackage.mockReturnValueOnce(installationPromise)
    render(<SmartAppsMarketplacePage api={api()} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    await screen.findByTestId('harness-app-install-confirm')
    expect(trackMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('harness-app-install-confirm'))

    await waitFor(() => expect(installPackage).toHaveBeenCalledOnce())
    expect(trackMock).not.toHaveBeenCalled()
    resolveInstallation(importedInstallation)
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('smart_app_installed', {
        domain: 'smart_app',
        install_source: 'marketplace',
      })
    )
    expect(trackMock).toHaveBeenCalledTimes(1)
  })

  test('tracks a marketplace update without counting it as an installation', async () => {
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        id: 'market-7',
        smartAppId: 7,
        releaseId: 16,
      },
    ])
    const updatedInstallation = {
      ...importedInstallation,
      id: 'market-7',
      smartAppId: 7,
      releaseId: 17,
    }
    let resolveInstallation: (installation: typeof updatedInstallation) => void = () => undefined
    const installationPromise = new Promise<typeof updatedInstallation>(resolve => {
      resolveInstallation = resolve
    })
    installPackage.mockReturnValueOnce(installationPromise)
    render(<SmartAppsMarketplacePage api={api()} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    fireEvent.click(await screen.findByTestId('harness-app-install-confirm'))

    await waitFor(() => expect(installPackage).toHaveBeenCalledOnce())
    expect(trackMock).not.toHaveBeenCalled()
    resolveInstallation(updatedInstallation)
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('feature_action_completed', {
        domain: 'smart_app',
        action: 'update',
      })
    )
    expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
  })

  test('tracks a ZIP import only after preview and installation succeed', async () => {
    invokeDesktopHost.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/private-workbench.zip'],
    })
    previewPackage.mockResolvedValue({
      valid: true,
      archivePath: '/tmp/private-workbench.zip',
      sha256: 'a'.repeat(64),
      manifest: importedInstallation.manifest,
      issues: [],
    })
    let resolveInstallation: (installation: typeof importedInstallation) => void = () => undefined
    const installationPromise = new Promise<typeof importedInstallation>(resolve => {
      resolveInstallation = resolve
    })
    installPackage.mockReturnValueOnce(installationPromise)
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-apps-import-button'))

    await waitFor(() => expect(installPackage).toHaveBeenCalledOnce())
    expect(trackMock).not.toHaveBeenCalled()
    resolveInstallation(importedInstallation)
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('smart_app_installed', {
        domain: 'smart_app',
        install_source: 'zip_import',
      })
    )
    expect(trackMock.mock.calls.flat()).not.toContain('/tmp/private-workbench.zip')
  })

  test('tracks a marketplace download failure without an installation event', async () => {
    const smartAppsApi = api()
    vi.mocked(smartAppsApi.getDownload).mockRejectedValue(new Error('private download failure'))
    render(<SmartAppsMarketplacePage api={smartAppsApi} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('operation_failed', {
        domain: 'smart_app',
        operation: 'smart_app_marketplace_download',
      })
    )
    expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
  })

  test('tracks a marketplace installation failure without an installation event', async () => {
    installPackage.mockRejectedValue(new Error('private installation failure'))
    render(<SmartAppsMarketplacePage api={api()} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    fireEvent.click(await screen.findByTestId('harness-app-install-confirm'))

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('operation_failed', {
        domain: 'smart_app',
        operation: 'smart_app_marketplace_install',
      })
    )
    expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
  })

  test('tracks a marketplace update failure without an installation event', async () => {
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        id: 'market-7',
        smartAppId: 7,
        releaseId: 16,
      },
    ])
    installPackage.mockRejectedValue(new Error('private update failure'))
    render(<SmartAppsMarketplacePage api={api()} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    fireEvent.click(await screen.findByTestId('harness-app-install-confirm'))

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('operation_failed', {
        domain: 'smart_app',
        operation: 'smart_app_marketplace_update',
      })
    )
    expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
  })

  test('tracks an invalid ZIP import without an installation event', async () => {
    invokeDesktopHost.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/private-workbench.zip'],
    })
    previewPackage.mockResolvedValue({
      valid: false,
      archivePath: '/tmp/private-workbench.zip',
      sha256: 'a'.repeat(64),
      manifest: null,
      issues: ['private validation detail'],
    })
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-apps-import-button'))

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('operation_failed', {
        domain: 'smart_app',
        operation: 'smart_app_zip_import',
      })
    )
    expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
    expect(trackMock.mock.calls.flat()).not.toContain('private validation detail')
  })

  test('does not track when ZIP selection is cancelled', async () => {
    invokeDesktopHost.mockResolvedValue({ canceled: true, filePaths: [] })
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-apps-import-button'))

    await waitFor(() => expect(invokeDesktopHost).toHaveBeenCalledOnce())
    expect(trackMock).not.toHaveBeenCalled()
  })

  test('structures long marketplace details for scanning and fixed actions', async () => {
    render(
      <SmartAppsMarketplacePage
        api={api([
          item({
            descriptionMd:
              '# 研究工作台\n\n面向现场演示的资料处理应用。\n\n## 主要能力\n\n- 自动整理资料\n- 生成研究摘要',
          }),
        ])}
      />
    )

    fireEvent.click(await screen.findByText('研究工作台'))

    const dialog = screen.getByRole('dialog')
    const content = within(dialog).getByTestId('smart-app-details-content')
    expect(dialog).toHaveClass('flex', 'overflow-hidden')
    expect(content).toHaveClass('overflow-y-auto')
    expect(within(dialog).getAllByText('研究工作台')).toHaveLength(1)
    expect(within(dialog).getByRole('heading', { name: '主要能力' })).toBeInTheDocument()
    expect(within(content).getByRole('list')).toHaveClass('list-disc')
    expect(within(dialog).getByTestId('smart-app-details-footer')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
  })

  test('combines created and installed apps under My', async () => {
    listInstalled.mockResolvedValue([
      importedInstallation,
      {
        ...importedInstallation,
        id: 'market-7',
        smartAppId: 7,
        releaseId: 17,
      },
    ])
    render(<SmartAppsMarketplacePage api={api([item({ accessRole: 'owner' })])} mode="owned" />)

    expect(screen.getByTestId('smart-apps-section-owned')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('heading', { name: '我的工作台' })).not.toBeInTheDocument()
    expect(screen.getByTestId('smart-apps-created-create')).toHaveTextContent('创建工作台')
    expect(
      screen.getByTestId('smart-apps-created-create').querySelector('.lucide-circle-plus')
    ).toBeInTheDocument()
    expect(screen.getByTestId('smart-apps-import-button')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('smart-apps-owned-filter-all')).toHaveTextContent('2')
    )
    expect(screen.getByTestId('smart-apps-owned-filter-created')).toBeInTheDocument()
    expect(screen.getByTestId('smart-apps-owned-filter-installed')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /管理范围/ })).toHaveLength(2)
    expect(screen.getByTestId('smart-app-created-item-research-desk-state')).toHaveClass(
      'text-success'
    )
    expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveClass('min-h-52')
    expect(screen.getByTestId('smart-app-created-item-research-desk')).not.toHaveClass('min-h-64')
  })

  test('identifies a folder-linked workbench separately from an imported package', async () => {
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        id: 'linked-workbench',
        source: 'linked',
      },
    ])
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    expect(await screen.findByText('关联文件夹')).toBeInTheDocument()
    expect(screen.queryByText('本地导入')).not.toBeInTheDocument()
  })

  test('exports a created or imported installation package to Downloads', async () => {
    listInstalled.mockResolvedValue([importedInstallation])
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-actions-${importedInstallation.id}`))
    fireEvent.pointerDown(screen.getByTestId(`smart-app-export-package-${importedInstallation.id}`))

    await waitFor(() => expect(exportToDownloads).toHaveBeenCalledWith(importedInstallation.id))
    expect(screen.getByTestId('smart-app-export-success')).toHaveTextContent(
      '安装包已导出到下载目录。'
    )
  })

  test('keeps the card available when installation package export fails', async () => {
    listInstalled.mockResolvedValue([importedInstallation])
    exportToDownloads.mockRejectedValueOnce(new Error('Downloads unavailable'))
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-actions-${importedInstallation.id}`))
    fireEvent.pointerDown(screen.getByTestId(`smart-app-export-package-${importedInstallation.id}`))

    expect(await screen.findByRole('alert')).toHaveTextContent('Downloads unavailable')
    expect(
      screen.getByTestId(`smart-app-created-item-${importedInstallation.id}`)
    ).toBeInTheDocument()
  })

  test('refreshes local runtime state when returning to Smart apps', async () => {
    listInstalled.mockResolvedValueOnce([importedInstallation]).mockResolvedValue([
      {
        ...importedInstallation,
        state: 'running',
        webUrl: 'http://127.0.0.1:3080',
      },
    ])
    window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    expect(await screen.findByTestId('harness-app-start-research-desk')).toBeInTheDocument()
    window.dispatchEvent(new PopStateEvent('popstate'))

    expect(await screen.findByTestId('harness-app-open-research-desk')).toBeInTheDocument()
  })

  test('does not replace marketplace results when an owned-page stop finishes late', async () => {
    const ownedItem = item({
      id: 8,
      name: 'owned-desk',
      displayName: '我的工作台',
      sourceType: 'user',
      accessRole: 'owner',
    })
    const marketplaceItem = item({
      id: 7,
      name: 'official-desk',
      displayName: '官方工作台',
    })
    const smartAppsApi = api()
    vi.mocked(smartAppsApi.listOwned).mockResolvedValue({ items: [ownedItem] })
    vi.mocked(smartAppsApi.listMarketplace).mockResolvedValue({ items: [marketplaceItem] })
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        id: 'owned-installation',
        smartAppId: 8,
        state: 'running',
        webUrl: 'http://127.0.0.1:3080',
      },
    ])
    let resolveStop: () => void = () => undefined
    stopInstalled.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveStop = resolve
      })
    )
    const { rerender } = render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-app-actions-owned-installation'))
    fireEvent.pointerDown(screen.getByTestId('smart-app-stop-menu-owned-installation'))
    await waitFor(() => expect(stopInstalled).toHaveBeenCalledWith('owned-installation'))

    rerender(<SmartAppsMarketplacePage api={smartAppsApi} mode="marketplace" />)
    expect(await screen.findByTestId('smart-app-marketplace-item-7')).toBeInTheDocument()

    await act(async () => resolveStop())

    expect(smartAppsApi.listOwned).toHaveBeenCalledTimes(1)
    expect(smartAppsApi.listMarketplace).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('smart-app-marketplace-item-7')).toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-marketplace-item-8')).not.toBeInTheDocument()
  })

  test('allows plugin and source development while a linked workbench is running', async () => {
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        source: 'linked',
        state: 'running',
        webUrl: 'http://127.0.0.1:3080',
      },
    ])
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-actions-${importedInstallation.id}`))

    expect(screen.getByTestId(`smart-app-change-model-${importedInstallation.id}`)).toBeDisabled()
    expect(screen.getByTestId(`smart-app-add-plugins-${importedInstallation.id}`)).toBeEnabled()
    expect(screen.getByTestId(`smart-app-develop-${importedInstallation.id}`)).toBeEnabled()

    fireEvent.pointerDown(screen.getByTestId(`smart-app-add-plugins-${importedInstallation.id}`))
    expect(screen.getByTestId('smart-app-plugin-dialog')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('smart-app-plugin-spec-input'), {
      target: { value: '@scope/dsh-plugin' },
    })
    fireEvent.click(screen.getByTestId('smart-app-plugin-confirm'))

    await waitFor(() =>
      expect(addPlugin).toHaveBeenCalledWith(importedInstallation.id, '@scope/dsh-plugin')
    )
    expect(stopInstalled).toHaveBeenCalledWith(importedInstallation.id)
  })

  test('fully removes an imported app card while preserving its published cloud version', async () => {
    const publishedImport = {
      ...importedInstallation,
      id: 'published-import',
      smartAppId: 7,
      releaseId: 17,
    }
    let resolveStaleRefresh: (items: (typeof publishedImport)[]) => void = () => undefined
    const staleRefresh = new Promise<(typeof publishedImport)[]>(resolve => {
      resolveStaleRefresh = resolve
    })
    let resolveDelete: () => void = () => undefined
    const pendingRemoval = new Promise<void>(resolve => {
      resolveDelete = resolve
    })
    listInstalled
      .mockResolvedValueOnce([publishedImport])
      .mockReturnValueOnce(staleRefresh)
      .mockResolvedValue([])
    deleteInstalled.mockReturnValueOnce(pendingRemoval)
    window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
    const initialApi = api([item({ accessRole: 'owner' })])
    const refreshedApi = api([item({ accessRole: 'owner' })])
    const { rerender } = render(<SmartAppsMarketplacePage api={initialApi} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-actions-${publishedImport.id}`))
    fireEvent.pointerDown(screen.getByTestId(`smart-app-remove-local-${publishedImport.id}`))

    expect(screen.getByRole('dialog', { name: '从本机移除工作台？' })).toHaveTextContent(
      '已发布版本和分享范围不会受到影响'
    )
    fireEvent.click(screen.getByTestId('smart-app-remove-local-confirm'))

    await waitFor(() => expect(deleteInstalled).toHaveBeenCalledWith(publishedImport.id))
    expect(screen.queryByText('研究工作台')).not.toBeInTheDocument()
    rerender(<SmartAppsMarketplacePage api={refreshedApi} mode="owned" />)
    await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(2))
    await act(async () => resolveDelete())
    await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByText('研究工作台')).not.toBeInTheDocument())
    await act(async () => resolveStaleRefresh([publishedImport]))
    expect(screen.queryByTestId('smart-app-owned-item-7')).not.toBeInTheDocument()
    expect(screen.queryByText('研究工作台')).not.toBeInTheDocument()
  })

  test('keeps a marketplace card visible as uninstalled after removing its local copy', async () => {
    const marketplaceInstallation = {
      ...importedInstallation,
      id: 'market-7',
      smartAppId: 7,
      releaseId: 17,
    }
    listInstalled.mockResolvedValueOnce([marketplaceInstallation]).mockResolvedValue([])
    render(<SmartAppsMarketplacePage api={api()} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-actions-7'))
    fireEvent.pointerDown(screen.getByTestId('smart-app-remove-local-market-7'))
    fireEvent.click(screen.getByTestId('smart-app-remove-local-confirm'))

    await waitFor(() => expect(deleteInstalled).toHaveBeenCalledWith(marketplaceInstallation.id))
    expect(screen.getByTestId('smart-app-marketplace-item-7')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('smart-app-marketplace-item-7-state')).toHaveTextContent('未安装')
    )
  })

  test('removes an imported card from every mounted My view', async () => {
    const duplicatedImport = { ...importedInstallation, id: 'multi-view-import' }
    listInstalled.mockResolvedValue([duplicatedImport])
    const smartAppsApi = api([])
    render(
      <>
        <SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />
        <SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />
      </>
    )

    await waitFor(() =>
      expect(screen.getAllByTestId('smart-app-created-item-multi-view-import')).toHaveLength(2)
    )
    fireEvent.click(screen.getAllByTestId('smart-app-actions-multi-view-import')[0])
    fireEvent.pointerDown(screen.getByTestId('smart-app-remove-local-multi-view-import'))
    fireEvent.click(screen.getByTestId('smart-app-remove-local-confirm'))

    await waitFor(() =>
      expect(screen.queryAllByTestId('smart-app-created-item-multi-view-import')).toHaveLength(0)
    )
  })

  test('publishes an imported app with localized file pickers and sharing targets', async () => {
    listInstalled.mockResolvedValue([importedInstallation])
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-app-created-publish-research-desk'))

    expect(screen.getAllByText('选择文件')).toHaveLength(2)
    expect(screen.getAllByText('未选择文件')).toHaveLength(2)
    expect(screen.getByText('发布范围')).toBeInTheDocument()
    expect(screen.getByTestId('smart-app-target-search')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('smart-app-publish-scope-public'))
    expect(screen.queryByTestId('smart-app-target-search')).not.toBeInTheDocument()
    expect(
      screen.getByText('发布成功后立即上架到智能应用市场，所有成员均可查看和安装。')
    ).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('smart-app-publish-icon'), {
      target: { files: [new File(['icon'], '应用图标.png', { type: 'image/png' })] },
    })
    fireEvent.change(screen.getByTestId('smart-app-publish-screenshots'), {
      target: {
        files: [
          new File(['one'], '截图一.png', { type: 'image/png' }),
          new File(['two'], '截图二.png', { type: 'image/png' }),
        ],
      },
    })

    expect(screen.getByText('应用图标.png')).toBeInTheDocument()
    expect(screen.getByText('已选择 2 个文件')).toBeInTheDocument()
  })

  test('switches an owned app to everyone without sharing targets', async () => {
    const ownedItem = item({
      sourceType: 'user',
      ownerUserId: 1,
      ownerDisplayName: 'Alice',
      accessRole: 'owner',
      visibility: 'restricted',
    })
    const smartAppsApi = api([ownedItem])
    vi.mocked(smartAppsApi.getAccess).mockResolvedValue({
      smartAppId: ownedItem.id,
      scope: 'restricted',
      targets: [{ entityType: 'user', entityId: '2', displayName: 'Bob' }],
      isListed: true,
      latestReleaseId: ownedItem.latestReleaseId,
      version: ownedItem.version,
    })
    vi.mocked(smartAppsApi.updateAccess).mockResolvedValue({
      smartAppId: ownedItem.id,
      scope: 'public',
      targets: [],
      isListed: true,
      latestReleaseId: ownedItem.latestReleaseId,
      version: ownedItem.version,
    })
    listInstalled.mockResolvedValue([{ ...importedInstallation, smartAppId: ownedItem.id }])

    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-visibility-${ownedItem.id}`))
    await screen.findByTestId('smart-app-share-dialog')
    fireEvent.click(screen.getByTestId('smart-app-share-scope-public'))
    expect(screen.queryByTestId('smart-app-target-search')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        '将当前已发布版本 v1.2.0 上架到智能应用市场，所有成员均可查看和安装。本地后续修改不会自动同步，需发布新版本。'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('smart-app-share-save'))

    await waitFor(() =>
      expect(smartAppsApi.updateAccess).toHaveBeenCalledWith(ownedItem.id, {
        scope: 'public',
        targets: [],
      })
    )
    expect(screen.getByTestId('smart-app-access-success')).toHaveTextContent(
      'v1.2.0 已上架到智能应用市场。'
    )
    const viewMarketplaceButton = screen.getByTestId('smart-app-access-view-marketplace')
    expect(viewMarketplaceButton).toHaveClass('border-success/30', 'bg-background', 'shadow-sm')
    fireEvent.click(viewMarketplaceButton)
    expect(navigateTo).toHaveBeenCalledWith('/sites?app_type=smart_app')
    expect(screen.queryByTestId('smart-app-access-success')).not.toBeInTheDocument()
  })

  test('reports when an administrator has unlisted a public app', async () => {
    const ownedItem = item({
      sourceType: 'user',
      ownerUserId: 1,
      ownerDisplayName: 'Alice',
      accessRole: 'owner',
      visibility: 'restricted',
    })
    const smartAppsApi = api([ownedItem])
    vi.mocked(smartAppsApi.getAccess).mockResolvedValue({
      smartAppId: ownedItem.id,
      scope: 'restricted',
      targets: [{ entityType: 'user', entityId: '2', displayName: 'Bob' }],
      isListed: false,
      latestReleaseId: ownedItem.latestReleaseId,
      version: ownedItem.version,
    })
    vi.mocked(smartAppsApi.updateAccess).mockResolvedValue({
      smartAppId: ownedItem.id,
      scope: 'public',
      targets: [],
      isListed: false,
      latestReleaseId: ownedItem.latestReleaseId,
      version: ownedItem.version,
    })
    listInstalled.mockResolvedValue([{ ...importedInstallation, smartAppId: ownedItem.id }])

    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-visibility-${ownedItem.id}`))
    await screen.findByTestId('smart-app-share-dialog')
    fireEvent.click(screen.getByTestId('smart-app-share-scope-public'))
    fireEvent.click(screen.getByTestId('smart-app-share-save'))

    expect(await screen.findByTestId('smart-app-access-success')).toHaveTextContent(
      '已发布给全员，但当前已被管理员下架。'
    )
    expect(screen.queryByTestId('smart-app-access-view-marketplace')).not.toBeInTheDocument()
  })

  test('localizes an unavailable marketplace file store', async () => {
    const smartAppsApi = api()
    vi.mocked(smartAppsApi.listMarketplace).mockRejectedValue(
      new ApiError('Smart app file storage is unavailable', 503, 'smart_app_storage_unavailable')
    )

    render(<SmartAppsMarketplacePage api={smartAppsApi} />)

    expect(await screen.findByText('文件存储服务暂不可用，请稍后重试')).toBeInTheDocument()
  })

  test('queues the development preview after creating a blank workbench', async () => {
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-name'), {
      target: { value: 'blank-workbench' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-parent-path'), {
      target: { value: '/tmp' },
    })
    expect(screen.getByTestId('smart-app-development-template-web')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(screen.getByTestId('smart-app-development-template-web-host-remote'))
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    await waitFor(() =>
      expect(queueSmartAppDevelopmentPreview).toHaveBeenCalledWith({
        installationId: 'blank-workbench',
        displayName: '空白工作台',
      })
    )
    expect(queuePluginReferenceTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        openInNewChat: true,
        targetWorkspace: {
          deviceId: 'local-device-1',
          path: '/tmp/blank-workbench',
        },
      })
    )
    expect(createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'web-host-remote' })
    )
    expect(navigateTo).toHaveBeenCalledWith('/')
  })

  test('does not create a workbench directory without a local project device', async () => {
    getLocalExecutorDeviceId.mockResolvedValue(null)
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-name'), {
      target: { value: 'blank-workbench' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-parent-path'), {
      target: { value: '/tmp' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    expect(await screen.findByText('暂无可用本地设备')).toBeInTheDocument()
    expect(createDirectory).not.toHaveBeenCalled()
  })

  test('stays on my creations when the builder cannot install', async () => {
    ensureBundledPluginInstalled.mockRejectedValue(new Error('install failed'))
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-name'), {
      target: { value: 'blank-workbench' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-parent-path'), {
      target: { value: '/tmp' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    expect(await screen.findByText('智能工作台开发助手安装失败，请重试。')).toBeInTheDocument()
    expect(createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: '空白工作台',
        name: 'blank-workbench',
        parentPath: '/tmp',
      })
    )
    expect(queuePluginReferenceTrial).not.toHaveBeenCalled()
    expect(queueSmartAppDevelopmentPreview).not.toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  test('reports a failure to open an editable workbench folder', async () => {
    revealLocalFile.mockRejectedValue(new Error('open failed'))
    listInstalled.mockResolvedValue([
      {
        ...importedInstallation,
        source: 'linked',
      },
    ])
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-actions-${importedInstallation.id}`))
    fireEvent.pointerDown(screen.getByTestId(`smart-app-open-directory-${importedInstallation.id}`))

    expect(await screen.findByText('open failed')).toBeInTheDocument()
    expect(revealLocalFile).toHaveBeenCalledWith(importedInstallation.packagePath)
  })
})
