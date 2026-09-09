import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ApiError } from '@/api/http'
import type { MiniProgram, Site, SiteListItem, SitesApi } from '@/api/sites'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { SitesWorkspace as SitesWorkspaceComponent } from './SitesWorkspace'

type SitesWorkspaceProps = Omit<ComponentProps<typeof SitesWorkspaceComponent>, 'search'>

function SitesWorkspace(props: SitesWorkspaceProps) {
  const [search, setSearch] = useState(window.location.search)

  useEffect(() => {
    const syncSearch = () => setSearch(window.location.search)
    window.addEventListener('popstate', syncSearch)
    return () => window.removeEventListener('popstate', syncSearch)
  }, [])

  return <SitesWorkspaceComponent {...props} search={search} />
}

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

afterEach(() => {
  window.history.replaceState({}, '', '/sites')
})

const unpublishedSite: Site = {
  app_type: 'web',
  siteid: 'site-1',
  project_id: 'prj-product',
  taskid: 'task-1',
  username: 'alice',
  owner_username: 'alice',
  access_role: 'owner',
  name: '产品发布页',
  slug: 'product',
  custom_domain_prefix: 'product',
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
  owner_username: 'alice',
  access_role: 'owner',
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
          capabilities: [
            'create',
            'publish',
            'edit',
            'delete',
            'configure_environment',
            'manage_access',
          ],
          create: {
            plugin_name: 'wegent-sites',
            marketplace_name: 'wegent',
          },
        },
        {
          app_type: 'miniapp',
          enabled: true,
          order: 20,
          capabilities: ['create', 'open_experience'],
          create: {
            plugin_name: 'weibo-miniapp-h5-develop-agent',
            marketplace_name: 'wegent',
          },
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
    updateSite: vi
      .fn()
      .mockImplementation(
        (_siteid: string, input: { title?: string; customDomainPrefix?: string | null }) =>
          Promise.resolve({
            ...unpublishedSite,
            name: input.title ?? unpublishedSite.name,
            custom_domain_prefix: input.customDomainPrefix,
          })
      ),
    deleteSite: vi.fn().mockResolvedValue(undefined),
    getEnvironmentVariables: vi.fn().mockResolvedValue({
      revision_id: null,
      project_id: 'site-1',
      revision_number: 0,
      items: [],
    }),
    patchEnvironmentVariables: vi.fn().mockResolvedValue({
      id: 'env-1',
      project_id: 'site-1',
      revision_number: 1,
      variables: [],
      created_by: 'testuser',
      created_at: '2026-09-02T08:00:00Z',
    }),
    listCollaborators: vi.fn().mockResolvedValue({ items: [] }),
    addCollaborator: vi.fn().mockImplementation((_siteid: string, subject: string) =>
      Promise.resolve({
        subject,
        added_by: 'alice',
        created_at: '2026-09-03T08:00:00Z',
      })
    ),
    removeCollaborator: vi.fn().mockResolvedValue(undefined),
    getSiteAccess: vi.fn().mockResolvedValue({
      id: 'policy-1',
      project_id: 'site-1',
      target: 'inner',
      audience: 'owner',
      subjects: [],
      revision_number: 2,
      created_by: 'alice',
      created_at: '2026-09-08T08:00:00Z',
    }),
    updateSiteAccess: vi.fn().mockImplementation((_siteid, input) =>
      Promise.resolve({
        id: 'policy-2',
        project_id: 'site-1',
        target: 'inner' as const,
        audience: input.audience,
        subjects: input.subjects,
        revision_number: 3,
        created_by: 'alice',
        created_at: '2026-09-08T09:00:00Z',
      })
    ),
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
      '站点功能尚未推出'
    )
    expect(screen.getByTestId('sites-unavailable-state')).toHaveTextContent(
      '功能开放后，你可以在这里创建、管理并发布站点。'
    )
    expect(screen.queryByTestId('sites-refresh-button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-site-menu-item'))
    expect(onCreate).toHaveBeenCalledWith(
      'web',
      expect.objectContaining({ pluginName: 'wegent-sites', marketplaceName: 'wegent' })
    )
    expect(screen.getByTestId('sites-search-input')).toBeInTheDocument()
    expect(screen.getByTestId('applications-context-toolbar')).toHaveClass('md:h-9')
    expect(screen.getByTestId('applications-content')).toHaveClass('max-w-[1120px]')
    expect(screen.queryByTestId('sites-retry-button')).not.toBeInTheDocument()
    expect(screen.queryByText('网络')).not.toBeInTheDocument()
  })

  test('uses the matching unavailable state for Mini Programs without shifting the shell', async () => {
    window.history.replaceState({}, '', '/sites?app_type=web')
    const api = createApi()
    vi.mocked(api.listSites).mockRejectedValue(
      new ApiError('Applications are not available yet', 503, 'sites_not_available')
    )

    render(<SitesWorkspace api={api} onCreate={vi.fn()} smartAppsEnabled />)

    expect(await screen.findByText('站点功能尚未推出')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('applications-tab-miniapp'))

    expect(await screen.findByText('小程序功能尚未推出')).toBeInTheDocument()
    expect(screen.getByText('功能开放后，你可以在这里创建、管理并发布小程序。')).toBeInTheDocument()
    expect(screen.getByTestId('applications-content')).toHaveClass('max-w-[1120px]')
    expect(screen.getByTestId('applications-context-toolbar')).toHaveClass('md:h-9')
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
    expect(openExternalUrl).toHaveBeenCalledWith('http://sites.internal/product', {
      target: 'system',
    })
  })

  test('lets owners load, add, and remove Project collaborators', async () => {
    const api = createApi()
    vi.mocked(api.listCollaborators).mockResolvedValueOnce({
      items: [
        {
          subject: 'member-1',
          added_by: 'alice',
          created_at: '2026-09-03T08:00:00Z',
        },
      ],
    })
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-collaborators-menu-item-site-1'))

    expect(await screen.findByTestId('site-collaborators-dialog')).toHaveTextContent('member-1')
    expect(api.listCollaborators).toHaveBeenCalledWith('site-1')

    await userEvent.type(screen.getByTestId('site-collaborator-subject-input'), ' member-2 ')
    await userEvent.click(screen.getByTestId('site-collaborator-add'))
    await waitFor(() =>
      expect(api.addCollaborator).toHaveBeenCalledWith(
        'site-1',
        'member-2',
        expect.stringMatching(/^collaborator-/)
      )
    )
    expect(screen.getByTestId('site-collaborators-dialog')).toHaveTextContent('member-2')

    await userEvent.click(screen.getByTestId('site-collaborator-remove-member-1'))
    await waitFor(() => expect(api.removeCollaborator).toHaveBeenCalledWith('site-1', 'member-1'))
    expect(screen.getByTestId('site-collaborators-dialog')).not.toHaveTextContent('member-1')
  })

  test('does not show collaborator management to collaborators', async () => {
    const api = createApi([{ ...unpublishedSite, access_role: 'collaborator' }])
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    expect(screen.queryByTestId('site-collaborators-menu-item-site-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('site-access-menu-item-site-1')).toBeInTheDocument()
  })

  test('lets collaborators update the access policy for an internal site', async () => {
    const api = createApi([{ ...unpublishedSite, access_role: 'collaborator' }])
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-access-menu-item-site-1'))

    expect(await screen.findByTestId('site-access-dialog')).toBeInTheDocument()
    await waitFor(() => expect(api.getSiteAccess).toHaveBeenCalledWith('site-1'))
    expect(screen.getByTestId('site-access-audience-owner')).toBeChecked()

    await userEvent.click(screen.getByTestId('site-access-audience-custom'))
    await userEvent.type(screen.getByTestId('site-access-subjects'), 'member-b, member-a')
    await userEvent.click(screen.getByTestId('site-access-save'))

    await waitFor(() =>
      expect(api.updateSiteAccess).toHaveBeenCalledWith(
        'site-1',
        { audience: 'custom', subjects: ['member-a', 'member-b'] },
        expect.stringMatching(/^site-access-/)
      )
    )
    expect(await screen.findByText('访问权限已保存')).toBeInTheDocument()
  })

  test('does not show access management for an external site', async () => {
    const api = createApi([
      {
        ...unpublishedSite,
        network: 'outer',
        external_url: 'https://product.example.site',
      },
    ])
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    expect(screen.queryByTestId('site-access-menu-item-site-1')).not.toBeInTheDocument()
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
    await userEvent.click(screen.getByTestId('site-more-site-1'))
    expect(screen.getByTestId('site-publish-site-1')).toHaveTextContent('发布到外网')

    await userEvent.click(screen.getByTestId('site-publish-site-1'))

    await waitFor(() => expect(api.updateSiteNetwork).toHaveBeenCalledWith('site-1', 'outer'))
    expect(screen.getByTestId('site-network-site-1')).toHaveTextContent('外网')
    await userEvent.click(screen.getByTestId('site-more-site-1'))
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

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-publish-site-1'))

    await waitFor(() => expect(api.updateSiteNetwork).toHaveBeenCalledWith('site-1', 'outer'))
    expect(screen.getByTestId('site-network-site-1')).toHaveTextContent('内网')
    expect(screen.getByTestId('site-network-site-1')).not.toHaveTextContent(
      'Outer network exposure security audit has been requeued'
    )
    await userEvent.click(screen.getByTestId('site-more-site-1'))
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
    expect(onCreate).toHaveBeenCalledWith(
      'web',
      expect.objectContaining({ pluginName: 'wegent-sites', marketplaceName: 'wegent' })
    )
  })

  test('shows a plugin installation notice while creation is preparing chat', async () => {
    render(
      <SitesWorkspace
        api={createApi([])}
        onCreate={vi.fn()}
        creatingType="web"
        createNotice="正在安装应用插件，完成后将进入会话..."
      />
    )
    await screen.findByText('还没有站点')

    expect(screen.getByTestId('sites-create-notice')).toHaveTextContent(
      '正在安装应用插件，完成后将进入会话...'
    )
    expect(screen.getByTestId('sites-create-button')).toBeDisabled()
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

  test('shows experimental Smart apps beside Sites and Mini Programs', async () => {
    window.history.replaceState({}, '', '/sites?app_type=web')
    const api = createApi()

    render(
      <SitesWorkspace
        api={api}
        onCreate={vi.fn()}
        smartAppsEnabled
        smartAppsContent={<div data-testid="smart-apps-content">智能工作台市场</div>}
      />
    )
    await screen.findByText('产品发布页')

    expect(screen.getByTestId('applications-tab-web')).toHaveTextContent('站点')
    expect(screen.getByTestId('applications-tab-miniapp')).toHaveTextContent('小程序')
    expect(screen.getByTestId('applications-tab-smart-app')).toHaveTextContent('智能工作台')
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      '智能工作台实验性',
      '站点',
      '小程序',
    ])

    await userEvent.click(screen.getByTestId('applications-tab-smart-app'))

    expect(screen.getByTestId('applications-tab-smart-app')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('smart-apps-content')).toBeInTheDocument()
    expect(screen.queryByTestId('sites-search-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sites-create-button')).not.toBeInTheDocument()
    expect(window.location.search).toBe('?app_type=smart_app')
  })

  test('selects Smart apps for the default Applications path without changing the path', async () => {
    const api = createApi()

    render(
      <SitesWorkspace
        api={api}
        onCreate={vi.fn()}
        smartAppsEnabled
        smartAppsContent={<div data-testid="smart-apps-content">智能工作台市场</div>}
      />
    )

    expect(await screen.findByTestId('smart-apps-content')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '应用' })).toBeInTheDocument()
    expect(screen.getByText('创建、管理并发布你的应用')).toBeInTheDocument()
    expect(screen.getByTestId('applications-content')).toHaveClass('max-w-[1120px]')
    expect(screen.getByTestId('applications-tab-smart-app')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(window.location.search).toBe('')
    expect(api.listSites).not.toHaveBeenCalled()
  })

  test('opens a requested Smart apps view without loading the Sites collection', async () => {
    window.history.replaceState({}, '', '/sites?app_type=smart_app')
    const api = createApi()

    render(
      <SitesWorkspace
        api={api}
        onCreate={vi.fn()}
        smartAppsEnabled
        smartAppsContent={<div data-testid="smart-apps-content">智能工作台市场</div>}
      />
    )

    expect(await screen.findByTestId('smart-apps-content')).toBeInTheDocument()
    expect(api.listSites).not.toHaveBeenCalled()
  })

  test('keeps the shared Applications heading for the owned Smart apps view', async () => {
    window.history.replaceState({}, '', '/sites?app_type=smart_app&view=owned')

    render(
      <SitesWorkspace
        api={createApi()}
        onCreate={vi.fn()}
        smartAppsEnabled
        smartAppsContent={<div data-testid="smart-apps-content">我的内容</div>}
      />
    )

    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()
    expect(screen.getByText('创建、管理并发布你的应用')).toBeInTheDocument()
    expect(screen.getByTestId('applications-content')).toHaveClass('max-w-[1120px]')
  })

  test('invokes the Mini Program entry from the create menu', async () => {
    const onCreate = vi.fn()
    render(<SitesWorkspace api={createApi([])} onCreate={onCreate} />)
    await screen.findByText('还没有站点')

    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-mini-program-menu-item'))

    expect(onCreate).toHaveBeenCalledWith(
      'miniapp',
      expect.objectContaining({
        pluginName: 'weibo-miniapp-h5-develop-agent',
        marketplaceName: 'wegent',
      })
    )
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
          create: {
            plugin_name: 'weibo-miniapp-h5-develop-agent',
            marketplace_name: 'wegent',
          },
        },
        {
          app_type: 'web',
          enabled: true,
          order: 10,
          capabilities: ['create'],
          create: {
            plugin_name: 'wegent-sites',
            marketplace_name: 'wegent',
          },
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
    await userEvent.click(screen.getByTestId('site-more-site-1'))
    expect(screen.getByTestId('site-collaborators-menu-item-site-1')).toBeInTheDocument()
    expect(screen.queryByTestId('site-edit-menu-item-site-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('site-delete-menu-item-site-1')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

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

    expect(onCreate).toHaveBeenCalledWith(
      'miniapp',
      expect.objectContaining({
        pluginName: 'weibo-miniapp-h5-develop-agent',
        marketplaceName: 'wegent',
      })
    )
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

  test('continues development from a site row action', async () => {
    const api = createApi()
    const onContinueDevelopment = vi.fn()
    render(
      <SitesWorkspace api={api} onCreate={vi.fn()} onContinueDevelopment={onContinueDevelopment} />
    )
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-continue-development-site-1'))

    expect(onContinueDevelopment).toHaveBeenCalledWith(
      unpublishedSite,
      expect.objectContaining({ pluginName: 'wegent-sites', marketplaceName: 'wegent' })
    )
  })

  test('edits a site title and custom domain prefix from the row menu', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-edit-menu-item-site-1'))

    expect(screen.getByTestId('site-edit-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('site-edit-title-input')).toHaveValue('产品发布页')
    expect(screen.getByTestId('site-edit-domain-prefix-input')).toHaveValue('product')

    await userEvent.clear(screen.getByTestId('site-edit-title-input'))
    await userEvent.type(screen.getByTestId('site-edit-title-input'), 'Docs Site')
    await userEvent.clear(screen.getByTestId('site-edit-domain-prefix-input'))
    await userEvent.type(screen.getByTestId('site-edit-domain-prefix-input'), 'Docs')
    await userEvent.click(screen.getByTestId('site-edit-save-button'))

    await waitFor(() =>
      expect(api.updateSite).toHaveBeenCalledWith('site-1', {
        title: 'Docs Site',
        customDomainPrefix: 'docs',
      })
    )
    expect(await screen.findByText('Docs Site')).toBeInTheDocument()
    expect(screen.queryByTestId('site-edit-dialog')).not.toBeInTheDocument()
  })

  test('edits Project environment variables without exposing the configured Secret', async () => {
    const api = createApi()
    vi.mocked(api.getEnvironmentVariables).mockResolvedValueOnce({
      revision_id: 'env-1',
      project_id: 'site-1',
      revision_number: 1,
      items: [
        {
          key: 'PUBLIC_URL',
          type: 'plain',
          value: 'https://old.example.test',
          updated_by: 'testuser',
          updated_at: '2026-09-02T08:00:00Z',
        },
        {
          key: 'API_TOKEN',
          type: 'secret',
          configured: true,
          updated_by: 'testuser',
          updated_at: '2026-09-02T08:00:00Z',
        },
      ],
    })
    vi.mocked(api.patchEnvironmentVariables).mockResolvedValueOnce({
      id: 'env-2',
      project_id: 'site-1',
      revision_number: 2,
      variables: [],
      created_by: 'testuser',
      created_at: '2026-09-02T08:01:00Z',
    })
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-environment-menu-item-site-1'))
    expect(await screen.findByTestId('environment-variables-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('environment-value-PUBLIC_URL-0')).toHaveValue(
      'https://old.example.test'
    )
    expect(screen.getByTestId('environment-value-API_TOKEN-1')).toHaveValue('')
    expect(screen.getByTestId('environment-static-secret-warning')).toHaveTextContent(
      'Secret 对所有站点访问者可见'
    )

    await userEvent.type(screen.getByTestId('environment-value-API_TOKEN-1'), 'replacement')
    await userEvent.click(screen.getByTestId('environment-save-button'))

    await waitFor(() =>
      expect(api.patchEnvironmentVariables).toHaveBeenCalledWith(
        'site-1',
        {
          expected_revision_id: 'env-1',
          operations: [{ op: 'upsert', key: 'API_TOKEN', type: 'secret', value: 'replacement' }],
        },
        expect.stringMatching(/^site-environment-/)
      )
    )
    expect(screen.getByTestId('environment-variables-dialog')).toHaveTextContent('下一次部署时生效')
  })

  test('opens Project environment settings from the Platform configuration deep link', async () => {
    const api = createApi()
    window.history.replaceState(
      {},
      '',
      '/sites?app_type=web&view=environment-variables&project_id=prj-product'
    )
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)

    expect(await screen.findByTestId('environment-variables-dialog')).toBeInTheDocument()
    await waitFor(() => expect(api.getEnvironmentVariables).toHaveBeenCalledWith('site-1'))
  })

  test('keeps the edit dialog open when metadata saving fails', async () => {
    const api = createApi()
    vi.mocked(api.updateSite).mockRejectedValueOnce(
      new Error('custom_domain_prefix is already in use')
    )
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-site-1'))
    await userEvent.click(screen.getByTestId('site-edit-menu-item-site-1'))
    await userEvent.clear(screen.getByTestId('site-edit-domain-prefix-input'))
    await userEvent.type(screen.getByTestId('site-edit-domain-prefix-input'), 'taken')
    await userEvent.click(screen.getByTestId('site-edit-save-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'custom_domain_prefix is already in use'
    )
    expect(screen.getByTestId('site-edit-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('site-row-site-1')).toHaveTextContent('产品发布页')
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
