// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { WikiBoundDocument, WikiPageSummary } from '@/apis/wiki'

const mockListConnections = jest.fn()
const mockListKbWikiDocuments = jest.fn()
const mockListPages = jest.fn()
const mockUnbind = jest.fn()
const mockMissingTranslationKeys = new Set<string>()
const mockTranslations = {
  common: jest.requireActual('@/i18n/locales/zh-CN/common.json'),
  knowledge: jest.requireActual('@/i18n/locales/zh-CN/knowledge.json'),
}
const mockTranslate = (key: string, params?: Record<string, string | number>) => {
  const separatorIndex = key.indexOf(':')
  const namespace = separatorIndex >= 0 ? key.slice(0, separatorIndex) : 'knowledge'
  const resourceKey = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key
  if (mockMissingTranslationKeys.has(resourceKey)) return resourceKey
  const translations = mockTranslations[namespace as keyof typeof mockTranslations]
  const translation = resourceKey
    .split('.')
    .reduce<unknown>(
      (value, segment) =>
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)[segment]
          : undefined,
      translations
    )
  const template = typeof translation === 'string' ? translation : key
  if (!params) return template
  return Object.entries(params).reduce(
    (acc, [name, value]) => acc.replace(`{{${name}}}`, String(value)),
    template
  )
}

