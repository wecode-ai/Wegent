import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { Site, SitesApi } from '@/api/sites'
import { openExternalUrl } from '@/lib/external-links'
import { SitesWorkspace } from './SitesWorkspace'

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

const unpublishedSite: Site = {
  siteid: 'site-1',
  name: '产品发布页',
  slug: 'product',
  internal_url: 'http://sites.internal/product',
  external_url: null,
  publish_status: 'unpublished',
  thumbnail_url: null,
  updated_at: '2026-07-15T05:00:00Z',
}

function createApi(items: Site[] = [unpublishedSite]): SitesApi {
  return {
    listSites: vi.fn().mockResolvedValue({
      items,
      total: items.length,
      offset: 0,
      limit: 20,
    }),
    publishSite: vi.fn().mockResolvedValue({
      ...unpublishedSite,
      publish_status: 'published',
      external_url: 'https://product.example.site',
    }),
  }
}

describe('SitesWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('loads the current user sites and opens the default internal URL', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} />)

    expect(await screen.findByText('产品发布页')).toBeInTheDocument()
    expect(api.listSites).toHaveBeenCalledWith({
      username: 'alice',
      q: '',
      offset: 0,
      limit: 20,
    })

    await userEvent.click(screen.getByTestId('site-internal-url-site-1'))
    expect(openExternalUrl).toHaveBeenCalledWith('http://sites.internal/product')
  })

  test('debounces search and replaces the current results', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '机器人' },
    })

    await waitFor(() => {
      expect(api.listSites).toHaveBeenLastCalledWith({
        username: 'alice',
        q: '机器人',
        offset: 0,
        limit: 20,
      })
    })
  })

  test('publishes to the external internet and displays the generated URL', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-site-1'))

    await waitFor(() => expect(api.publishSite).toHaveBeenCalledWith('site-1'))
    expect(await screen.findByText('https://product.example.site')).toBeInTheDocument()
    expect(screen.getByTestId('site-publish-site-1')).toBeDisabled()
  })

  test('loads the next page without dropping existing sites', async () => {
    const secondSite: Site = {
      ...unpublishedSite,
      siteid: 'site-2',
      name: '机器人学习站',
      internal_url: 'http://sites.internal/robot',
    }
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [unpublishedSite], total: 2, offset: 0, limit: 20 })
      .mockResolvedValueOnce({ items: [secondSite], total: 2, offset: 1, limit: 20 })

    render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} pageSize={1} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))

    expect(await screen.findByText('机器人学习站')).toBeInTheDocument()
    expect(screen.getByText('产品发布页')).toBeInTheDocument()
    expect(api.listSites).toHaveBeenLastCalledWith({
      username: 'alice',
      q: '',
      offset: 1,
      limit: 1,
    })
  })

  test('invokes the create entry from the page header', async () => {
    const onCreate = vi.fn()
    render(<SitesWorkspace api={createApi([])} username="alice" onCreate={onCreate} />)
    await screen.findByText('还没有站点')

    await userEvent.click(screen.getByTestId('sites-create-button'))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})
