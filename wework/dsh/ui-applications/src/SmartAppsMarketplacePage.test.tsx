import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import {
  HARNESS_APP_INSTALLATIONS_CHANGED_EVENT,
  notifyHarnessAppInstallationsChanged,
} from '@/features/harness-apps/harnessAppInstallationsChanged'
import { openHarnessAppTab } from '@/features/harness-apps/harnessAppTabs'
import { localHarnessModelOptionKey } from '@/features/local-harness/localHarnessModels'
import type { UnifiedModel } from '@/types/api'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'

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
const exportPackage = vi.fn()
const verifyInstallation = vi.fn()
const uploadPackage = vi.fn()
const addPlugin = vi.fn()
const createDirectory = vi.fn()
const linkDirectory = vi.fn()
const copyToDirectory = vi.fn()
const revealLocalFile = vi.fn()
const getLocalExecutorDeviceId = vi.fn()

vi.mock('@/hooks/useTranslation', () => {
  const translate = (_key: string, fallback?: string) => fallback ?? _key
  return { useTranslation: () => ({ t: translate, i18n: { language: 'zh-CN' } }) }
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

const workbenchModels = vi.hoisted(() => ({ current: [] as UnifiedModel[] }))
workbenchModels.current = [harnessModel]

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: workbenchModels.current },
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
  takeHarnessAppAdditionalProxyTokens: vi.fn().mockResolvedValue([]),
  takeHarnessAppContextToken: vi.fn().mockResolvedValue(null),
  takeHarnessAppProxyToken: vi.fn().mockResolvedValue(null),
  takeHarnessAppDecisionToken: vi.fn().mockResolvedValue(null),
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
    export: (id: string) => exportPackage(id),
    verify: (id: string) => verifyInstallation(id),
    upload: (path: string, url: string) => uploadPackage(path, url),
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
    getItem: vi.fn().mockRejectedValue(new ApiError('Smart app not found', 404, 'not_found')),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
    workbenchModels.current = [harnessModel]
    vi.mocked(openHarnessAppTab).mockClear()
    navigateTo.mockReset()
    queuePluginReferenceTrial.mockReset().mockReturnValue(true)
    queueSmartAppDevelopmentPreview.mockReset()
    ensureBundledPluginInstalled.mockReset().mockResolvedValue(undefined)
    listInstalled.mockReset().mockResolvedValue([])
    verifyInstallation.mockReset().mockResolvedValue({ status: 'passed', issues: [] })
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
    exportPackage.mockReset().mockResolvedValue({
      archivePath: '/tmp/research-desk.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      manifest: importedInstallation.manifest,
    })
    uploadPackage.mockReset().mockResolvedValue(undefined)
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
    expect(screen.getByTestId('smart-apps-created-create')).toBeInTheDocument()
    expect(screen.getByTestId('smart-apps-link-directory')).toBeInTheDocument()
    expect(screen.getByTestId('smart-apps-import-button')).toBeInTheDocument()
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

  test.each(['', '/wework/app', '/nested/workbench'])(
    'refreshes published releases on reentry under base path "%s"',
    async appBasePath => {
      window.__WEWORK_RUNTIME_CONFIG__ = {
        ...window.__WEWORK_RUNTIME_CONFIG__,
        appBasePath,
      }
      window.history.replaceState({}, '', `${appBasePath}/sites?app_type=smart_app`)
      listInstalled.mockResolvedValue([
        { ...importedInstallation, id: 'market-7', smartAppId: 7, releaseId: 17 },
      ])
      const smartAppsApi = api()
      vi.mocked(smartAppsApi.listMarketplace)
        .mockResolvedValueOnce({ items: [item()] })
        .mockResolvedValue({ items: [item({ latestReleaseId: 18, version: '2.0.0' })] })
      render(<SmartAppsMarketplacePage api={smartAppsApi} />)

      expect(await screen.findByTestId('harness-app-start-market-7')).toBeInTheDocument()
      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))

      expect(await screen.findByTestId('smart-app-marketplace-install-7')).toHaveTextContent('更新')
      expect(screen.getByTestId('smart-app-marketplace-item-7')).toHaveTextContent('v2.0.0')
      expect(smartAppsApi.listMarketplace).toHaveBeenCalledTimes(2)
    }
  )

  test.each([
    '/wework/app/sites?app_type=miniapp',
    '/wework/app/settings?app_type=smart_app',
    '/wework/app-other/sites?app_type=smart_app',
  ])('does not refresh Smart apps for unrelated route "%s"', async route => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      appBasePath: '/wework/app',
    }
    window.history.replaceState({}, '', '/wework/app/sites?app_type=smart_app')
    const smartAppsApi = api()
    render(<SmartAppsMarketplacePage api={smartAppsApi} />)
    await screen.findByTestId('smart-app-marketplace-item-7')

    window.history.replaceState({}, '', route)
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))

    expect(smartAppsApi.listMarketplace).toHaveBeenCalledTimes(1)
    expect(listInstalled).toHaveBeenCalledTimes(1)
  })

  test('downloads an authorized package from the detail view', async () => {
    const smartAppsApi = api()
    render(<SmartAppsMarketplacePage api={smartAppsApi} />)

    fireEvent.click(await screen.findByText('研究工作台'))
    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }))

    await waitFor(() => expect(smartAppsApi.getDownload).toHaveBeenCalledWith(7))
    expect(downloadPackage).toHaveBeenCalledWith(expect.objectContaining({ smartAppId: 7 }))
  })

  test('does not start ZIP import when selection is cancelled', async () => {
    invokeDesktopHost.mockResolvedValue({ canceled: true, filePaths: [] })
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-apps-import-button'))

    await waitFor(() => expect(invokeDesktopHost).toHaveBeenCalledOnce())
    expect(previewPackage).not.toHaveBeenCalled()
    expect(installPackage).not.toHaveBeenCalled()
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

  test('discards old-owner details and prepares the new owner item with its own release', async () => {
    const firstItem = item({
      name: 'first-desk',
      displayName: '目录 A 工作台',
      latestReleaseId: 17,
    })
    const secondItem = item({
      name: 'second-desk',
      displayName: '目录 B 工作台',
      latestReleaseId: 99,
    })
    const firstApi = api([firstItem])
    const secondApi = api([secondItem])
    vi.mocked(secondApi.getDownload).mockResolvedValue({
      smartAppId: secondItem.id,
      releaseId: secondItem.latestReleaseId,
      version: secondItem.version,
      filename: 'second-desk.zip',
      downloadUrl: 'https://download.test/second-desk.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      expiresAt: '2026-08-20T00:10:00Z',
    })
    const { rerender } = render(<SmartAppsMarketplacePage api={firstApi} />)
    fireEvent.click(await screen.findByText(firstItem.displayName))
    expect(screen.getByTestId('smart-app-details')).toHaveTextContent(firstItem.displayName)

    rerender(<SmartAppsMarketplacePage api={secondApi} />)

    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
    await screen.findByText(secondItem.displayName)
    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
    expect(secondApi.getDownload).not.toHaveBeenCalled()
    expect(installPackage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(secondItem.displayName))
    const dialog = screen.getByTestId('smart-app-details')
    expect(dialog).toHaveTextContent(secondItem.displayName)
    expect(dialog).not.toHaveTextContent(firstItem.displayName)
    const install = within(screen.getByTestId('smart-app-details-footer')).getByRole('button')
    await waitFor(() => expect(install).toBeEnabled())
    fireEvent.click(install)
    fireEvent.click(await screen.findByTestId('harness-app-install-confirm'))
    await waitFor(() =>
      expect(installPackage).toHaveBeenCalledWith(
        expect.anything(),
        localHarnessModelOptionKey(harnessModel),
        { smartAppId: secondItem.id, releaseId: secondItem.latestReleaseId }
      )
    )
    expect(secondApi.getDownload).toHaveBeenCalledExactlyOnceWith(secondItem.id)
    expect(firstApi.getDownload).not.toHaveBeenCalled()
  })

  test('keeps same-owner details mounted during local revalidation and restores its action', async () => {
    const smartAppsApi = api()
    window.history.replaceState({}, '', '/sites?app_type=smart_app')
    render(<SmartAppsMarketplacePage api={smartAppsApi} />)
    fireEvent.click(await screen.findByText('研究工作台'))
    const dialog = screen.getByTestId('smart-app-details')
    const install = within(screen.getByTestId('smart-app-details-footer')).getByRole('button')
    await waitFor(() => expect(install).toBeEnabled())
    let finishLocal!: (value: (typeof importedInstallation)[]) => void
    listInstalled.mockReturnValueOnce(
      new Promise(resolve => {
        finishLocal = resolve
      })
    )

    act(() => window.dispatchEvent(new PopStateEvent('popstate')))

    await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('smart-app-details')).toBe(dialog)
    expect(install).toBeDisabled()
    await act(async () => finishLocal([]))
    expect(screen.getByTestId('smart-app-details')).toBe(dialog)
    expect(install).toBeEnabled()
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

  test.each([true, false])(
    'keeps a market installation separate from a removed same-name import (market visible: %s)',
    async marketVisible => {
      const previousPublication = item({
        id: 8,
        accessRole: 'owner',
        displayName: '旧测试工作台',
        summary: '旧导入简介',
        iconUrl: 'https://example.test/old.png',
        tags: ['old-tag'],
      })
      const marketItem = item({
        displayName: '市场工作台',
        summary: '市场发布简介',
        iconUrl: 'https://example.test/market.png',
      })
      const smartAppsApi = api(marketVisible ? [marketItem] : [])
      vi.mocked(smartAppsApi.listOwned).mockResolvedValue({ items: [previousPublication] })
      listInstalled.mockResolvedValue([
        {
          ...importedInstallation,
          id: 'market-7',
          source: 'market',
          smartAppId: 7,
          releaseId: 17,
        },
      ])

      render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

      await screen.findByText('市场安装')
      expect(screen.getByTestId('smart-apps-owned-filter-created')).toHaveTextContent('0')
      expect(screen.getByTestId('smart-apps-owned-filter-installed')).toHaveTextContent('1')
      expect(screen.queryByText('旧测试工作台')).not.toBeInTheDocument()
      expect(screen.queryByText('旧导入简介')).not.toBeInTheDocument()
      expect(screen.queryByText('old-tag')).not.toBeInTheDocument()
      expect(screen.queryByText('管理范围')).not.toBeInTheDocument()
      expect(screen.queryByTestId('smart-app-visibility-8')).not.toBeInTheDocument()
      expect(document.querySelector(`img[src="${previousPublication.iconUrl}"]`)).toBeNull()
      expect(
        screen.getByText(
          marketVisible ? marketItem.summary : importedInstallation.manifest.description
        )
      ).toBeInTheDocument()
      if (marketVisible) {
        expect(screen.getByTestId('smart-app-owned-item-7').querySelector('img')).toHaveAttribute(
          'src',
          marketItem.iconUrl
        )
      }
      fireEvent.click(screen.getByTestId('smart-app-actions-market-7'))
      expect(screen.queryByTestId('smart-app-manage-access-market-7')).not.toBeInTheDocument()
    }
  )

  test('matches an owned market installation by ID ahead of another same-name publication', async () => {
    const publication = item({ accessRole: 'owner', summary: '当前发布简介' })
    const smartAppsApi = api([publication])
    vi.mocked(smartAppsApi.listOwned).mockResolvedValue({
      items: [item({ id: 8, accessRole: 'owner', summary: '旧导入简介' }), publication],
    })
    listInstalled.mockResolvedValue([
      { ...importedInstallation, id: 'market-7', source: 'market', smartAppId: 7, releaseId: 17 },
    ])

    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    const card = await screen.findByTestId('smart-app-created-item-market-7')
    expect(card).toHaveTextContent('当前发布简介')
    expect(card).toHaveTextContent('我创建')
    expect(card).not.toHaveTextContent('旧导入简介')
    expect(within(card).getByTestId('smart-app-visibility-7')).toBeInTheDocument()
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
      '发布包已导出到下载目录。'
    )
  })

  test('offers formal verification for linked projects before export', async () => {
    const linked = { ...importedInstallation, source: 'linked' as const }
    listInstalled.mockResolvedValue([linked])
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)
    fireEvent.click(await screen.findByTestId(`smart-app-actions-${linked.id}`))
    fireEvent.pointerDown(screen.getByTestId(`smart-app-verify-${linked.id}`))
    await waitFor(() => expect(verifyInstallation).toHaveBeenCalledWith(linked.id))
    expect(await screen.findByTestId('smart-app-export-success')).toHaveTextContent(
      '工作台验证通过'
    )
    expect(exportToDownloads).not.toHaveBeenCalled()
  })

  test('keeps the card available when installation package export fails', async () => {
    listInstalled.mockResolvedValue([importedInstallation])
    exportToDownloads.mockRejectedValueOnce(new Error('Downloads unavailable'))
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(await screen.findByTestId(`smart-app-actions-${importedInstallation.id}`))
    fireEvent.pointerDown(screen.getByTestId(`smart-app-export-package-${importedInstallation.id}`))

    expect(await screen.findByRole('alert')).toHaveTextContent('发布包导出失败。')
    expect(
      screen.getByTestId(`smart-app-created-item-${importedInstallation.id}`)
    ).toBeInTheDocument()
  })

  test.each(['', '/wework/app', '/nested/workbench'])(
    'refreshes local runtime state on reentry under base path "%s"',
    async appBasePath => {
      window.__WEWORK_RUNTIME_CONFIG__ = {
        ...window.__WEWORK_RUNTIME_CONFIG__,
        appBasePath,
      }
      listInstalled.mockResolvedValueOnce([importedInstallation]).mockResolvedValue([
        {
          ...importedInstallation,
          state: 'running',
          webUrl: 'http://127.0.0.1:3080',
        },
      ])
      window.history.replaceState({}, '', `${appBasePath}/sites?app_type=smart_app&view=owned`)
      render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

      expect(await screen.findByTestId('harness-app-start-research-desk')).toBeInTheDocument()
      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))

      expect(await screen.findByTestId('harness-app-open-research-desk')).toBeInTheDocument()
    }
  )

  test.each(['pending', 'failed'])(
    'shows local model controls while the initial cloud catalog is %s',
    async cloudState => {
      const modelKey = localHarnessModelOptionKey(harnessModel)
      listInstalled.mockResolvedValue([{ ...importedInstallation, modelKey }])
      const smartAppsApi = api()
      let finishCatalog!: (result: { items: SmartAppMarketplaceItem[] }) => void
      vi.mocked(smartAppsApi.listOwned).mockImplementationOnce(() =>
        cloudState === 'failed'
          ? Promise.reject(new Error('云目录不可用'))
          : new Promise(resolve => {
              finishCatalog = resolve
            })
      )

      render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

      const selector = await screen.findByTestId('harness-app-model-research-desk')
      expect(selector).toHaveValue(modelKey)
      expect(screen.getByTestId('harness-app-start-research-desk')).toBeEnabled()
      if (cloudState === 'failed') {
        expect(await screen.findByRole('alert')).toHaveTextContent('云目录不可用')
        vi.mocked(smartAppsApi.listOwned).mockResolvedValueOnce({
          items: [item({ displayName: '恢复后的工作台' })],
        })
        fireEvent.click(screen.getByTestId('smart-apps-load-retry'))
        await waitFor(() =>
          expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent(
            '恢复后的工作台'
          )
        )
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
        expect(selector).toHaveValue(modelKey)
      } else {
        expect(screen.queryByText('正在加载')).not.toBeInTheDocument()
        await act(async () => finishCatalog({ items: [item()] }))
        expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
      }
    }
  )

  test.each(['pending', 'failed'])(
    'shows marketplace content while the initial local installations are %s',
    async localState => {
      let finishLocal!: (value: (typeof importedInstallation)[]) => void
      listInstalled.mockImplementationOnce(() =>
        localState === 'failed'
          ? Promise.reject(new Error('本机列表不可用'))
          : new Promise(resolve => {
              finishLocal = resolve
            })
      )
      render(<SmartAppsMarketplacePage api={api()} />)

      const card = await screen.findByTestId('smart-app-marketplace-item-7')
      expect(card).toHaveTextContent('研究工作台')
      if (localState === 'failed') {
        expect(await screen.findByRole('alert')).toHaveTextContent('本机列表不可用')
      } else {
        await act(async () => finishLocal([]))
        expect(screen.getByTestId('smart-app-marketplace-item-7')).toBe(card)
      }
    }
  )

  test('shows discovery failures without presenting a successful empty result', async () => {
    listInstalled.mockRejectedValueOnce(new Error('本机列表不可用'))
    const smartAppsApi = api()
    vi.mocked(smartAppsApi.listOwned).mockRejectedValueOnce(new Error('云目录不可用'))
    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('云目录不可用'))

    expect(screen.getByRole('alert')).toHaveTextContent('本机列表不可用')
    expect(screen.getByTestId('smart-apps-load-retry')).toBeEnabled()
    expect(screen.queryByText('还没有符合条件的工作台')).not.toBeInTheDocument()
    expect(screen.queryByText('正在加载')).not.toBeInTheDocument()
  })

  test.each(['pending', 'failed'])(
    'keeps marketplace discovery visible but blocks installation until %s local discovery recovers',
    async discoveryState => {
      const running = {
        ...importedInstallation,
        id: 'market-7',
        source: 'market' as const,
        smartAppId: 7,
        releaseId: 16,
        modelKey: localHarnessModelOptionKey(harnessModel),
        state: 'running' as const,
        webUrl: 'http://127.0.0.1:3080',
      }
      let finishLocal!: (value: (typeof running)[]) => void
      listInstalled.mockImplementationOnce(() =>
        discoveryState === 'failed'
          ? Promise.reject(new Error('本机列表不可用'))
          : new Promise(resolve => {
              finishLocal = resolve
            })
      )
      listInstalled.mockResolvedValue([running])
      const smartAppsApi = api()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      onTestFinished(() => confirm.mockRestore())
      render(<SmartAppsMarketplacePage api={smartAppsApi} />)

      const card = await screen.findByTestId('smart-app-marketplace-item-7')
      const installButton = screen.getByTestId('smart-app-marketplace-install-7')
      expect(installButton).toBeDisabled()
      expect(card).not.toHaveTextContent('未安装')
      fireEvent.click(installButton)
      expect(smartAppsApi.getDownload).not.toHaveBeenCalled()
      expect(installPackage).not.toHaveBeenCalled()
      fireEvent.click(within(card).getByRole('button', { name: /研究工作台/ }))
      expect(
        within(screen.getByTestId('smart-app-details-footer')).getByRole('button')
      ).toBeDisabled()
      fireEvent.click(screen.getByTestId('smart-app-details-close'))

      if (discoveryState === 'failed') {
        fireEvent.click(await screen.findByTestId('smart-apps-load-retry'))
      } else {
        await act(async () => finishLocal([running]))
      }
      await waitFor(() => expect(installButton).toBeEnabled())
      expect(installButton).toHaveTextContent('更新')
      fireEvent.click(installButton)
      const submit = await screen.findByTestId('harness-app-install-confirm')
      fireEvent.click(submit)
      expect(confirm).toHaveBeenCalledOnce()
      expect(stopInstalled).not.toHaveBeenCalled()
      expect(installPackage).not.toHaveBeenCalled()

      confirm.mockReturnValue(true)
      fireEvent.click(submit)
      await waitFor(() => expect(installPackage).toHaveBeenCalledOnce())
      expect(stopInstalled).toHaveBeenCalledWith(running.id)
      expect(stopInstalled.mock.invocationCallOrder[0]).toBeLessThan(
        installPackage.mock.invocationCallOrder[0]
      )
    }
  )

  test.each(['pending', 'failed'])(
    'blocks an open install dialog while local revalidation is %s and preserves its model',
    async discoveryState => {
      window.history.replaceState({}, '', '/sites?app_type=smart_app')
      render(<SmartAppsMarketplacePage api={api()} />)
      fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
      const submit = await screen.findByTestId('harness-app-install-confirm')
      const model = screen.getByTestId('harness-app-model-select')
      const modelKey = localHarnessModelOptionKey(harnessModel)
      expect(model).toHaveValue(modelKey)
      let finishLocal!: (value: (typeof importedInstallation)[]) => void
      listInstalled.mockImplementationOnce(() =>
        discoveryState === 'failed'
          ? Promise.reject(new Error('本机列表不可用'))
          : new Promise(resolve => {
              finishLocal = resolve
            })
      )
      act(() => window.dispatchEvent(new PopStateEvent('popstate')))
      await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(2))
      if (discoveryState === 'failed') {
        await waitFor(() =>
          expect(screen.getByTestId('harness-app-error')).toHaveTextContent('本机列表不可用')
        )
      }
      expect(submit).toBeDisabled()
      fireEvent.click(submit)
      expect(installPackage).not.toHaveBeenCalled()
      expect(screen.getByTestId('harness-app-model-select')).toBe(model)
      expect(model).toHaveValue(modelKey)

      if (discoveryState === 'failed') {
        fireEvent.click(screen.getByTestId('smart-apps-load-retry'))
      } else {
        await act(async () => finishLocal([]))
      }
      await waitFor(() => expect(submit).toBeEnabled())
    }
  )

  test('discards a prepared install dialog when its discovery owner changes', async () => {
    const firstApi = api()
    const secondApi = api([item({ displayName: '另一个目录的工作台' })])
    const { rerender } = render(<SmartAppsMarketplacePage api={firstApi} />)
    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    await screen.findByTestId('harness-app-preview')

    rerender(<SmartAppsMarketplacePage api={secondApi} />)

    expect(screen.queryByTestId('harness-app-preview')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('smart-app-marketplace-item-7')).toHaveTextContent(
        '另一个目录的工作台'
      )
    )
    expect(screen.queryByTestId('harness-app-preview')).not.toBeInTheDocument()
    expect(installPackage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('smart-app-marketplace-install-7'))
    await screen.findByTestId('harness-app-preview')
    expect(secondApi.getDownload).toHaveBeenCalledOnce()
  })

  test('finishes a local model change while cloud revalidation is pending', async () => {
    listInstalled.mockResolvedValue([importedInstallation])
    const smartAppsApi = api()
    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)
    const selector = await screen.findByTestId('harness-app-model-research-desk')
    await waitFor(() => expect(smartAppsApi.listOwned).toHaveBeenCalledOnce())
    const modelKey = localHarnessModelOptionKey(harnessModel)
    updateInstalled.mockResolvedValueOnce({ ...importedInstallation, modelKey })
    listInstalled.mockResolvedValueOnce([{ ...importedInstallation, modelKey }])
    let finishCloud!: (result: { items: SmartAppMarketplaceItem[] }) => void
    vi.mocked(smartAppsApi.listOwned).mockReturnValueOnce(
      new Promise(resolve => {
        finishCloud = resolve
      })
    )

    fireEvent.change(selector, { target: { value: modelKey } })

    await waitFor(() => expect(updateInstalled).toHaveBeenCalledWith('research-desk', { modelKey }))
    await waitFor(() => expect(selector).toHaveValue(modelKey))
    await waitFor(() => expect(selector).toBeEnabled())
    expect(screen.getByTestId('harness-app-start-research-desk')).toBeEnabled()
    await act(async () => finishCloud({ items: [item()] }))
    expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
    expect(selector).toHaveValue(modelKey)
  })

  test.each(['pending', 'failed'])(
    'preserves cached local controls but blocks model changes and open deletion during %s revalidation',
    async discoveryState => {
      const installation = {
        ...importedInstallation,
        id: `catalog-readiness-${discoveryState}`,
        modelKey: 'retired-model',
      }
      listInstalled.mockResolvedValue([installation])
      window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
      render(<SmartAppsMarketplacePage api={api()} mode="owned" />)
      const model = await screen.findByTestId(`harness-app-model-${installation.id}`)
      fireEvent.click(screen.getByTestId(`smart-app-actions-${installation.id}`))
      fireEvent.pointerDown(screen.getByTestId(`smart-app-remove-local-${installation.id}`))
      const submit = screen.getByTestId('smart-app-remove-local-confirm')
      let finishLocal!: (value: (typeof installation)[]) => void
      listInstalled.mockImplementationOnce(() =>
        discoveryState === 'failed'
          ? Promise.reject(new Error('本机列表不可用'))
          : new Promise(resolve => {
              finishLocal = resolve
            })
      )

      act(() => window.dispatchEvent(new PopStateEvent('popstate')))
      await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(2))
      if (discoveryState === 'failed') {
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本机列表不可用'))
      }
      expect(screen.getByTestId(`harness-app-model-${installation.id}`)).toBe(model)
      expect(model).toHaveValue(installation.modelKey)
      expect(model).toBeDisabled()
      expect(submit).toBeDisabled()
      fireEvent.change(model, { target: { value: localHarnessModelOptionKey(harnessModel) } })
      fireEvent.click(submit)
      expect(updateInstalled).not.toHaveBeenCalled()
      expect(deleteInstalled).not.toHaveBeenCalled()
      expect(stopInstalled).not.toHaveBeenCalled()

      if (discoveryState === 'failed') {
        fireEvent.click(screen.getByTestId('smart-apps-load-retry'))
      } else {
        await act(async () => finishLocal([installation]))
      }
      await waitFor(() => expect(submit).toBeEnabled())
      expect(model).toBeEnabled()
      expect(model).toHaveValue(installation.modelKey)
      fireEvent.click(submit)
      await waitFor(() => expect(deleteInstalled).toHaveBeenCalledWith(installation.id))
    }
  )

  test('keeps model controls mounted during a second refresh without waiting for cloud metadata', async () => {
    const original = { ...importedInstallation, modelKey: 'original-model' }
    const updated = { ...original, modelKey: 'updated-model' }
    listInstalled.mockResolvedValue([original])
    const smartAppsApi = api()
    window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)
    const selector = await screen.findByTestId('harness-app-model-research-desk')
    expect(selector).toHaveValue('original-model')

    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
    await waitFor(() => expect(smartAppsApi.listOwned).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('harness-app-model-research-desk')).toHaveValue('original-model')

    let finishRefresh!: (result: { items: SmartAppMarketplaceItem[] }) => void
    vi.mocked(smartAppsApi.listOwned).mockReturnValueOnce(
      new Promise(resolve => {
        finishRefresh = resolve
      })
    )
    let finishLocal!: (result: (typeof updated)[]) => void
    listInstalled.mockReturnValueOnce(
      new Promise(resolve => {
        finishLocal = resolve
      })
    )
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
    await waitFor(() => expect(smartAppsApi.listOwned).toHaveBeenCalledTimes(3))

    expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
    expect(selector).toHaveValue('original-model')
    expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent(
      '研究工作台'
    )

    await act(async () => finishLocal([updated]))
    expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
    expect(selector).toHaveValue('updated-model')
    expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent(
      '研究工作台'
    )
    await act(async () => finishRefresh({ items: [item({ displayName: '更新后的工作台' })] }))

    expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
    expect(selector).toHaveValue('updated-model')
    expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent(
      '更新后的工作台'
    )
  })

  test.each(['local', 'catalog'])(
    'preserves loaded controls after a %s refresh failure and recovers on reentry',
    async failureSource => {
      listInstalled.mockResolvedValue([{ ...importedInstallation, modelKey: 'original-model' }])
      const smartAppsApi = api()
      window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
      render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)
      const selector = await screen.findByTestId('harness-app-model-research-desk')
      let rejectRefresh!: (error: Error) => void
      const pending = new Promise<never>((_resolve, reject) => {
        rejectRefresh = reject
      })
      if (failureSource === 'local') listInstalled.mockReturnValueOnce(pending)
      else vi.mocked(smartAppsApi.listOwned).mockReturnValueOnce(pending)
      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
      await act(async () => rejectRefresh(new Error('刷新失败')))

      expect(screen.getByRole('alert')).toHaveTextContent('刷新失败')
      expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
      expect(selector).toHaveValue('original-model')

      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByTestId('harness-app-model-research-desk')).toBe(selector)
      expect(listInstalled).toHaveBeenCalledTimes(3)
    }
  )

  test('invalidates a stale local read after a stop event without cancelling cloud discovery', async () => {
    const running = {
      ...importedInstallation,
      state: 'running',
      webUrl: 'http://127.0.0.1:3080',
    }
    listInstalled.mockResolvedValue([running])
    const smartAppsApi = api()
    window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)
    await screen.findByTestId('harness-app-open-research-desk')
    let finishRefresh!: (result: { items: SmartAppMarketplaceItem[] }) => void
    vi.mocked(smartAppsApi.listOwned).mockReturnValueOnce(
      new Promise(resolve => {
        finishRefresh = resolve
      })
    )
    let finishLocal!: (result: (typeof running)[]) => void
    listInstalled.mockReturnValueOnce(
      new Promise(resolve => {
        finishLocal = resolve
      })
    )
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))

    act(() =>
      notifyHarnessAppInstallationsChanged({ type: 'stopped', installationId: 'research-desk' })
    )
    expect(screen.getByTestId('harness-app-start-research-desk')).toBeInTheDocument()
    await act(async () => {
      finishLocal([running])
      finishRefresh({ items: [item({ displayName: '新云目录' })] })
    })

    expect(screen.getByTestId('harness-app-start-research-desk')).toBeInTheDocument()
    expect(screen.queryByTestId('harness-app-open-research-desk')).not.toBeInTheDocument()
    expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent('新云目录')
    expect(listInstalled).toHaveBeenCalledTimes(2)
  })

  test.each(['query', 'api'] as const)(
    'hides the previous %s scope immediately and rejects its late refresh',
    async change => {
      listInstalled.mockResolvedValue([importedInstallation])
      const originalApi = api()
      const replacementApi = change === 'api' ? api() : originalApi
      window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')
      const { rerender } = render(<SmartAppsMarketplacePage api={originalApi} mode="owned" />)
      await screen.findByTestId('harness-app-model-research-desk')
      let finishOld!: (result: { items: SmartAppMarketplaceItem[] }) => void
      vi.mocked(originalApi.listOwned).mockReturnValueOnce(
        new Promise(resolve => {
          finishOld = resolve
        })
      )
      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
      let finishCurrent!: (result: { items: SmartAppMarketplaceItem[] }) => void
      vi.mocked(replacementApi.listOwned).mockReturnValueOnce(
        new Promise(resolve => {
          finishCurrent = resolve
        })
      )

      if (change === 'query') {
        fireEvent.change(screen.getByTestId('smart-apps-owned-search'), {
          target: { value: '研究' },
        })
      } else {
        rerender(<SmartAppsMarketplacePage api={replacementApi} mode="owned" />)
      }

      expect(screen.getByText('正在加载')).toBeInTheDocument()
      expect(screen.queryByTestId('harness-app-model-research-desk')).not.toBeInTheDocument()
      await waitFor(() =>
        expect(replacementApi.listOwned).toHaveBeenCalledTimes(change === 'query' ? 3 : 1)
      )
      await act(async () => finishCurrent({ items: [item({ displayName: '当前研究工作台' })] }))
      expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent(
        '当前研究工作台'
      )

      await act(async () => finishOld({ items: [item({ displayName: '过期研究工作台' })] }))

      expect(screen.getByTestId('smart-app-created-item-research-desk')).toHaveTextContent(
        '当前研究工作台'
      )
      expect(screen.queryByText('过期研究工作台')).not.toBeInTheDocument()
    }
  )

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

  test('blocks an oversized imported source archive before calling the publish API', async () => {
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.listTags).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'data_analysis',
          name_zh: '数据分析',
          name_en: 'Data analysis',
          sort: 1,
          enabled: true,
        },
      ],
    })
    listInstalled.mockResolvedValue([importedInstallation])
    exportPackage.mockResolvedValue({
      archivePath: '/tmp/source.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 50 * 1024 * 1024 + 1,
      manifest: importedInstallation.manifest,
    })

    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-app-created-publish-research-desk'))
    expect(
      screen.getByText('将使用已导入的发布包；源码目录请通过“关联文件夹”进入开发流程。')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('数据分析'))
    fireEvent.change(screen.getByTestId('smart-app-publish-icon'), {
      target: { files: [new File(['icon'], 'icon.png', { type: 'image/png' })] },
    })
    fireEvent.click(screen.getByTestId('smart-app-publish-scope-public'))
    fireEvent.click(
      within(screen.getByTestId('smart-app-publish-dialog')).getByRole('button', {
        name: '发布',
      })
    )

    expect(
      await screen.findByText(
        '发布包超过 50 MB，请使用项目打包命令生成发布产物，不要直接上传源码压缩包。'
      )
    ).toBeInTheDocument()
    expect(smartAppsApi.initSubmission).not.toHaveBeenCalled()
    expect(uploadPackage).not.toHaveBeenCalled()
  })

  test('reports an oversized icon in Chinese before exporting the package', async () => {
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.listTags).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'data_analysis',
          name_zh: '数据分析',
          name_en: 'Data analysis',
          sort: 1,
          enabled: true,
        },
      ],
    })
    listInstalled.mockResolvedValue([importedInstallation])

    render(<SmartAppsMarketplacePage api={smartAppsApi} mode="owned" />)

    fireEvent.click(await screen.findByTestId('smart-app-created-publish-research-desk'))
    fireEvent.click(screen.getByLabelText('数据分析'))
    fireEvent.change(screen.getByTestId('smart-app-publish-icon'), {
      target: {
        files: [new File([new Uint8Array(512 * 1024 + 1)], 'oversized.png', { type: 'image/png' })],
      },
    })
    fireEvent.click(screen.getByTestId('smart-app-publish-scope-public'))
    fireEvent.click(
      within(screen.getByTestId('smart-app-publish-dialog')).getByRole('button', {
        name: '发布',
      })
    )

    expect(await screen.findByText('图标不能超过 512 KB。')).toBeInTheDocument()
    expect(exportPackage).not.toHaveBeenCalled()
    expect(smartAppsApi.initSubmission).not.toHaveBeenCalled()
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
    const advancedToggle = screen.getByTestId('smart-app-development-advanced-toggle')
    expect(advancedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('smart-app-development-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-development-template-web')).not.toBeInTheDocument()
    const fields = [
      'smart-app-development-display-name',
      'smart-app-development-description',
      'smart-app-development-parent-path',
      'smart-app-development-advanced-toggle',
    ].map(testId => screen.getByTestId(testId))
    expect(
      fields.every((field, index) =>
        index === 0
          ? true
          : Boolean(
              fields[index - 1].compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING
            )
      )
    ).toBe(true)
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.change(screen.getByTestId('smart-app-development-description'), {
      target: { value: '持续开发' },
    })
    fireEvent.click(advancedToggle)
    expect(advancedToggle).toHaveAttribute('aria-expanded', 'true')
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
    fireEvent.click(advancedToggle)
    expect(advancedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('smart-app-development-name')).not.toBeInTheDocument()
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
      expect.objectContaining({ description: '持续开发', template: 'web-host-remote' })
    )
    expect(navigateTo).toHaveBeenCalledWith('/')
  })

  test('creates a Chinese-named workbench with only the name filled', async () => {
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    expect(screen.getByText('用途说明（可选）')).toBeInTheDocument()
    expect(screen.getByText('保存位置（可选）')).toBeInTheDocument()
    expect(screen.getByText(/WeworkSmartApps 文件夹/)).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-advanced-toggle'))
    fireEvent.change(screen.getByTestId('smart-app-development-name'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-advanced-toggle'))
    expect(screen.getByTestId('smart-app-development-confirm')).toBeEnabled()
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    await waitFor(() => expect(createDirectory).toHaveBeenCalledOnce())
    expect(createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: '空白工作台',
        name: expect.stringMatching(/^workbench-[a-f0-9]{8}$/),
        description: '',
        parentPath: '',
        template: 'web',
      })
    )
  })

  test('explains an outdated desktop host rejection and exposes its error details', async () => {
    createDirectory.mockRejectedValueOnce(
      Object.assign(new Error('parentPath is required'), { code: 'invalid_params' })
    )
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '测试' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    expect(
      await screen.findByText(
        '桌面程序尚未更新到支持留空保存位置和用途说明的版本，请退出并重新启动后重试。'
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-development-choose-other-directory')).toBeNull()
    fireEvent.click(screen.getByTestId('smart-app-development-error-details'))
    expect(screen.getByText('invalid_params: parentPath is required')).toBeInTheDocument()
  })

  test('offers a folder picker when the default save location cannot be used', async () => {
    createDirectory.mockRejectedValueOnce(
      new Error('Smart app default save location is unavailable')
    )
    invokeDesktopHost.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/writable'] })
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    expect(
      await screen.findByText('无法在系统“文档”中创建工作台，请选择其他保存位置。')
    ).toBeInTheDocument()
    expect(screen.getByTestId('smart-app-development-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('smart-app-development-choose-other-directory'))
    await waitFor(() =>
      expect(screen.getByTestId('smart-app-development-parent-path')).toHaveValue('/tmp/writable')
    )
    fireEvent.click(screen.getByTestId('smart-app-development-confirm'))

    await waitFor(() => expect(createDirectory).toHaveBeenCalledTimes(2))
    expect(createDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentPath: '/tmp/writable' })
    )
  })

  test('does not create a workbench directory without a local project device', async () => {
    getLocalExecutorDeviceId.mockResolvedValue(null)
    render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)

    fireEvent.click(screen.getByTestId('smart-apps-created-create'))
    fireEvent.change(screen.getByTestId('smart-app-development-display-name'), {
      target: { value: '空白工作台' },
    })
    fireEvent.click(screen.getByTestId('smart-app-development-advanced-toggle'))
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
    fireEvent.click(screen.getByTestId('smart-app-development-advanced-toggle'))
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

    expect(await screen.findByText('打开工作台文件夹失败。')).toBeInTheDocument()
    expect(revealLocalFile).toHaveBeenCalledWith(importedInstallation.packagePath)
  })

  test('opens targeted app details and explains how to install it from a deep link', async () => {
    render(<SmartAppsMarketplacePage api={api([item()])} targetSmartAppId={7} />)

    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toHaveTextContent(
      '此智能工作台尚未安装'
    )
    expect(screen.getByTestId('smart-app-deep-link-install-prompt')).toHaveTextContent('研究工作台')
    expect(screen.getByTestId('smart-app-details')).toHaveTextContent('研究工作台')
  })

  test('loads a deep-link target directly when the catalog list is empty', async () => {
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.getItem).mockResolvedValue(item())
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)

    expect(await screen.findByTestId('smart-app-details')).toHaveTextContent('研究工作台')
    expect(smartAppsApi.getItem).toHaveBeenCalledExactlyOnceWith(7)
  })

  test('loads a deep-link target while the marketplace catalog is still pending', async () => {
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.listMarketplace).mockReturnValue(new Promise(() => {}))
    vi.mocked(smartAppsApi.getItem).mockResolvedValue(item())
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)

    expect(await screen.findByTestId('smart-app-details')).toHaveTextContent('研究工作台')
    expect(smartAppsApi.getItem).toHaveBeenCalledExactlyOnceWith(7)
  })

  test('clears the deep-link install prompt after the target is installed', async () => {
    render(<SmartAppsMarketplacePage api={api([item()])} targetSmartAppId={7} />)
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()

    const installation = {
      ...importedInstallation,
      id: 'research-target',
      smartAppId: 7,
      state: 'running' as const,
      webUrl: 'http://127.0.0.1:3000',
    }
    act(() => {
      window.dispatchEvent(
        new CustomEvent(HARNESS_APP_INSTALLATIONS_CHANGED_EVENT, {
          detail: {
            type: 'installed',
            installationId: installation.id,
            installation,
          },
        })
      )
    })

    await waitFor(() =>
      expect(screen.queryByTestId('smart-app-deep-link-install-prompt')).not.toBeInTheDocument()
    )
  })

  test('reports an unavailable target instead of leaving a blank deep link', async () => {
    render(<SmartAppsMarketplacePage api={api([])} targetSmartAppId={99} />)

    expect(
      await screen.findByText('未找到此智能工作台，可能已下架或你没有访问权限。')
    ).toBeInTheDocument()
    expect(screen.getByTestId('smart-app-deep-link-retry')).toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
  })

  test('retries a failed deep-link target lookup', async () => {
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.getItem)
      .mockRejectedValueOnce(new ApiError('temporary failure', 503, 'unavailable'))
      .mockResolvedValueOnce(item())
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)

    fireEvent.click(await screen.findByTestId('smart-app-deep-link-retry'))

    expect(await screen.findByTestId('smart-app-details')).toHaveTextContent('研究工作台')
    expect(smartAppsApi.getItem).toHaveBeenCalledTimes(2)
  })

  test('clears the previous target before resolving another deep-link target', async () => {
    const smartAppsApi = api([item()])
    const { rerender } = render(
      <SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />
    )
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toHaveTextContent(
      '研究工作台'
    )

    rerender(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={99} />)

    expect(
      await screen.findByText('未找到此智能工作台，可能已下架或你没有访问权限。')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-deep-link-install-prompt')).not.toBeInTheDocument()

    rerender(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)

    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toHaveTextContent(
      '研究工作台'
    )
    expect(screen.getByTestId('smart-app-details')).toHaveTextContent('研究工作台')
  })

  test('ignores a pending download after the deep-link target changes', async () => {
    const smartAppsApi = api([item()])
    let resolveDownload: (
      value: Awaited<ReturnType<SmartAppsApi['getDownload']>>
    ) => void = () => {}
    vi.mocked(smartAppsApi.getDownload).mockReturnValue(
      new Promise(resolve => {
        resolveDownload = resolve
      })
    )
    const { rerender } = render(
      <SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />
    )

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    await waitFor(() => expect(smartAppsApi.getDownload).toHaveBeenCalledWith(7))
    rerender(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={99} />)
    act(() =>
      resolveDownload({
        smartAppId: 7,
        releaseId: 17,
        version: '1.2.0',
        filename: 'research.zip',
        downloadUrl: 'https://download.test/research.zip',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        expiresAt: '2026-08-20T00:10:00Z',
      })
    )

    expect(
      await screen.findByText('未找到此智能工作台，可能已下架或你没有访问权限。')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('harness-app-install-confirm')).not.toBeInTheDocument()
  })

  test('starts an installed target after its catalog lookup resolves first', async () => {
    let resolveInstalled: (value: unknown[]) => void = () => {}
    listInstalled.mockReturnValue(
      new Promise(resolve => {
        resolveInstalled = resolve
      })
    )
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.getItem).mockResolvedValue(item())
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)

    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()
    act(() =>
      resolveInstalled([
        {
          ...importedInstallation,
          smartAppId: 7,
          modelKey: localHarnessModelOptionKey(harnessModel),
          state: 'installed',
        },
      ])
    )

    await waitFor(() =>
      expect(openHarnessAppTab).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'research-desk', smartAppId: 7 })
      )
    )
  })

  test('waits for a running target to receive its web URL', async () => {
    const installation = {
      ...importedInstallation,
      smartAppId: 7,
      modelKey: localHarnessModelOptionKey(harnessModel),
      state: 'running' as const,
      webUrl: null,
    }
    listInstalled.mockResolvedValue([installation])
    const smartAppsApi = api([item()])
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)

    await waitFor(() => expect(listInstalled).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByTestId('smart-app-deep-link-install-prompt')).not.toBeInTheDocument()
    )
    expect(openHarnessAppTab).not.toHaveBeenCalled()

    const running = { ...installation, webUrl: 'http://127.0.0.1:3000' }
    listInstalled.mockResolvedValue([running])
    act(() => {
      window.dispatchEvent(
        new CustomEvent(HARNESS_APP_INSTALLATIONS_CHANGED_EVENT, {
          detail: {
            type: 'updated',
            installationId: installation.id,
            installation: running,
          },
        })
      )
    })

    await waitFor(() => expect(openHarnessAppTab).toHaveBeenCalledWith(expect.anything(), running))
  })

  test('retries a deep-link start after the model catalog becomes available', async () => {
    workbenchModels.current = []
    const installation = {
      ...importedInstallation,
      smartAppId: 7,
      modelKey: localHarnessModelOptionKey(harnessModel),
      state: 'installed',
    }
    listInstalled.mockResolvedValue([installation])
    const { rerender } = render(<SmartAppsMarketplacePage api={api([])} targetSmartAppId={7} />)
    expect(
      await screen.findByText('此智能工作台绑定的 Wework 模型已不可用，请重新选择模型。')
    ).toBeInTheDocument()
    expect(openHarnessAppTab).not.toHaveBeenCalled()

    workbenchModels.current = [harnessModel]
    rerender(<SmartAppsMarketplacePage api={api([])} targetSmartAppId={7} />)

    await waitFor(() =>
      expect(openHarnessAppTab).toHaveBeenCalledWith(expect.anything(), installation)
    )
  })

  test('re-resolves the target when the marketplace API changes', async () => {
    const firstApi = api([item()])
    const secondApi = api([])
    const { rerender } = render(<SmartAppsMarketplacePage api={firstApi} targetSmartAppId={7} />)
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toHaveTextContent(
      '研究工作台'
    )

    rerender(<SmartAppsMarketplacePage api={secondApi} targetSmartAppId={7} />)

    await waitFor(() => expect(secondApi.getItem).toHaveBeenCalledWith(7))
    expect(
      await screen.findByText('未找到此智能工作台，可能已下架或你没有访问权限。')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-deep-link-install-prompt')).not.toBeInTheDocument()
  })

  test('re-resolves the target after a catalog refresh removes it', async () => {
    const smartAppsApi = api([item()])
    vi.mocked(smartAppsApi.listMarketplace)
      .mockResolvedValueOnce({ items: [item()] })
      .mockResolvedValue({ items: [] })
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'missing' },
    })

    expect(
      await screen.findByText('未找到此智能工作台，可能已下架或你没有访问权限。')
    ).toBeInTheDocument()
    expect(smartAppsApi.getItem).toHaveBeenCalledWith(7)
    expect(screen.queryByTestId('smart-app-deep-link-install-prompt')).not.toBeInTheDocument()
  })

  test('keeps a dismissed target dialog closed after a catalog refresh', async () => {
    const smartAppsApi = api([item()])
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)
    expect(await screen.findByTestId('smart-app-details')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('smart-app-details-close'))
    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'refresh' },
    })
    await waitFor(() => expect(smartAppsApi.listMarketplace).toHaveBeenCalledTimes(2))

    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()
  })

  test('keeps a dismissed target dialog closed when the fallback lookup resolves', async () => {
    const smartAppsApi = api([item()])
    vi.mocked(smartAppsApi.listMarketplace)
      .mockResolvedValueOnce({ items: [item()] })
      .mockResolvedValue({ items: [] })
    vi.mocked(smartAppsApi.getItem).mockResolvedValue(item())
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)
    expect(await screen.findByTestId('smart-app-details')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('smart-app-details-close'))
    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'missing' },
    })
    await waitFor(() => expect(smartAppsApi.getItem).toHaveBeenCalledWith(7))

    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()
  })

  test('ignores a pending target lookup after the API is removed', async () => {
    const lookup = deferred<SmartAppMarketplaceItem>()
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.getItem).mockReturnValueOnce(lookup.promise)
    const { rerender } = render(
      <SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />
    )
    await waitFor(() => expect(smartAppsApi.getItem).toHaveBeenCalledTimes(1))

    rerender(<SmartAppsMarketplacePage api={null} targetSmartAppId={7} />)
    await act(async () => {
      lookup.resolve(item())
    })

    expect(screen.queryByTestId('smart-app-details')).not.toBeInTheDocument()
    expect(screen.queryByTestId('smart-app-deep-link-install-prompt')).not.toBeInTheDocument()
  })

  test('re-resolves a catalog target after its in-flight lookup is superseded', async () => {
    const firstLookup = deferred<SmartAppMarketplaceItem>()
    const secondLookup = deferred<SmartAppMarketplaceItem>()
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.getItem)
      .mockReturnValueOnce(firstLookup.promise)
      .mockReturnValueOnce(secondLookup.promise)
    vi.mocked(smartAppsApi.listMarketplace)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [item()] })
      .mockResolvedValue({ items: [] })
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)
    await waitFor(() => expect(smartAppsApi.getItem).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'hit' },
    })
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'miss' },
    })
    await waitFor(() => expect(smartAppsApi.getItem).toHaveBeenCalledTimes(2))

    act(() => secondLookup.resolve(item()))

    expect(await screen.findByTestId('smart-app-details')).toHaveTextContent('研究工作台')
  })

  test('retries a catalog target after its superseded lookup fails', async () => {
    const firstLookup = deferred<SmartAppMarketplaceItem>()
    const secondLookup = deferred<SmartAppMarketplaceItem>()
    const smartAppsApi = api([])
    vi.mocked(smartAppsApi.getItem)
      .mockReturnValueOnce(firstLookup.promise)
      .mockReturnValueOnce(secondLookup.promise)
      .mockResolvedValueOnce(item())
    vi.mocked(smartAppsApi.listMarketplace)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [item()] })
      .mockResolvedValue({ items: [] })
    render(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />)
    await waitFor(() => expect(smartAppsApi.getItem).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'hit' },
    })
    expect(await screen.findByTestId('smart-app-deep-link-install-prompt')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('smart-apps-marketplace-search'), {
      target: { value: 'miss' },
    })
    await waitFor(() => expect(smartAppsApi.getItem).toHaveBeenCalledTimes(2))
    act(() => secondLookup.reject(new ApiError('temporary failure', 503, 'unavailable')))

    fireEvent.click(await screen.findByTestId('smart-app-deep-link-retry'))

    expect(await screen.findByTestId('smart-app-details')).toHaveTextContent('研究工作台')
    expect(smartAppsApi.getItem).toHaveBeenCalledTimes(3)
  })

  test('ignores a pending download after the marketplace API changes', async () => {
    const firstApi = api([item()])
    let resolveDownload: (
      value: Awaited<ReturnType<SmartAppsApi['getDownload']>>
    ) => void = () => {}
    vi.mocked(firstApi.getDownload).mockReturnValue(
      new Promise(resolve => {
        resolveDownload = resolve
      })
    )
    const { rerender } = render(<SmartAppsMarketplacePage api={firstApi} />)

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    await waitFor(() => expect(firstApi.getDownload).toHaveBeenCalledWith(7))
    rerender(<SmartAppsMarketplacePage api={api([item()])} />)
    act(() =>
      resolveDownload({
        smartAppId: 7,
        releaseId: 17,
        version: '1.2.0',
        filename: 'research.zip',
        downloadUrl: 'https://download.test/research.zip',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        expiresAt: '2026-08-20T00:10:00Z',
      })
    )

    await waitFor(() =>
      expect(screen.queryByTestId('harness-app-install-confirm')).not.toBeInTheDocument()
    )
  })

  test('ignores an install continuation after the target changes', async () => {
    let rejectInstall: (reason: Error) => void = () => {}
    installPackage.mockReturnValue(
      new Promise((_, reject) => {
        rejectInstall = reject
      })
    )
    const smartAppsApi = api([item()])
    const { rerender } = render(
      <SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={7} />
    )

    fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
    fireEvent.click(await screen.findByTestId('harness-app-install-confirm'))
    await waitFor(() => expect(installPackage).toHaveBeenCalled())
    rerender(<SmartAppsMarketplacePage api={smartAppsApi} targetSmartAppId={99} />)
    await screen.findByText('未找到此智能工作台，可能已下架或你没有访问权限。')

    act(() => rejectInstall(new Error('stale install failure')))

    await waitFor(() => expect(screen.queryByText('stale install failure')).not.toBeInTheDocument())
    expect(screen.getByText('未找到此智能工作台，可能已下架或你没有访问权限。')).toBeInTheDocument()
  })
})
