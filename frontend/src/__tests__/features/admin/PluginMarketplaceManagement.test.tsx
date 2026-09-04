// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis, type AdminMarketplacePlugin } from '@/apis/admin'
import PluginMarketplaceManagement from '@/features/admin/components/PluginMarketplaceManagement'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getMarketplacePlugins: jest.fn(),
    updateMarketplacePlugin: jest.fn(),
  },
}))

const toastMock = jest.fn()
const tMock = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: tMock }),
}))

const plugins: AdminMarketplacePlugin[] = [
  {
    id: 11,
    catalog_namespace: 'wework-official',
    name: 'product-design',
    display_name: 'Product Design',
    description: 'Explore ideas and build prototypes',
    version: '1.2.0',
    author: 'Wegent',
    featured_rank: 98,
    is_listed: true,
    created_at: '2026-08-20T01:00:00Z',
    updated_at: '2026-09-03T01:00:00Z',
  },
  {
    id: 22,
    catalog_namespace: 'enterprise',
    name: 'company-mail',
    display_name: 'Company Mail',
    description: 'Search and send company email',
    version: '0.4.0',
    author: 'Enterprise',
    featured_rank: 80,
    is_listed: false,
    created_at: '2026-08-21T01:00:00Z',
    updated_at: '2026-09-02T01:00:00Z',
  },
]

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('PluginMarketplaceManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getMarketplacePlugins.mockResolvedValue({
      items: plugins,
      total: plugins.length,
      page: 1,
      limit: 20,
    })
    mockedAdminApis.updateMarketplacePlugin.mockImplementation(async (pluginId, update) => ({
      ...plugins.find(plugin => plugin.id === pluginId)!,
      ...update,
    }))
  })

  it('loads managed plugins and saves description, score, and listing changes', async () => {
    render(<PluginMarketplaceManagement />)

    expect(await screen.findByTestId('plugin-management-row-11')).toBeInTheDocument()
    expect(mockedAdminApis.getMarketplacePlugins).toHaveBeenCalledWith(1, 20, {
      search: '',
      source: 'all',
      listingStatus: 'all',
      scoreOrder: 'desc',
    })
    expect(screen.queryByTestId('plugin-management-description')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('plugin-management-row-11'))
    expect(screen.getByTestId('plugin-management-detail-drawer')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('plugin-management-description'), {
      target: { value: 'Updated product design description' },
    })
    fireEvent.change(screen.getByTestId('plugin-management-score'), {
      target: { value: '96' },
    })
    fireEvent.click(screen.getByTestId('plugin-management-listing-unlisted'))
    fireEvent.click(screen.getByTestId('plugin-management-save'))

    await waitFor(() =>
      expect(mockedAdminApis.updateMarketplacePlugin).toHaveBeenCalledWith(11, {
        description: 'Updated product design description',
        featured_rank: 96,
        is_listed: false,
      })
    )

    fireEvent.click(screen.getByTestId('plugin-management-detail-close'))
    await waitFor(() =>
      expect(screen.getByTestId('plugin-management-detail-drawer')).toHaveAttribute(
        'data-state',
        'closed'
      )
    )
    expect(screen.queryByTestId('plugin-management-description')).not.toBeInTheDocument()
  })

  it('switches selection and requests ascending recommendation-score order', async () => {
    render(<PluginMarketplaceManagement />)

    await screen.findByTestId('plugin-management-row-11')
    fireEvent.click(screen.getByTestId('plugin-management-row-22'))

    expect(screen.getByTestId('plugin-management-detail-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-management-description')).toHaveValue(
      'Search and send company email'
    )

    fireEvent.click(screen.getByTestId('plugin-management-score-sort'))

    await waitFor(() =>
      expect(mockedAdminApis.getMarketplacePlugins).toHaveBeenLastCalledWith(
        1,
        20,
        expect.objectContaining({ scoreOrder: 'asc' })
      )
    )
  })

  it('ignores a stale list response after a newer search completes', async () => {
    render(<PluginMarketplaceManagement />)
    await screen.findByTestId('plugin-management-row-11')

    let resolveSlow: (value: {
      items: AdminMarketplacePlugin[]
      total: number
      page: number
      limit: number
    }) => void = () => undefined
    const slowResponse = new Promise<{
      items: AdminMarketplacePlugin[]
      total: number
      page: number
      limit: number
    }>(resolve => {
      resolveSlow = resolve
    })
    mockedAdminApis.getMarketplacePlugins.mockImplementation(async (_page, _limit, filters) => {
      if (filters?.search === 'slow') return slowResponse
      if (filters?.search === 'fast') {
        return {
          items: [{ ...plugins[1], id: 33, display_name: 'Fast result' }],
          total: 1,
          page: 1,
          limit: 20,
        }
      }
      return { items: plugins, total: plugins.length, page: 1, limit: 20 }
    })

    fireEvent.change(screen.getByTestId('plugin-management-search'), {
      target: { value: 'slow' },
    })
    await waitFor(() => expect(mockedAdminApis.getMarketplacePlugins).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByTestId('plugin-management-search'), {
      target: { value: 'fast' },
    })
    await waitFor(() =>
      expect(mockedAdminApis.getMarketplacePlugins).toHaveBeenLastCalledWith(
        1,
        20,
        expect.objectContaining({ search: 'fast' })
      )
    )
    expect((await screen.findAllByText('Fast result')).length).toBeGreaterThan(0)

    await act(async () => {
      resolveSlow({
        items: [{ ...plugins[0], id: 44, display_name: 'Stale result' }],
        total: 1,
        page: 1,
        limit: 20,
      })
      await slowResponse
    })

    expect(screen.getAllByText('Fast result').length).toBeGreaterThan(0)
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
  })
})
