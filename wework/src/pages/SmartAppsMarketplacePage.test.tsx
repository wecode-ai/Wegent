import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'

const navigateTo = vi.fn()
const queuePluginReferenceTrial = vi.fn()
const ensureBundledPluginInstalled = vi.fn()
const listInstalled = vi.fn()
const downloadPackage = vi.fn()

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))
vi.mock('@/lib/navigation', () => ({ navigateTo: (path: string) => navigateTo(path) }))
vi.mock('@/features/plugins/pluginTrial', () => ({
  queuePluginReferenceTrial: (options: unknown) => queuePluginReferenceTrial(options),
}))
vi.mock('@/tauri/localExecutor', () => ({
  ensureBundledPluginInstalled: (name: string) => ensureBundledPluginInstalled(name),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ projectChat: { models: [] } }),
}))
vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    list: () => listInstalled(),
    download: (value: unknown) => downloadPackage(value),
    install: vi.fn(),
    stop: vi.fn(),
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
    tags: ['data_analysis'],
    iconUrl: '',
    screenshotUrls: [],
    featured: true,
    latestReleaseId: 17,
    version: '1.2.0',
    releaseNotes: 'New release',
    sizeBytes: 1024,
    requirements: {},
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

describe('SmartAppsMarketplacePage', () => {
  beforeEach(() => {
    navigateTo.mockReset()
    queuePluginReferenceTrial.mockReset().mockReturnValue(true)
    ensureBundledPluginInstalled.mockReset().mockResolvedValue(undefined)
    listInstalled.mockReset().mockResolvedValue([])
    downloadPackage.mockReset().mockResolvedValue({
      valid: true,
      archivePath: '/tmp/research.zip',
      sha256: 'a'.repeat(64),
      manifest: null,
      issues: [],
    })
  })

  test('shows official and shared marketplace metadata', async () => {
    render(
      <SmartAppsMarketplacePage
        api={api([item(), item({ id: 8, sourceType: 'user', ownerDisplayName: 'Alice' })])}
      />
    )

    expect(await screen.findAllByText('研究工作台')).toHaveLength(2)
    expect(screen.getByText('官方')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  test('merges local installation and exposes a manual update', async () => {
    listInstalled.mockResolvedValue([
      { smartAppId: 7, releaseId: 16, modelKey: 'model-a', state: 'installed' },
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

  test('keeps publications in the third Smart app section', async () => {
    render(<SmartAppsMarketplacePage api={api()} mode="owned" />)

    expect(screen.getByTestId('smart-apps-section-owned')).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('button', { name: /分享/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发布新版本' })).toBeInTheDocument()
  })
})
