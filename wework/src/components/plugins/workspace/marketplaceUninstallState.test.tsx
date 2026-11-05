import { render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { CategoryBrowseDialog } from './CategoryBrowseDialog'
import { MarketplaceCatalogView } from './MarketplaceCatalogView'
import {
  findInstalledPluginForMarketplaceItem,
  isMarketplaceUninstallPending,
  resolveMarketplaceUninstallId,
} from './marketplaceWorkspaceHelpers'

const components = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
}
const labels = {
  install: '安装',
  installing: '正在安装',
  uninstalling: '正在卸载',
  syncing: '同步中',
  retry: '重试',
  try: '使用',
  manage: '管理',
  uninstall: '卸载',
  copy: '复制',
}
const noop = vi.fn()

function listing(id: number, marketplace: string): PluginMarketplaceItem {
  return {
    id,
    name: 'documents',
    displayName: '文档',
    description: '',
    version: '0.1.3',
    visibility: 'public',
    featured: false,
    installed: true,
    installedLocally: true,
    installedPluginId: id,
    enabled: true,
    sourceType: 'marketplace',
    sourceProvider: 'wegent',
    manifest: { marketplaceId: marketplace },
    components,
    ownerUserId: 0,
  }
}

function installed(id: string | number, marketplace: string): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'documents', namespace: marketplace, labels: { id } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: marketplace,
        marketplace,
        pluginKey: 'documents',
      },
      sourcePayload: { marketplaceName: marketplace },
      displayName: '文档',
      description: '',
      version: '0.1.3',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      components,
      packageRef: null,
    },
    status: { state: 'enabled' },
  }
  return {
    id,
    name: '文档',
    description: '',
    version: '0.1.3',
    enabled: true,
    origin: 'market',
    sourceLabel: marketplace,
    distribution: 'public',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

const localId = '269646-wegent-documents-0.1.3'
const items = [listing(54, 'wegent'), listing(55, 'wework-personal')]
const inventory = [
  installed(localId, 'wegent'),
  installed('other-market-install', 'wework-personal'),
]

function view(
  entry: 'grid' | 'search' | 'category',
  pending: ReadonlySet<string>,
  installing = false,
  listings = items,
  installedInventory = inventory
) {
  const all =
    entry === 'search'
      ? [
          ...listings,
          ...Array.from({ length: 45 }, (_, index) => ({
            ...listing(100 + index, 'wegent'),
            name: `filler-${index}`,
            displayName: `Filler ${index}`,
          })),
        ]
      : listings
  const section = { key: 'all', title: '全部', items: all, flat: true }
  const isLocallyUninstalling = (item: PluginMarketplaceItem) =>
    isMarketplaceUninstallPending(item, installedInventory, pending)
  const common = {
    isLoggedIn: true,
    isReconciling: false,
    installingMarketplacePluginIds: new Set<string | number>(installing ? [54] : []),
    isLocallyUninstalling,
    allowPendingRetry: false,
    showPendingAsSyncing: false,
    rowLabels: labels,
    onAction: noop,
  }
  if (entry === 'category')
    return <CategoryBrowseDialog {...common} section={section} onClose={noop} />
  const props: ComponentProps<typeof MarketplaceCatalogView> = {
    ...common,
    hasMarketplace: true,
    marketplaces: [{ key: 'cloud:default', id: 'cloud', name: 'Cloud', kind: 'cloud' }],
    selectedMarketplaceKey: 'cloud:default',
    selectedDistributionTab: 'all',
    marketplaceSourceFilterKey: '',
    marketplaceDistributionLabels: {
      official: '官方',
      workspace: '企业',
      personal: '个人',
      public: '公开',
      external: '外部',
    },
    localMarketplaceTabs: [],
    query: entry === 'search' ? 'doc' : '',
    searchInputRef: { current: null },
    scrollRef: { current: null },
    installedStrip: null,
    showInstalledStrip: false,
    pluginMarketplaceState: { items: all, isLoading: false, error: null },
    marketplaceLoadingMessage: '',
    isMarketplaceRefreshing: false,
    isMarketplaceSearchUpdating: false,
    isOpenAiOfficialViewLoading: false,
    normalizedQuery: entry === 'search' ? 'doc' : '',
    visibleMarketplaceItems: all,
    marketplaceCategorySections: [section],
    visibleSearchResultLimit: 100,
    onSelectDistributionTab: noop,
    onSelectLocalMarketplaceTab: noop,
    onQueryChange: noop,
    onRefresh: noop,
    onClearFilters: noop,
    onRevealMore: noop,
  }
  return <MarketplaceCatalogView {...props} />
}

test('the local operation uses the same resolved installation ID as uninstall execution', () => {
  expect(resolveMarketplaceUninstallId(items[0], inventory)).toBe(localId)
  expect(isMarketplaceUninstallPending(items[0], inventory, new Set([localId]))).toBe(true)
  expect(isMarketplaceUninstallPending(items[1], inventory, new Set([localId]))).toBe(false)
  expect(isMarketplaceUninstallPending(items[0], inventory, new Set(['54']))).toBe(false)
  expect(
    isMarketplaceUninstallPending(listing(54, 'wegent'), [installed(54, 'wegent')], new Set(['54']))
  ).toBe(true)
})

test.each(['grid', 'search', 'category'] as const)(
  '%s does not associate an uninstalled listing with another marketplace store directory',
  async entry => {
    const otherId = '269647-wework-personal-documents-0.1.3'
    const other = installed(otherId, 'wework-personal')
    // Provider/namespace are generic here; explicit source marketplace wins.
    other.raw.spec.source.providerKey = 'wegent'
    other.raw.metadata.namespace = 'default'
    const uninstalled = {
      ...items[0],
      installed: false,
      installedLocally: false,
      installedPluginId: null,
    }
    render(view(entry, new Set([otherId]), false, [uninstalled, items[1]], [other]))
    const row = await screen.findByTestId('plugin-marketplace-row-54')
    expect(within(row).queryByRole('status')).not.toBeInTheDocument()
    expect(within(row).getByTestId('plugin-marketplace-install-54')).toHaveTextContent('安装')
    expect(screen.getByRole('status', { name: '正在卸载 文档' })).toBeInTheDocument()
    expect(resolveMarketplaceUninstallId(uninstalled, [other])).toBe('documents@wegent')
  }
)

test('recognizes the same cloud marketplace alias without matching unrelated legacy directories', () => {
  const local = installed(localId, 'wework')
  expect(resolveMarketplaceUninstallId(items[0], [local])).toBe(localId)
  const unrelated = installed('299-wegent-documents-0.1.3', 'wegent')
  unrelated.raw.spec.source.pluginKey = '299-wegent-documents-0.1.3'
  expect(resolveMarketplaceUninstallId(items[0], [unrelated, local])).toBe(localId)
})

test.each(
  (['grid', 'search', 'category'] as const).flatMap(entry =>
    (['cloud', 'local'] as const).map(kind => ({ entry, kind }))
  )
)('$entry isolates same-name plugins with different cloud IDs ($kind)', async ({ entry, kind }) => {
  const otherId = kind === 'cloud' ? 62 : '62-wegent-documents-0.1.3'
  const other = installed(otherId, 'wegent')
  if (kind === 'cloud') other.raw.spec.pluginId = 55
  else other.raw.spec.sourcePayload = { marketplaceName: 'wegent', cloudPluginId: 55 }
  const uninstalled = {
    ...listing(54, 'wegent'),
    installed: false,
    installedLocally: false,
    installedPluginId: null,
  }
  const installedListing = { ...listing(55, 'wegent'), installedPluginId: otherId }
  render(view(entry, new Set([String(otherId)]), false, [uninstalled, installedListing], [other]))
  const row = await screen.findByTestId('plugin-marketplace-row-54')
  expect(within(row).queryByRole('status')).not.toBeInTheDocument()
  expect(within(row).getByTestId('plugin-marketplace-install-54')).toHaveTextContent('安装')
  expect(
    within(screen.getByTestId('plugin-marketplace-row-55')).getByRole('status', {
      name: '正在卸载 文档',
    })
  ).toBeInTheDocument()
  expect(findInstalledPluginForMarketplaceItem(uninstalled, [other])).toBeNull()
  expect(resolveMarketplaceUninstallId(uninstalled, [other])).toBe('documents@wegent')
})

test.each(['cloud', 'local'] as const)(
  'prefers the explicit cloud identity over a same-name record after a rename (%s)',
  kind => {
    const other = installed(62, 'wegent')
    other.raw.spec.pluginId = 55
    const matching = installed(localId, 'wegent')
    if (kind === 'cloud') matching.raw.spec.pluginId = 54
    else matching.raw.spec.sourcePayload = { marketplaceName: 'wegent', cloudPluginId: 54 }
    matching.raw.spec.source.pluginKey = 'renamed-documents'
    matching.raw.metadata.name = 'renamed-documents'
    const target = { ...listing(54, 'wegent'), installedPluginId: null }
    expect(findInstalledPluginForMarketplaceItem(target, [other, matching])).toBe(matching)
    expect(resolveMarketplaceUninstallId(target, [other, matching])).toBe(localId)
  }
)

test('does not choose an arbitrary store directory when the marketplace is unknown', () => {
  const unknown = { ...items[0], manifest: {}, installedPluginId: null }
  const first = installed('299-wegent-documents-0.1.3', 'wegent')
  const second = installed('300-wework-personal-documents-0.1.3', 'wework-personal')
  first.raw.spec.source.pluginKey = String(first.id)
  second.raw.spec.source.pluginKey = String(second.id)
  expect(resolveMarketplaceUninstallId(unknown, [first, second])).toBe(54)
})

test.each(['grid', 'search', 'category'] as const)(
  '%s immediately shows local uninstall and restores actions after failure',
  async entry => {
    const result = render(view(entry, new Set()))
    const row = await screen.findByTestId('plugin-marketplace-row-54')
    expect(within(row).getByTestId('plugin-marketplace-actions-54')).toBeInTheDocument()
    result.rerender(view(entry, new Set([localId])))
    await waitFor(() =>
      expect(within(row).getByRole('status', { name: '正在卸载 文档' })).toBeInTheDocument()
    )
    expect(
      within(screen.getByTestId('plugin-marketplace-row-55')).queryByRole('status')
    ).not.toBeInTheDocument()
    result.rerender(view(entry, new Set()))
    expect(within(row).queryByRole('status')).not.toBeInTheDocument()
    expect(within(row).getByTestId('plugin-marketplace-actions-54')).toBeInTheDocument()
  }
)

test.each(['grid', 'search', 'category'] as const)(
  '%s finishes a quick uninstall and keeps reinstall ahead of an old device receipt',
  async entry => {
    const result = render(view(entry, new Set([localId])))
    await screen.findByRole('status', { name: '正在卸载 文档' })
    const removed = [
      { ...items[0], installed: false, installedLocally: false, installedPluginId: null },
      items[1],
    ]
    result.rerender(view(entry, new Set(), false, removed))
    expect(screen.queryByRole('status', { name: '正在卸载 文档' })).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-marketplace-install-54')).toHaveTextContent('安装')
    const stale = [
      {
        ...removed[0],
        currentDeviceInstallation: {
          deviceId: 'device',
          state: 'uninstalling' as const,
          desiredReleaseId: 1,
          attemptCount: 0,
          updatedAt: '2026-11-05T00:00:00Z',
        },
      },
      items[1],
    ]
    result.rerender(view(entry, new Set(), true, stale))
    expect(screen.getByRole('status', { name: '正在安装 文档' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '正在卸载 文档' })).not.toBeInTheDocument()
  }
)
