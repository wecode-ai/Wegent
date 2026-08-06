import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ApiError } from '@/api/http'
import type { MiniProgram, Site, SiteListItem, SitesApi } from '@/api/sites'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { SitesWorkspace } from './SitesWorkspace'

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

const unpublishedSite: Site = {
  app_type: 'web',
  siteid: 'site-1',
  taskid: 'task-1',
  username: 'alice',
  name: '产品发布页',
  slug: 'product',
  network: 'inner',
  internal_url: 'http://sites.internal/product',
  external_url: null,
  publish_status: 'unpublished',
  thumbnail_url: null,
  created_at: '2026-07-15T04:00:00Z',
  updated_at: '2026-07-15T05:00:00Z',
}

const miniProgram: MiniProgram = {
  app_type: 'miniapp',
  siteid: 'mini-1',
  taskid: 'task-mini-1',
  username: 'alice',
  name: '微博活动助手',
  slug: 'campaign',
  app_id: '1234567890',
  status: 'experience',
  version: '1.2.0',
  experience_url: 'https://example.com/mini-experience',
  thumbnail_url: null,
  created_at: '2026-07-16T04:00:00Z',
  updated_at: '2026-07-16T05:00:00Z',
}

function createApi(items: SiteListItem[] = [unpublishedSite]): SitesApi {
  return {
    listApplicationTypes: vi.fn().mockResolvedValue({
      items: [
        {
          app_type: 'web',
          enabled: true,
          order: 10,
          capabilities: ['create', 'publish', 'delete'],
        },
        {
          app_type: 'miniapp',
          enabled: true,
          order: 20,
          capabilities: ['create', 'open_experience'],
        },
      ],
    }),
    listSites: vi.fn().mockResolvedValue({
      items,
      total: items.length,
      offset: 0,
      limit: 20,
    }),
    publishSite: vi.fn().mockResolvedValue({
      ...unpublishedSite,
      network: 'outer',
      publish_status: 'published',
      external_url: 'https://product.example.site',
    }),
    updateSiteNetwork: vi.fn().mockResolvedValue({
      ...unpublishedSite,
      network: 'outer',
      publish_status: 'published',
      external_url: 'https://product.example.site',
    }),
    deleteSite: vi.fn().mockResolvedValue(undefined),
  }
}