jest.mock('@/apis/wiki', () => ({
  wikiApis: {
    listConnections: () => mockListConnections(),
    listKbWikiDocuments: (...args: unknown[]) => mockListKbWikiDocuments(...(args as [])),
    unbindKbWikiDocument: (...args: unknown[]) => mockUnbind(...args),
    listPages: (...args: unknown[]) => mockListPages(...args),
    bindKbWikiDocuments: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

const { WikiDocumentImport } = jest.requireActual(
  '@/features/knowledge/document/components/WikiDocumentImport'
)

const bound: WikiBoundDocument = {
  id: 31,
  page_id: '1',
  name: 'Elasticsearch 排查',
  path: 'tech-wiki/elasticsearch',
  locale: 'zh',
  page_updated_at: '',
  resource_url: 'https://wiki.example.com/tech-wiki/elasticsearch',
  status: 'success',
  connection_id: 'conn-primary',
}

const pages: WikiPageSummary[] = [
  {
    id: '1',
    path: 'tech-wiki/elasticsearch',
    title: 'Elasticsearch 排查',
    description: '',
    updated_at: '',
    tags: [],
    locale: 'zh',
    is_published: true,
    page_url: 'https://wiki.example.com/tech-wiki/elasticsearch',
  },
  {
    id: '2',
    path: 'tech-wiki/etcd',
    title: 'etcd 延迟抖动',
    description: '',
    updated_at: '',
    tags: [],
    locale: 'zh',
    is_published: true,
    page_url: 'https://wiki.example.com/tech-wiki/etcd',
  },
]

function renderTab(
  onImport: (
    paths: string[],
    options: { connectionId?: string; sync: boolean }
  ) => Promise<unknown> = jest.fn()
) {
  return render(
    <WikiDocumentImport
      knowledgeBaseId={12}
      onImport={onImport as never}
      onDraftChange={jest.fn()}
      canManageDocuments
      renderFooter={(action: React.ReactNode, status?: React.ReactNode) => (
        <div>
          <div data-testid="footer-status">{status}</div>
          <div data-testid="footer-action">{action}</div>
        </div>
      )}
    />
  )
}

describe('WikiDocumentImport', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMissingTranslationKeys.clear()
    mockListConnections.mockResolvedValue({
      connections: [
        {
          id: 'conn-primary',
          display_name: 'Primary Wiki',
          enabled: true,
          connector_type: 'wikijs',
          site_url: 'https://wiki.example.com',
          default_locale: 'zh',
          api_key_masked: '****',
          available_connectors: [{ type: 'wikijs', display_name: 'Wiki.js' }],
        },
      ],
      available_connectors: [{ type: 'wikijs', display_name: 'Wiki.js' }],
    })
    mockListKbWikiDocuments.mockResolvedValue([bound])
    mockListPages.mockResolvedValue({ pages, next_offset: null, warnings: [] })
  })

  it('shows bound documents and the site header', async () => {
    renderTab()
    await waitFor(() =>
      expect(screen.getByTestId('wiki-import-site')).toHaveTextContent('wiki.example.com')
    )
    expect(await screen.findByTestId('wiki-import-bound-31')).toBeInTheDocument()
    expect(await screen.findByTestId('wiki-import-connection-status')).toHaveClass('text-success')
  })

  it('never exposes the select-all translation key while a refreshed bundle is pending', async () => {
    mockMissingTranslationKeys.add('wikiSection.select_all')
    mockMissingTranslationKeys.add('wikiSection.clear_selection')
    renderTab()

    await screen.findByTestId('wiki-import-page-list')

    expect(screen.getByTestId('wiki-import-select-all')).toHaveTextContent('选择全部')
    expect(screen.getByTestId('wiki-import-select-all')).not.toHaveTextContent(
      'wikiSection.select_all'
    )

    fireEvent.click(screen.getByTestId('wiki-import-select-all'))
    expect(screen.getByTestId('wiki-import-select-all')).toHaveTextContent('取消全部选择')
    expect(screen.getByTestId('wiki-import-select-all')).not.toHaveTextContent(
      'wikiSection.clear_selection'
    )
  })

  it('shows a red connection status with the failure reason on hover', async () => {
    mockListPages.mockRejectedValue(new Error('Wiki 授权已失效'))
    renderTab()

    const status = await screen.findByTestId('wiki-import-connection-status')
    await waitFor(() => expect(status).toHaveAttribute('data-status', 'failed'))
    expect(status).toHaveClass('text-error')
    expect(status).toHaveAttribute('title', '连接失败：Wiki 授权已失效')
  })

  it('keeps the page picker out of the fixed footer', async () => {
    renderTab()

    await screen.findByTestId('wiki-import-page-list')

    expect(screen.getByTestId('footer-status')).toBeEmptyDOMElement()
  })

  it('refreshes the wiki page list on demand', async () => {
    const refreshedPage = {
      ...pages[1],
      id: '3',
      path: 'tech-wiki/new-page',
      title: '新发布页面',
    }
    mockListPages
      .mockResolvedValueOnce({ pages, next_offset: null, warnings: [] })
      .mockResolvedValueOnce({ pages: [refreshedPage], next_offset: null, warnings: [] })
    renderTab()

    await screen.findByTestId('wiki-import-page-list')
    const refreshButton = screen.getByTestId('wiki-import-refresh-button')
    expect(refreshButton).toHaveTextContent('刷新')
    fireEvent.click(refreshButton)

    expect(await screen.findByText('新发布页面')).toBeInTheDocument()
    expect(mockListPages).toHaveBeenLastCalledWith({
      limit: 200,
      connection_id: 'conn-primary',
      refresh: true,
    })
  })

  it('shows a localized warning when the backend truncates a large wiki', async () => {
    mockListPages.mockResolvedValue({
      pages,
      next_offset: null,
      warnings: ['wiki_page_list_truncated'],
    })
    renderTab()

    expect(await screen.findByTestId('wiki-import-page-warning')).toHaveTextContent(
      '该站点页面数量超过浏览上限'
    )
  })

  it('expands and collapses wiki path directories while search reveals matches', async () => {
    mockListPages.mockResolvedValue({
      pages: [
        ...pages,
        {
          ...pages[1],
          id: '3',
          path: 'tech-wiki/guides/install',
          title: '安装指南',
        },
      ],
      next_offset: null,
      warnings: [],
    })
    renderTab()

    const directory = await screen.findByTestId('wiki-import-directory-tech-wiki')
    expect(directory).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('wiki-import-check-tech-wiki/etcd')).toBeInTheDocument()

    fireEvent.click(directory)
    expect(directory).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('wiki-import-check-tech-wiki/etcd')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('wiki-import-search-input'), {
      target: { value: 'etcd' },
    })
    expect(screen.getByTestId('wiki-import-check-tech-wiki/etcd')).toBeInTheDocument()
  })

  it('keeps selection across picker pages and selects every filtered unbound page', async () => {
    const pagedPages = Array.from({ length: 25 }, (_, index) => ({
      ...pages[1],
      id: String(index + 1),
      path: `wiki/page-${String(index + 1).padStart(2, '0')}`,
      title: `Wiki Page ${index + 1}`,
    }))
    mockListPages.mockResolvedValue({ pages: pagedPages, next_offset: null, warnings: [] })
    renderTab()

    await screen.findByTestId('wiki-import-check-wiki/page-01')
    expect(screen.queryByTestId('wiki-import-check-wiki/page-21')).not.toBeInTheDocument()
    expect(screen.getByTestId('wiki-import-select-all')).toHaveTextContent('全选')
    fireEvent.click(screen.getByTestId('wiki-import-check-wiki/page-01'))
    fireEvent.click(screen.getByTestId('pagination-next'))

    expect(await screen.findByTestId('wiki-import-check-wiki/page-21')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wiki-import-select-all'))
    expect(screen.getByTestId('wiki-import-select-all')).toHaveTextContent('取消全选')
    expect(screen.getByTestId('wiki-import-submit-button')).toHaveTextContent('绑定选中（25）')

    fireEvent.click(screen.getByTestId('pagination-prev'))
    expect(await screen.findByTestId('wiki-import-check-wiki/page-01')).toBeChecked()
  })

  it('sorts by directory before pagination so sibling pages stay together when possible', async () => {
    const interleavedPages = [
      { ...pages[1], id: 'a-1', path: 'alpha/first', title: 'Alpha first' },
      ...Array.from({ length: 19 }, (_, index) => ({
        ...pages[1],
        id: `beta-${index + 1}`,
        path: `beta/page-${String(index + 1).padStart(2, '0')}`,
        title: `Beta ${index + 1}`,
      })),
      { ...pages[1], id: 'a-2', path: 'alpha/last', title: 'Alpha last' },
    ]
    mockListPages.mockResolvedValue({ pages: interleavedPages, next_offset: null, warnings: [] })
    mockListKbWikiDocuments.mockResolvedValue([])
    renderTab()

    expect(await screen.findByTestId('wiki-import-check-alpha/first')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-import-check-alpha/last')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('pagination-next'))
    expect(screen.queryByTestId('wiki-import-check-alpha/first')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wiki-import-check-alpha/last')).not.toBeInTheDocument()
  })

  it('selects a directory across picker pages and supports partial and cleared states', async () => {
    const directoryPages = Array.from({ length: 25 }, (_, index) => ({
      ...pages[1],
      id: String(index + 1),
      path: `guides/page-${String(index + 1).padStart(2, '0')}`,
      title: `Guide ${index + 1}`,
    }))
    mockListPages.mockResolvedValue({ pages: directoryPages, next_offset: null, warnings: [] })
    mockListKbWikiDocuments.mockResolvedValue([
      { ...bound, id: 51, page_id: '2', path: 'guides/page-02', name: 'Guide 2' },
    ])
    renderTab()

    const directoryCheck = (await screen.findByTestId(
      'wiki-import-directory-check-guides'
    )) as HTMLInputElement
    fireEvent.click(screen.getByTestId('wiki-import-check-guides/page-01'))
    expect(directoryCheck.indeterminate).toBe(true)

    fireEvent.click(directoryCheck)
    expect(directoryCheck).toBeChecked()
    expect(screen.getByTestId('wiki-import-check-guides/page-02')).toBeDisabled()
    expect(screen.getByTestId('wiki-import-submit-button')).toHaveTextContent('绑定选中（24）')

    fireEvent.click(screen.getByTestId('pagination-next'))
    expect(await screen.findByTestId('wiki-import-check-guides/page-21')).toBeChecked()

    fireEvent.click(screen.getByTestId('wiki-import-directory-check-guides'))
    expect(screen.getByTestId('wiki-import-submit-button')).toHaveTextContent('绑定选中（0）')
  })

  it('excludes already bound pages from select all', async () => {
    renderTab()

    await screen.findByTestId('wiki-import-check-tech-wiki/etcd')
    fireEvent.click(screen.getByTestId('wiki-import-select-all'))

    expect(screen.getByTestId('wiki-import-check-tech-wiki/elasticsearch')).not.toBeChecked()
    expect(screen.getByTestId('wiki-import-check-tech-wiki/etcd')).toBeChecked()
    expect(screen.getByTestId('wiki-import-submit-button')).toHaveTextContent('绑定选中（1）')
  })

  it('loads every backend page before applying picker pagination', async () => {
    const firstBatch = Array.from({ length: 200 }, (_, index) => ({
      ...pages[1],
      id: String(index + 1),
      path: `wiki/bulk-${index + 1}`,
      title: `Bulk page ${index + 1}`,
    }))
    const lastPage = {
      ...pages[1],
      id: '201',
      path: 'wiki/bulk-201',
      title: 'Bulk page 201',
    }
    mockListPages
      .mockResolvedValueOnce({ pages: firstBatch, next_offset: 200, warnings: [] })
      .mockResolvedValueOnce({ pages: [lastPage], next_offset: null, warnings: [] })
    renderTab()

    await waitFor(() =>
      expect(screen.getByTestId('wiki-import-page-count')).toHaveTextContent('201')
    )
    expect(mockListPages).toHaveBeenNthCalledWith(2, {
      limit: 200,
      connection_id: 'conn-primary',
      offset: 200,
    })
  })

  it('disables bound paths and enables submit for new selections', async () => {
    renderTab()

    await screen.findByTestId('wiki-import-bound-31')
    const boundCheck = (await screen.findByTestId(
      'wiki-import-check-tech-wiki/elasticsearch'
    )) as HTMLInputElement
    expect(boundCheck.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('wiki-import-check-tech-wiki/etcd'))
    // Selection drives the footer action: the submit button enables.
    await waitFor(() => expect(screen.getByTestId('wiki-import-submit-button')).not.toBeDisabled())
  })

  it('renders connection guidance when not configured', async () => {
    mockListConnections.mockResolvedValue({ connections: [], available_connectors: [] })
    renderTab()
    expect(await screen.findByTestId('wiki-import-need-connection')).toBeInTheDocument()
  })

  it('unbinds a bound document from the list', async () => {
    mockUnbind.mockResolvedValue(undefined)
    mockListKbWikiDocuments.mockResolvedValueOnce([bound]).mockResolvedValue([])
    renderTab()

    fireEvent.click(await screen.findByTestId('wiki-import-unbind-31'))
    await waitFor(() => expect(mockUnbind).toHaveBeenCalledWith(12, 31))
  })

  it('imports from a selected connection in synchronized mode', async () => {
    mockListConnections.mockResolvedValue({
      connections: [
        {
          id: 'conn-b',
          display_name: 'Operations',
          enabled: true,
          site_url: 'https://ops.example.com',
        },
        {
          id: 'conn-a',
          display_name: 'Engineering',
          enabled: true,
          site_url: 'https://eng.example.com',
        },
      ],
      available_connectors: [],
    })
    const onImport = jest.fn().mockResolvedValue({ createdCount: 1 })
    renderTab(onImport)

    const selector = await screen.findByTestId('wiki-import-connection-select')
    expect(selector).toHaveValue('conn-b')
    await waitFor(() =>
      expect(screen.getByTestId('wiki-import-site')).toHaveTextContent('ops.example.com')
    )
    fireEvent.click(await screen.findByTestId('wiki-import-check-tech-wiki/etcd'))
    await waitFor(() => expect(screen.getByTestId('wiki-import-submit-button')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('wiki-import-submit-button'))

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(['2'], {
        connectionId: 'conn-b',
      })
    )
  })

  it('keeps same-path pages in different locales as distinct selections', async () => {
    mockListKbWikiDocuments.mockResolvedValue([])
    mockListPages.mockResolvedValue({
      pages: [
        { ...pages[1], id: '2-en', locale: 'en' },
        { ...pages[1], id: '2-zh', locale: 'zh' },
      ],
      next_offset: null,
      warnings: [],
    })
    const onImport = jest.fn().mockResolvedValue({ createdCount: 1 })
    renderTab(onImport)

    const checkboxes = await screen.findAllByTestId('wiki-import-check-tech-wiki/etcd')
    expect(checkboxes).toHaveLength(2)
    fireEvent.click(checkboxes[1])
    fireEvent.click(screen.getByTestId('wiki-import-submit-button'))

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(['2-zh'], {
        connectionId: 'conn-primary',
      })
    )
  })

  it('unbinds synchronized wiki documents from the bound list', async () => {
    mockUnbind.mockResolvedValue(undefined)
    mockListKbWikiDocuments.mockResolvedValueOnce([{ ...bound, id: 32 }]).mockResolvedValue([])
    renderTab()

    fireEvent.click(await screen.findByTestId('wiki-import-unbind-32'))

    await waitFor(() => expect(mockUnbind).toHaveBeenCalledWith(12, 32))
  })

  it('keeps the page picker visible when many wiki documents are bound', async () => {
    mockListKbWikiDocuments.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        ...bound,
        id: index + 100,
        name: `已绑定 Wiki ${index + 1}`,
        path: `wiki/bound-${index + 1}`,
      }))
    )
    renderTab()

    expect(await screen.findByTestId('wiki-import-bound-list')).toHaveClass('h-24', 'shrink-0')
    expect(screen.getByTestId('wiki-import-page-picker')).toHaveClass('min-h-48', 'shrink-0')
    expect(screen.getByTestId('wiki-import-content')).toHaveClass('overflow-y-auto')
  })

  it('searches bound documents and shows result counts for both lists', async () => {
    mockListKbWikiDocuments.mockResolvedValue([
      bound,
      {
        ...bound,
        id: 32,
        name: 'etcd 延迟抖动',
        path: 'tech-wiki/etcd',
      },
    ])
    renderTab()

    await screen.findByTestId('wiki-import-page-list')
    expect(screen.getByTestId('wiki-import-bound-count')).toHaveTextContent('2')
    expect(screen.getByTestId('wiki-import-page-count')).toHaveTextContent('2')

    fireEvent.change(screen.getByTestId('wiki-import-bound-search-input'), {
      target: { value: 'etcd' },
    })

    expect(screen.queryByTestId('wiki-import-bound-31')).not.toBeInTheDocument()
    expect(screen.getByTestId('wiki-import-bound-32')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-import-bound-count')).toHaveTextContent('1')

    fireEvent.change(screen.getByTestId('wiki-import-search-input'), {
      target: { value: 'etcd' },
    })
    expect(screen.getByTestId('wiki-import-page-count')).toHaveTextContent('1')
  })

  it('uses translated search copy and avoids short latin infix matches', async () => {
    mockListKbWikiDocuments.mockResolvedValue([
      {
        ...bound,
        id: 41,
        name: 'ES 深度分页优化：从 from-size 迁移至 search_after（案例-1）',
      },
      {
        ...bound,
        id: 42,
        name: 'Redis 延迟毛刺排查：系统透明大页（THP）与 AOF 刷盘（案例-2）',
        path: 'tech-wiki/redis',
      },
    ])
    renderTab()

    await screen.findByTestId('wiki-import-page-list')
    const search = await screen.findByTestId('wiki-import-bound-search-input')
    expect(search).toHaveAttribute('placeholder', '搜索标题或路径')

    fireEvent.change(search, { target: { value: 'ES' } })

    expect(screen.getByTestId('wiki-import-bound-41')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-import-bound-42')).not.toBeInTheDocument()
    expect(screen.getByTestId('wiki-import-bound-count')).toHaveTextContent('1')

    fireEvent.change(search, { target: { value: '深度分页' } })
    expect(screen.getByTestId('wiki-import-bound-41')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-import-bound-42')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'AOF' } })
    expect(screen.queryByTestId('wiki-import-bound-41')).not.toBeInTheDocument()
    expect(screen.getByTestId('wiki-import-bound-42')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '不存在的文档' } })
    expect(screen.getByText('没有匹配的文档')).toBeInTheDocument()
  })
})
