import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { CategoryBrowseDialog } from './CategoryBrowseDialog'
import { MarketplaceCatalogView } from './MarketplaceCatalogView'
import { MarketplaceCardGrid } from './MarketplaceCardGrid'
import { PluginMarketplaceRevealButton } from './PluginMarketplaceRevealButton'
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

beforeEach(() => {
  // Model a real viewport and full-height content, rather than treating every
  // element as jsdom's zero-size box. Keep the production virtualizer real.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const viewport = this.classList.contains('overflow-y-auto')
    const contentHeight = Number.parseFloat((this.firstElementChild as HTMLElement)?.style.height)
    const height = viewport ? 240 : Number.isFinite(contentHeight) ? contentHeight : 88
    const scroll = this.closest('.overflow-y-auto')?.scrollTop ?? 0
    return new DOMRect(0, viewport ? 0 : 40 - scroll, 1100, height)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.getBoundingClientRect().height
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1100)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return this.getBoundingClientRect().height
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    return Math.max(
      this.clientHeight,
      ...Array.from(this.querySelectorAll<HTMLElement>('[style]')).map(
        element => (Number.parseFloat(element.style.height) || 0) + 40
      )
    )
  })
})

afterEach(() => vi.restoreAllMocks())

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
  entry: 'grid' | 'search' | 'category' | 'official',
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
    selectedDistributionTab: entry === 'official' ? 'official' : 'all',
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

test('scrolling only resolves operation state for newly visible grid rows', async () => {
  const catalog = Array.from({ length: 200 }, (_, index) => listing(index + 1, 'wegent'))
  const isLocallyUninstalling = vi.fn<(item: PluginMarketplaceItem) => boolean>(() => false)
  const result = render(
    <div className="overflow-y-auto" data-plugin-market-scroll-region="">
      <MarketplaceCardGrid
        items={catalog}
        isLoggedIn
        isReconciling={false}
        installingMarketplacePluginIds={new Set()}
        isLocallyUninstalling={isLocallyUninstalling}
        allowPendingRetry={false}
        labels={labels}
        onAction={noop}
      />
    </div>
  )
  const mountedIds = () =>
    Array.from(result.container.querySelectorAll('article.plugin-market-card')).map(
      card => card.getAttribute('data-testid')!
    )
  const initial = new Set(mountedIds())
  const viewport = result.container.firstElementChild as HTMLElement
  isLocallyUninstalling.mockClear()
  viewport.scrollTop = 96
  fireEvent.scroll(viewport)
  await waitFor(() => expect(mountedIds().some(id => !initial.has(id))).toBe(true))
  expect(isLocallyUninstalling).toHaveBeenCalled()
  const reevaluated = isLocallyUninstalling.mock.calls.map(
    ([item]) => `plugin-marketplace-row-${item.id}`
  )
  expect(reevaluated.filter(id => initial.has(id))).toEqual([])
})

test.each(['official', 'search', 'category'] as const)(
  '%s mounts a viewport-sized slice and follows the actual scroll container',
  async entry => {
    const catalog = Array.from({ length: 200 }, (_, index) => ({
      ...listing(index + 1, 'openai-curated-remote'),
      name: `plugin-${index + 1}`,
      displayName: `Plugin ${index + 1}`,
      installed: false,
      installedLocally: false,
      installedPluginId: null,
    }))
    const result = render(view(entry, new Set(), false, catalog, []))
    const viewport = result.container.querySelector<HTMLElement>('.overflow-y-auto')!
    await screen.findByTestId('plugin-marketplace-row-1')
    expect(result.container.querySelectorAll('article.plugin-market-card').length).toBeLessThan(30)
    expect(screen.queryByTestId('plugin-marketplace-row-180')).not.toBeInTheDocument()
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
    fireEvent.scroll(viewport)
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-marketplace-row-1')).not.toBeInTheDocument()
    )
    expect(result.container.querySelectorAll('article.plugin-market-card').length).toBeLessThan(30)
    expect(result.container.querySelector('article.plugin-market-card')).toBeInTheDocument()
    expect(
      screen.getByTestId(`plugin-marketplace-row-${entry === 'search' ? 100 : 200}`)
    ).toBeInTheDocument()
  }
)

test('the shared grid updates columns after resizing without losing the final plugin', async () => {
  const media = Object.assign(new EventTarget(), {
    matches: true,
    media: '(max-width: 1050px)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })
  vi.spyOn(window, 'matchMedia').mockReturnValue(media)
  const catalog = Array.from({ length: 200 }, (_, index) => listing(index + 1, 'wegent'))
  const result = render(view('official', new Set(), false, catalog, []))
  const first = await screen.findByTestId('plugin-marketplace-row-1')
  expect(first.parentElement?.children).toHaveLength(1)
  act(() => {
    media.matches = false
    media.dispatchEvent(new Event('change'))
  })
  await waitFor(() =>
    expect(screen.getByTestId('plugin-marketplace-row-1').parentElement?.children).toHaveLength(2)
  )
  const viewport = screen.getByTestId('plugins-market-scroll-region')
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
  fireEvent.scroll(viewport)
  await screen.findByTestId('plugin-marketplace-row-200')
  expect(result.container.querySelectorAll('article.plugin-market-card').length).toBeLessThan(30)
})

test('marketplace cards defer logo fetching and decoding in categorized previews', async () => {
  const item = {
    ...listing(54, 'openai-curated-remote'),
    interface: { logo: 'https://example.com/plugin.png' },
  }
  render(view('official', new Set(), false, [item], []))
  const row = await screen.findByTestId('plugin-marketplace-row-54')
  expect(row.querySelector('img')).toHaveAttribute('loading', 'lazy')
  expect(row.querySelector('img')).toHaveAttribute('decoding', 'async')
  fireEvent.error(row.querySelector('img')!)
  expect(row.querySelector('img')).not.toBeInTheDocument()
})

test('more previews defer their icons while keeping the category action available', () => {
  const onReveal = vi.fn()
  const items = [1, 2, 3].map(id => ({
    ...listing(id, 'openai-curated-remote'),
    interface: { logo: `https://example.com/${id}.png` },
  }))
  const result = render(
    <PluginMarketplaceRevealButton items={items} label="更多" onReveal={onReveal} />
  )
  expect(result.container.querySelectorAll('img')).toHaveLength(3)
  for (const image of result.container.querySelectorAll('img')) {
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
  }
  fireEvent.click(screen.getByRole('button', { name: '更多' }))
  expect(onReveal).toHaveBeenCalledOnce()
})

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