describe('SitesWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/sites')
  })

  test('shows an unavailable product state when Backend reports Sites is not configured', async () => {
    const api = createApi()
    vi.mocked(api.listSites).mockRejectedValueOnce(
      new ApiError('Sites is not available yet', 503, 'sites_not_available')
    )
    const onCreate = vi.fn()
    render(<SitesWorkspace api={api} onCreate={onCreate} />)

    expect(await screen.findByTestId('sites-unavailable-state')).toHaveTextContent(
      '应用功能尚未推出'
    )
    expect(screen.queryByTestId('sites-refresh-button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-site-menu-item'))
    expect(onCreate).toHaveBeenCalledWith('web')
    expect(screen.getByTestId('sites-search-input')).toBeInTheDocument()
    expect(screen.queryByTestId('sites-retry-button')).not.toBeInTheDocument()
    expect(screen.queryByText('网络')).not.toBeInTheDocument()
  })

  test('loads the current user sites and opens the default internal URL', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)

    expect(await screen.findByText('产品发布页')).toBeInTheDocument()
    expect(api.listSites).toHaveBeenCalledWith({
      appType: 'web',
      q: '',
      offset: 0,
      limit: 20,
    })

    await userEvent.click(screen.getByTestId('site-internal-url-site-1'))
    expect(openExternalUrl).toHaveBeenCalledWith('http://sites.internal/product')
  })

  test('debounces search and replaces the current results', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '机器人' },
    })

    await waitFor(() => {
      expect(api.listSites).toHaveBeenLastCalledWith({
        appType: 'web',
        q: '机器人',
        offset: 0,
        limit: 20,
      })
    })
  })

  test('switches a site between inner and outer network scopes', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    expect(screen.getByTestId('site-network-site-1')).toHaveTextContent('内网')
    expect(screen.getByTestId('site-publish-site-1')).toHaveTextContent('发布到外网')

    await userEvent.click(screen.getByTestId('site-publish-site-1'))

    await waitFor(() => expect(api.updateSiteNetwork).toHaveBeenCalledWith('site-1', 'outer'))
    expect(screen.getByTestId('site-network-site-1')).toHaveTextContent('外网')
    expect(screen.getByTestId('site-publish-site-1')).toHaveTextContent('发布到内网')

    vi.mocked(api.updateSiteNetwork).mockResolvedValueOnce({
      ...unpublishedSite,
      network: 'inner',
      publish_status: 'unpublished',
      external_url: null,
    })
    await userEvent.click(screen.getByTestId('site-publish-site-1'))
    await waitFor(() => expect(api.updateSiteNetwork).toHaveBeenLastCalledWith('site-1', 'inner'))
    expect(screen.getByTestId('site-network-site-1')).toHaveTextContent('内网')
  })

  test('keeps the network unchanged while outer publish security checking is pending', async () => {
    const api = createApi()
    vi.mocked(api.updateSiteNetwork).mockRejectedValueOnce(
      new ApiError('Outer network exposure security audit has been requeued', 409, undefined, {
        error: {
          code: 'SECURITY_CHECKING',
          message: 'Outer network exposure security audit has been requeued',
          details: {
            audit_task_id: 'run_01KZ8HA14YX9TTJW3Z4DARWQFB',
            audit_status: 'pending',
            previous_audit_status: 'error',
            version_status: 'scanning',
            retryable: true,
          },
        },
      })
    )
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-site-1'))

    await waitFor(() => expect(api.updateSiteNetwork).toHaveBeenCalledWith('site-1', 'outer'))
    expect(screen.getByTestId('site-network-site-1')).toHaveTextContent('内网')
    expect(screen.getByTestId('site-network-site-1')).not.toHaveTextContent(
      'Outer network exposure security audit has been requeued'
    )
    expect(screen.getByTestId('site-publish-site-1')).toHaveTextContent('安全检查中')
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

    render(<SitesWorkspace api={api} onCreate={vi.fn()} pageSize={1} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))

    expect(await screen.findByText('机器人学习站')).toBeInTheDocument()
    expect(screen.getByText('产品发布页')).toBeInTheDocument()
    expect(api.listSites).toHaveBeenLastCalledWith({
      appType: 'web',
      q: '',
      offset: 1,
      limit: 1,
    })
  })

  test('invokes the create entry from the page header', async () => {
    const onCreate = vi.fn()
    render(<SitesWorkspace api={createApi([])} onCreate={onCreate} />)
    await screen.findByText('还没有站点')

    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-site-menu-item'))
    expect(onCreate).toHaveBeenCalledWith('web')
  })

  test('switches to the Mini Program tab through the shared sites API', async () => {
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [unpublishedSite], total: 1, offset: 0, limit: 20 })
      .mockResolvedValueOnce({ items: [miniProgram], total: 1, offset: 0, limit: 20 })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('applications-tab-miniapp'))

    expect(await screen.findByText('微博活动助手')).toBeInTheDocument()
    expect(screen.getByText('AppID：1234567890')).toBeInTheDocument()
    expect(screen.getByText('体验版')).toBeInTheDocument()
    expect(screen.getByTestId('mini-program-qrcode-mini-1')).toHaveTextContent('查看二维码')
    expect(screen.getByTestId('mini-program-copy-link-mini-1')).toHaveTextContent('复制链接')
    expect(api.listSites).toHaveBeenLastCalledWith({
      appType: 'miniapp',
      q: '',
      offset: 0,
      limit: 20,
    })
    expect(window.location.search).toBe('?app_type=miniapp')
  })

  test('invokes the Mini Program entry from the create menu', async () => {
    const onCreate = vi.fn()
    render(<SitesWorkspace api={createApi([])} onCreate={onCreate} />)
    await screen.findByText('还没有站点')

    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-mini-program-menu-item'))

    expect(onCreate).toHaveBeenCalledWith('miniapp')
  })

  test('uses discovered application order and capabilities for navigation and actions', async () => {
    const api = createApi()
    vi.mocked(api.listApplicationTypes).mockResolvedValueOnce({
      items: [
        {
          app_type: 'future_type',
          enabled: true,
          order: 1,
          capabilities: ['create'],
        },
        {
          app_type: 'miniapp',
          enabled: true,
          order: 5,
          capabilities: [],
        },
        {
          app_type: 'web',
          enabled: true,
          order: 10,
          capabilities: ['create'],
        },
      ],
    })
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [unpublishedSite], total: 1, offset: 0, limit: 20 })
      .mockResolvedValueOnce({ items: [miniProgram], total: 1, offset: 0, limit: 20 })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await waitFor(() => {
      const tabs = screen.getAllByRole('tab')
      expect(tabs.map(tab => tab.textContent)).toEqual(['小程序', '站点'])
    })
    expect(screen.queryByTestId('site-publish-site-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('site-more-site-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('sites-create-button'))
    expect(screen.getByTestId('sites-create-site-menu-item')).toBeInTheDocument()
    expect(screen.queryByTestId('sites-create-mini-program-menu-item')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(screen.getByTestId('applications-tab-miniapp'))
    expect(await screen.findByText('微博活动助手')).toBeInTheDocument()
    expect(screen.queryByTestId('mini-program-experience-mini-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mini-program-qrcode-mini-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mini-program-copy-link-mini-1')).not.toBeInTheDocument()
  })

  test('shows mini program QR codes and copies experience links', async () => {
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [unpublishedSite], total: 1, offset: 0, limit: 20 })
      .mockResolvedValueOnce({ items: [miniProgram], total: 1, offset: 0, limit: 20 })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('applications-tab-miniapp'))
    await screen.findByText('微博活动助手')

    await userEvent.click(screen.getByTestId('mini-program-qrcode-mini-1'))
    expect(screen.getByTestId('mini-program-qrcode-dialog')).toHaveTextContent(
      'https://example.com/mini-experience'
    )
    expect(screen.getByTestId('mini-program-qrcode-svg')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mini-program-qrcode-close'))
    expect(screen.queryByTestId('mini-program-qrcode-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mini-program-copy-link-mini-1'))
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://example.com/mini-experience')
    expect(screen.getByTestId('mini-program-copy-link-mini-1')).toHaveTextContent('已复制')
  })

  test('supports keyboard navigation in the create menu', async () => {
    const onCreate = vi.fn()
    render(<SitesWorkspace api={createApi([])} onCreate={onCreate} />)
    await screen.findByText('还没有站点')
    const trigger = screen.getByTestId('sites-create-button')
    trigger.focus()

    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByTestId('sites-create-site-menu-item')).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(onCreate).toHaveBeenCalledWith('miniapp')
  })

  test('requires confirmation and explains that local files are preserved', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-site-1'))

    expect(api.deleteSite).not.toHaveBeenCalled()
    expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent('公网入口')
    expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent('不会删除本地目录')

    await userEvent.click(screen.getByTestId('site-delete-cancel-button'))
    expect(screen.queryByTestId('site-delete-dialog')).not.toBeInTheDocument()
    expect(api.deleteSite).not.toHaveBeenCalled()
  })

  test('removes only the confirmed site after the API succeeds', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-confirm-button'))

    await waitFor(() => expect(api.deleteSite).toHaveBeenCalledWith('site-1'))
    await waitFor(() => expect(screen.queryByTestId('site-row-site-1')).not.toBeInTheDocument())
  })

  test('keeps the row and dialog open when deletion fails so it can be retried', async () => {
    const api = createApi()
    vi.mocked(api.deleteSite).mockRejectedValueOnce(new Error('公网撤销失败'))
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-confirm-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent('公网撤销失败')
    expect(screen.getByTestId('site-row-site-1')).toBeInTheDocument()
    expect(screen.getByTestId('site-delete-dialog')).toBeInTheDocument()
  })
})
