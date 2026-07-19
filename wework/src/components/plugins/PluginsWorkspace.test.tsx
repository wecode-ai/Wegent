import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { ProjectPluginScope } from '@/features/plugins/useProjectPluginScope'
import { PluginsWorkspace } from './PluginsWorkspace'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

type CodexMarketplaceMock = {
  name: string
  path: string
  displayName?: string
  plugins?: CodexPluginMock[]
}

type CodexPluginMock = {
  id: string
  name: string
  remotePluginId?: string
  displayName?: string
  description?: string
  category?: string
  logo?: string
  defaultPrompt?: string | string[]
}

const defaultCodexPlugin: CodexPluginMock = {
  id: '101',
  name: 'documents',
  remotePluginId: 'openai-documents',
  displayName: 'Documents',
  description: 'Create and edit document artifacts',
  category: 'Productivity',
  logo: '/Users/test/plugins/documents/assets/logo.png',
  defaultPrompt: 'Draft a document outline from this chat',
}

function codexPluginSummary(plugin: CodexPluginMock, installed: boolean) {
  return {
    id: plugin.id,
    remotePluginId: plugin.remotePluginId ?? plugin.id,
    localVersion: '1.0.0',
    name: plugin.name,
    installed,
    enabled: installed,
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    interface: {
      displayName: plugin.displayName ?? plugin.name,
      shortDescription: plugin.description ?? '',
      longDescription: plugin.description ?? '',
      logo: plugin.logo ?? null,
      composerIcon: null,
      brandColor: null,
      category: plugin.category ?? 'Productivity',
      developerName: 'OpenAI',
      defaultPrompt: plugin.defaultPrompt ?? [],
      homepageUrl: null,
      supportUrl: null,
      categories: [plugin.category ?? 'Productivity'],
      tags: ['docs'],
    },
    keywords: ['docs'],
  }
}

function codexMarketplaceResponse(
  marketplace: CodexMarketplaceMock,
  installedPluginNames: Set<string>,
  installedOnly: boolean
) {
  const plugins = marketplace.plugins ?? [defaultCodexPlugin]
  const visiblePlugins = installedOnly
    ? plugins.filter(plugin => installedPluginNames.has(plugin.name))
    : plugins
  return {
    name: marketplace.name,
    path: marketplace.path,
    interface: {
      displayName: marketplace.displayName ?? marketplace.name,
    },
    plugins: visiblePlugins.map(plugin =>
      codexPluginSummary(plugin, installedPluginNames.has(plugin.name))
    ),
  }
}

function codexPluginDetail(marketplaceName: string, plugin: CodexPluginMock) {
  return {
    marketplaceName,
    marketplacePath: null,
    summary: codexPluginSummary(plugin, true),
    description: plugin.description ?? '',
    skills: [
      {
        name: plugin.name,
        description: plugin.description ?? '',
        shortDescription: plugin.description ?? '',
        path: `/Users/test/plugins/${plugin.name}/skills/${plugin.name}`,
        enabled: true,
      },
    ],
    hooks: [],
    apps: [
      {
        id: 'documents-app',
        name: 'Documents App',
        description: 'Create document artifacts from apps',
      },
    ],
    appTemplates: [],
    mcpServers: [],
  }
}

function mockCodexAppServerInvoke(
  options: {
    marketplaces?: CodexMarketplaceMock[]
    installedPluginNames?: string[]
    skills?: Array<{
      name: string
      description: string
      path: string
      scope: string
      enabled: boolean
      shortDescription?: string | null
    }>
    apps?: Array<{
      id: string
      name: string
      description?: string | null
      logoUrl?: string | null
      installUrl?: string | null
      isAccessible?: boolean
      isEnabled?: boolean
      pluginDisplayNames?: string[]
    }>
  } = {}
) {
  const marketplaces = [...(options.marketplaces ?? [])]
  const installedPluginNames = new Set(options.installedPluginNames ?? [])
  const skills = options.skills ?? []
  const apps = options.apps ?? []

  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    if (command === 'local_executor_codex_home_migration_status') {
      return Promise.resolve({
        weworkCodexHome: '/Users/test/.wegent-executor/codex',
        nativeCodexHome: '/Users/test/.codex',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: false,
        shouldPromptMigration: false,
      })
    }
    if (command === 'local_executor_migrate_native_codex_home') {
      return Promise.resolve({
        weworkCodexHome: '/Users/test/.wegent-executor/codex',
        nativeCodexHome: '/Users/test/.codex',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: true,
        shouldPromptMigration: false,
      })
    }
    if (command === 'local_executor_ensure_started') {
      return Promise.resolve({ running: true, ready: true })
    }
    if (command !== 'local_executor_request') return Promise.resolve(undefined)

    const request = args as {
      method?: string
      params?: { method?: string; params?: Record<string, unknown> }
    }
    if (request.method !== 'codex.app_server_request') return Promise.resolve(undefined)

    const method = request.params?.method
    const params = request.params?.params ?? {}
    if (method === 'plugin/list') {
      return Promise.resolve({
        marketplaces: marketplaces.map(marketplace =>
          codexMarketplaceResponse(marketplace, installedPluginNames, false)
        ),
      })
    }
    if (method === 'plugin/installed') {
      return Promise.resolve({
        marketplaces: marketplaces.map(marketplace =>
          codexMarketplaceResponse(marketplace, installedPluginNames, true)
        ),
      })
    }
    if (method === 'plugin/read') {
      const pluginName = String(params.pluginName ?? '')
      const marketplace =
        marketplaces.find(marketplace =>
          (marketplace.plugins ?? [defaultCodexPlugin]).some(plugin => plugin.name === pluginName)
        ) ?? marketplaces[0]
      const plugin = (marketplace?.plugins ?? [defaultCodexPlugin]).find(
        plugin => plugin.name === pluginName
      )
      return Promise.resolve({
        plugin: codexPluginDetail(marketplace?.name ?? 'default', plugin ?? defaultCodexPlugin),
      })
    }
    if (method === 'marketplace/add') {
      const source = String(params.source ?? '')
      const marketplaceName =
        source === 'https://github.com/openai/plugins' ? 'openai-official' : `local-${Date.now()}`
      marketplaces.push({
        name: marketplaceName,
        displayName: source === 'https://github.com/openai/plugins' ? 'OpenAI 官方市场' : source,
        path: source,
      })
      return Promise.resolve({ marketplaceName, installedRoot: '/Users/test/codex/plugins/cache' })
    }
    if (method === 'marketplace/remove') {
      const marketplaceName = String(params.marketplaceName ?? '')
      const index = marketplaces.findIndex(marketplace => marketplace.name === marketplaceName)
      if (index >= 0) marketplaces.splice(index, 1)
      return Promise.resolve({ marketplaceName, installedRoot: null })
    }
    if (method === 'plugin/install') {
      const pluginName = String(params.pluginName ?? '')
      const plugin = marketplaces
        .flatMap(marketplace => marketplace.plugins ?? [defaultCodexPlugin])
        .find(
          plugin =>
            plugin.name === pluginName ||
            plugin.id === pluginName ||
            (plugin.remotePluginId ?? plugin.id) === pluginName
        )
      installedPluginNames.add(plugin?.name ?? pluginName)
      return Promise.resolve({ authPolicy: 'ON_USE', appsNeedingAuth: [] })
    }
    if (method === 'plugin/uninstall') {
      const pluginId = String(params.pluginId ?? '')
      for (const marketplace of marketplaces) {
        for (const plugin of marketplace.plugins ?? [defaultCodexPlugin]) {
          if (plugin.id === pluginId) installedPluginNames.delete(plugin.name)
        }
      }
      return Promise.resolve({})
    }
    if (method === 'skills/config/write') {
      return Promise.resolve({ effectiveEnabled: params.enabled })
    }
    if (method === 'skills/list') {
      return Promise.resolve({
        data: [
          {
            cwd: Array.isArray(params.cwds) ? String(params.cwds[0] ?? '') : '',
            skills,
            errors: [],
          },
        ],
      })
    }
    if (method === 'app/list') {
      return Promise.resolve({
        data: apps,
        nextCursor: null,
      })
    }
    return Promise.resolve({})
  })
}

function expectCodexAppServerRequest(method: string, params: Record<string, unknown>) {
  expect(invoke).toHaveBeenCalledWith('local_executor_request', {
    method: 'codex.app_server_request',
    params: {
      method,
      params: expect.objectContaining(params),
    },
  })
}

function mockSystemSkillsFetch(
  overrides: Partial<{
    installState: 'not_installed' | 'installed' | 'update_available'
    enabled: boolean
    installedSkillId: number | null
  }> = {}
) {
  const personalSkillsResponse = {
    items: [
      {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Skill',
        metadata: {
          name: 'excel-helper',
          namespace: 'default',
          labels: { id: '77' },
        },
        spec: {
          description: 'Analyze Excel workbooks',
          displayName: 'Excel Helper',
          version: '1.0.0',
          author: 'Alice',
          tags: ['personal'],
          prompt: 'Use spreadsheets carefully',
        },
      },
    ],
  }
  const uploadedPersonalSkill = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Skill',
    metadata: {
      name: 'zip-helper',
      namespace: 'default',
      labels: { id: '78' },
    },
    spec: {
      description: 'Uploaded helper',
      displayName: 'zip-helper',
      version: '1.0.0',
      author: 'Alice',
      tags: ['personal'],
      prompt: 'Uploaded prompt',
    },
  }
  const installedPersonalSkill = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledSkill',
    metadata: {
      name: 'personal-excel-helper',
      namespace: 'default',
      labels: { id: '88' },
    },
    spec: {
      source: {
        type: 'personal',
        skillKey: 'excel-helper',
        catalogItemId: 'personal/77',
      },
      skillRef: {
        kind: 'Skill',
        name: 'excel-helper',
        namespace: 'default',
        user_id: 1,
      },
      displayName: 'Excel Helper',
      description: 'Analyze Excel workbooks',
      version: '1.0.0',
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const installedUploadedPersonalSkill = {
    ...installedPersonalSkill,
    metadata: {
      name: 'personal-zip-helper',
      namespace: 'default',
      labels: { id: '89' },
    },
    spec: {
      ...installedPersonalSkill.spec,
      source: {
        type: 'personal',
        skillKey: 'zip-helper',
        catalogItemId: 'personal/78',
      },
      skillRef: {
        kind: 'Skill',
        name: 'zip-helper',
        namespace: 'default',
        user_id: 1,
      },
      displayName: 'zip-helper',
      description: 'Uploaded helper',
    },
  }
  const mcpProvidersResponse = {
    providers: [
      {
        key: 'mcp_router',
        name: 'MCP Router',
        name_en: 'MCP Router',
        description: 'MCP Router provider',
        discover_url: 'https://example.com/mcp',
        api_key_url: 'https://example.com/token',
        token_field_name: 'mcp_router',
        requires_token: true,
        has_token: true,
      },
    ],
  }
  const mcpProviderServersResponse = {
    success: true,
    message: 'ok',
    servers: [
      {
        id: '@mcp_router/hot-search',
        name: 'Hot Search MCP',
        description: 'Read hot search data',
        type: 'streamable-http',
        base_url: 'https://mcp.example.com/hot-search',
        command: null,
        args: null,
        env: null,
        headers: null,
        is_active: true,
        provider: 'MCP Router',
        provider_url: null,
        logo_url: null,
        tags: ['search'],
        installState: 'not_installed',
        installedMcpId: null,
        enabled: false,
      },
    ],
  }
  const installedProviderMcp = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledMCP',
    metadata: {
      name: 'hot-search',
      namespace: 'default',
      labels: { id: '9' },
    },
    spec: {
      source: {
        type: 'provider',
        providerKey: 'mcp_router',
        serverKey: 'hot-search',
        catalogItemId: '@mcp_router/hot-search',
      },
      displayName: 'Hot Search MCP',
      description: 'Read hot search data',
      server: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/hot-search',
      },
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const customMcpResponse = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledMCP',
    metadata: {
      name: 'local-docs',
      namespace: 'default',
      labels: { id: '10' },
    },
    spec: {
      source: {
        type: 'custom',
        serverKey: 'local-docs',
      },
      displayName: 'Local Docs',
      description: 'Local docs search',
      server: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/local',
      },
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const marketplacePlugin = {
    id: 101,
    remotePluginId: 'openai-documents',
    name: 'documents',
    displayName: 'Documents',
    description: 'Create and edit document artifacts',
    version: '1.0.0',
    author: 'OpenAI',
    visibility: 'public',
    featured: false,
    installed: false,
    enabled: false,
    installedPluginId: null,
    interface: {
      displayName: 'Documents',
      shortDescription: 'Create and edit documents',
      logo: '/Users/test/plugins/documents/assets/logo.png',
      composerIcon: null,
      brandColor: null,
      category: 'Productivity',
      defaultPrompt: 'Draft a document outline from this chat',
      homepageUrl: null,
      supportUrl: null,
      categories: ['productivity'],
      tags: ['docs'],
    },
    components: {
      skills: [],
      commands: [],
      apps: [
        {
          name: 'Documents App',
          path: 'documents-app',
        },
      ],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    createdAt: null,
    updatedAt: null,
  }
  const installedMarketplacePlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'documents',
      namespace: 'default',
      labels: { id: '101' },
    },
    spec: {
      source: {
        type: 'marketplace',
        pluginKey: 'documents',
        providerKey: 'wegent-cloud',
        catalogItemId: 'openai-documents',
      },
      displayName: 'Documents',
      description: 'Create and edit document artifacts',
      version: '1.0.0',
      enabled: true,
      installState: 'installed',
      componentStates: {},
      components: marketplacePlugin.components,
      interface: marketplacePlugin.interface,
      packageRef: null,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const skill = (page: number) => ({
    id: `@weibo/page-${page}`,
    providerKey: 'weibo',
    providerName: 'Weibo Skill Market',
    name: `page-${page}`,
    displayName: `Weibo Skill ${page}`,
    description: `Skill page ${page}`,
    iconUrl: null,
    tags: ['system'],
    version: '1.0.0',
    author: 'Weibo',
    category: 'system',
    capabilities: [],
    detailUrl: null,
    installState: overrides.installState ?? 'not_installed',
    installedSkillId: overrides.installedSkillId,
    enabled: overrides.enabled ?? false,
    requiresPermission: false,
    permissionUrl: null,
    updatedAt: null,
  })

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const requestUrl = new URL(url, 'http://localhost')
      if (requestUrl.pathname === '/api/v1/kinds/skills/upload') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(uploadedPersonalSkill),
        })
      }
      if (requestUrl.pathname === '/api/v1/kinds/skills') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(personalSkillsResponse),
        })
      }
      if (requestUrl.pathname === '/api/system-skills/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/system-skills/install/personal') {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve(
              body.skillId === 78 ? installedUploadedPersonalSkill : installedPersonalSkill
            ),
        })
      }
      if (requestUrl.pathname === '/api/v1/kinds/skills/77') {
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve(null),
        })
      }
      if (requestUrl.pathname === '/api/mcp-providers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mcpProvidersResponse),
        })
      }
      if (requestUrl.pathname === '/api/mcp-providers/mcp_router/servers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mcpProviderServersResponse),
        })
      }
      if (requestUrl.pathname === '/api/mcps/install') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(installedProviderMcp),
        })
      }
      if (requestUrl.pathname === '/api/mcps/custom') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(customMcpResponse),
        })
      }
      if (requestUrl.pathname === '/api/plugins/marketplace') {
        const keyword = requestUrl.searchParams.get('q')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items:
                keyword && !marketplacePlugin.displayName.toLowerCase().includes(keyword)
                  ? []
                  : [marketplacePlugin],
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/marketplace/101/install') {
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ plugin: installedMarketplacePlugin }),
            })
          }, 10)
        })
      }
      if (requestUrl.pathname === '/api/plugins/installed/101' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ...installedMarketplacePlugin,
              spec: { ...installedMarketplacePlugin.spec, enabled: false },
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/installed/101' && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) })
      }
      const page = Number(requestUrl.searchParams.get('page') ?? 1)
      const keyword = requestUrl.searchParams.get('keyword')
      const item = skill(page)
      const payload =
        init?.method === 'POST'
          ? {
              apiVersion: 'agent.wecode.io/v1',
              kind: 'InstalledSkill',
              metadata: {
                name: 'weibo-page-1',
                namespace: 'default',
                labels: { id: '42' },
              },
              spec: {
                source: {
                  type: 'system',
                  providerKey: item.providerKey,
                  skillKey: item.name,
                  catalogItemId: item.id,
                },
                skillRef: null,
                displayName: item.displayName,
                description: item.description,
                version: item.version,
                installState: 'installed',
                enabled: true,
                sourcePayload: null,
              },
              status: { state: 'Available' },
            }
          : {
              total: keyword ? 0 : 40,
              page,
              pageSize: 20,
              items: keyword ? [] : [item],
              providerErrors: [],
            }

      return Promise.resolve({
        ok: true,
        status: init?.method === 'DELETE' ? 204 : 200,
        json: () => Promise.resolve(payload),
      })
    })
  )
}

describe('PluginsWorkspace', () => {
  beforeEach(() => {
    vi.mocked(convertFileSrc).mockClear()
    vi.mocked(invoke).mockReset()
    vi.mocked(isTauri).mockReturnValue(false)
    window.localStorage.clear()
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    mockSystemSkillsFetch()
  })

  test('renders a Codex-style plugin marketplace page', async () => {
    render(<PluginsWorkspace />)

    expect(screen.getByRole('heading', { name: '插件' })).toBeInTheDocument()
    expect(screen.getByText('通过插件扩展 WeWork 能力')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-search-input')).toHaveAttribute(
      'placeholder',
      '搜索插件'
    )
    expect(screen.getByTestId('plugins-search-input')).toHaveClass('h-11', 'rounded-full')
    expect(screen.getByTestId('plugins-installed-strip')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-source-switcher')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-selector')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-refresh-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-tab-default')).toHaveTextContent(
      'Wegent 云端市场'
    )
    expect(screen.queryByTestId('plugins-marketplace-source-openai')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-add-marketplace-button')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '技能' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'MCP' })).not.toBeInTheDocument()
    expect(screen.queryByText('帮我整理本周的项目进度并生成可视化报告')).not.toBeInTheDocument()
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(convertFileSrc).toHaveBeenCalledWith('/Users/test/plugins/documents/assets/logo.png')
    expect(screen.getByText('Productivity')).toBeInTheDocument()
  })

  test('filters the plugin marketplace from the search box', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('plugins-search-input'), 'missing')

    expect(await screen.findByText('找不到匹配的插件')).toBeInTheDocument()
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace?q=missing',
      expect.objectContaining({ method: 'GET' })
    )
  })

  test('refreshes the selected marketplace from the top bar', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-refresh-button'))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace',
        expect.objectContaining({ method: 'GET' })
      )
    )
    const marketplaceFetches = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).startsWith('/api/plugins/marketplace'))
    expect(marketplaceFetches.length).toBeGreaterThanOrEqual(2)
  })

  test('installs a marketplace plugin', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('在对话中试用')
    )
    expect(screen.getByTestId('plugin-marketplace-install-101')).not.toBeDisabled()
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace/101/install',
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('installs a marketplace plugin only for the selected project', async () => {
    const addInstalledPlugin = vi.fn().mockImplementation(plugin => Promise.resolve(plugin))
    const projectScope: ProjectPluginScope = {
      projectId: 7,
      projectName: 'Wegent',
      pluginKeys: new Set(),
      loading: false,
      error: null,
      addInstalledPlugin,
    }
    render(
      <PluginsWorkspace
        projectScope={projectScope}
        installTargetProjects={[{ id: 7, name: 'Wegent' }]}
        selectedInstallProjectId={7}
        onInstallTargetChange={vi.fn()}
      />
    )

    expect(await screen.findByTestId('plugins-install-target-select')).toHaveValue('7')
    const install = await screen.findByTestId('plugin-marketplace-install-101')
    expect(install).toHaveTextContent('安装到项目')
    await userEvent.click(install)

    await waitFor(() => expect(addInstalledPlugin).toHaveBeenCalledTimes(1))
    expect(addInstalledPlugin.mock.calls[0][0].spec.enabled).toBe(false)
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) })
    )
    expect(screen.queryByTestId('plugins-installed-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-marketplace-actions-101')).not.toBeInTheDocument()
  })

  test('rolls back a project-scoped install when project config persistence fails', async () => {
    const projectScope: ProjectPluginScope = {
      projectId: 7,
      projectName: 'Wegent',
      pluginKeys: new Set(),
      loading: false,
      error: null,
      addInstalledPlugin: vi.fn().mockRejectedValue(new Error('project write failed')),
    }
    render(
      <PluginsWorkspace
        projectScope={projectScope}
        installTargetProjects={[{ id: 7, name: 'Wegent' }]}
        selectedInstallProjectId={7}
        onInstallTargetChange={vi.fn()}
      />
    )

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))

    await waitFor(() => expect(screen.getByText('project write failed')).toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  test('lets the user explicitly choose the plugin install location', async () => {
    const onInstallTargetChange = vi.fn()
    render(
      <PluginsWorkspace
        installTargetProjects={[
          { id: 7, name: 'Wegent' },
          { id: 8, name: 'cc-switch' },
        ]}
        selectedInstallProjectId={null}
        onInstallTargetChange={onInstallTargetChange}
      />
    )

    const target = await screen.findByTestId('plugins-install-target-select')
    expect(target).toHaveValue('')
    await userEvent.selectOptions(target, '8')

    expect(onInstallTargetChange).toHaveBeenCalledWith(8)
  })

  test('opens installed marketplace plugin actions and uninstalls from the row menu', async () => {
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
        },
      ],
    })
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('在对话中试用')
    )
    expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-marketplace-actions-101'))

    expect(screen.getByTestId('plugin-marketplace-actions-menu-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-marketplace-uninstall-101')).toHaveTextContent('卸载')

    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))

    expectCodexAppServerRequest('plugin/uninstall', { pluginId: '101' })
    expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
    expect(screen.queryByTestId('plugin-marketplace-actions-101')).not.toBeInTheDocument()
  })

  test('reads local plugin detail when trying an installed marketplace plugin in chat', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI',
          path: '/Users/test/.codex/plugins/marketplaces/openai',
        },
      ],
      installedPluginNames: ['documents'],
    })

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))

    await waitFor(() =>
      expectCodexAppServerRequest('plugin/read', {
        marketplacePath: '/Users/test/.codex/plugins/marketplaces/openai',
        pluginName: 'documents',
      })
    )
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toContain(
      'plugin://documents@local-openai'
    )
  })

  test('opens marketplace plugin detail from the plugin row', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))

    expect(screen.getByTestId('plugin-detail-back-button')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装' })).toBeInTheDocument()
    expect(screen.getByText('Create and edit document artifacts')).toBeInTheDocument()
    expect(screen.getByText('Draft a document outline from this chat')).toBeInTheDocument()
    expect(screen.getByText('包含内容 1')).toBeInTheDocument()
    expect(screen.getByText('Documents App')).toBeInTheDocument()
    expect(screen.getByText('documents-app')).toBeInTheDocument()
  })

  test('installs a marketplace plugin from the detail page with visible progress', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('在对话中试用')
    )
  })

  test('opens installed marketplace plugin actions and uninstalls from the detail menu', async () => {
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
        },
      ],
    })
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('在对话中试用')
    )
    await userEvent.click(screen.getByTestId('plugin-detail-actions-101'))

    expect(screen.getByTestId('plugin-detail-actions-menu-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-uninstall-101')).toHaveTextContent('卸载')

    await userEvent.click(screen.getByTestId('plugin-detail-uninstall-101'))

    expectCodexAppServerRequest('plugin/uninstall', { pluginId: '101' })
    expect(screen.queryByTestId('plugin-detail-actions-101')).not.toBeInTheDocument()
  })

  test('opens the local marketplace configuration dialog', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-add-marketplace-button'))
    expect(screen.getByTestId('plugins-add-marketplace-menu')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-add-openai-marketplace-button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-add-custom-marketplace-button'))

    expect(screen.getByTestId('plugins-marketplace-config-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-path-input')).toHaveAttribute(
      'placeholder',
      'https://github.com/org/repo'
    )
  })

  test('normalizes a local marketplace manifest path to its source directory', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'existing-market',
          displayName: 'Existing market',
          path: '/Users/test/existing-market',
        },
      ],
    })
    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    await userEvent.click(await screen.findByTestId('plugins-add-marketplace-button'))
    await userEvent.click(screen.getByTestId('plugins-add-custom-marketplace-button'))
    fireEvent.change(screen.getByTestId('plugins-marketplace-path-input'), {
      target: { value: '/Users/test/market/.agents/plugins/marketplace.json' },
    })
    await userEvent.click(screen.getByTestId('plugins-marketplace-save-button'))

    await waitFor(() =>
      expectCodexAppServerRequest('marketplace/add', {
        source: '/Users/test/market',
      })
    )
  })

  test('loads the OpenAI official marketplace by default', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          displayName: 'OpenAI 官方市场',
          path: 'openai-curated-remote',
        },
      ],
    })

    render(<PluginsWorkspace />)

    expect(
      await screen.findByTestId('plugins-marketplace-tab-openai-curated-remote')
    ).toHaveTextContent('OpenAI 官方市场')
    expectCodexAppServerRequest('plugin/list', {
      cwds: null,
    })
  })

  test('renders configured marketplaces as tabs and switches local marketplaces', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
        },
        {
          name: 'local-team',
          displayName: 'Team 市场',
          path: '/Users/test/team-marketplace.json',
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByTestId('plugins-marketplace-tab-local-openai')).toHaveTextContent(
      'OpenAI 官方市场'
    )
    expect(screen.getByTestId('plugins-marketplace-tab-local-team')).toHaveTextContent('Team 市场')
    expect(screen.queryByTestId('plugins-marketplace-source-openai')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-marketplace-tab-local-team'))

    await waitFor(() =>
      expect(screen.getByTestId('plugins-marketplace-tab-local-team')).toHaveClass('bg-surface')
    )
  })

  test('shows add-marketplace state when no marketplace is configured', async () => {
    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByText('添加一个插件市场')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-no-marketplace-welcome')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-search-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-source-switcher')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-publish-empty-button')).not.toBeInTheDocument()

    expect(
      screen.queryByTestId('plugins-add-openai-marketplace-empty-button')
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-add-custom-marketplace-empty-button'))

    expect(screen.getByTestId('plugins-marketplace-config-dialog')).toBeInTheDocument()
  })

  test('shows a loading skeleton instead of the empty marketplace state while local plugins load', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'local_executor_codex_home_migration_status') {
        return Promise.resolve({
          weworkCodexHome: '/Users/test/.wegent-executor/codex',
          nativeCodexHome: '/Users/test/.codex',
          weworkCodexHomeExists: true,
          nativeCodexHomeExists: false,
          shouldPromptMigration: false,
        })
      }
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true })
      }
      if (command === 'local_executor_request') {
        return new Promise(() => undefined)
      }
      return Promise.resolve(undefined)
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByTestId('plugins-marketplace-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-no-marketplace-welcome')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-publish-empty-button')).not.toBeInTheDocument()
  })

  test('sends remote plugin id for remote marketplace install', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              ...defaultCodexPlugin,
              id: '5715908889684902000',
            },
          ],
        },
      ],
    })
    const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
    const localPluginApi = createLocalCodexPluginApi()

    await localPluginApi.readState({ refresh: true })
    await localPluginApi.installAvailablePlugin('5715908889684902000')

    expectCodexAppServerRequest('plugin/install', {
      pluginName: 'openai-documents',
    })
  })

  test('sends plugin name for local marketplace install', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI',
          path: '/Users/test/.codex/plugins/marketplaces/openai',
          plugins: [
            {
              ...defaultCodexPlugin,
              id: '5715908889684902000',
            },
          ],
        },
      ],
    })
    const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
    const localPluginApi = createLocalCodexPluginApi()

    await localPluginApi.readState({ refresh: true })
    await localPluginApi.installAvailablePlugin('5715908889684902000')

    expectCodexAppServerRequest('plugin/install', {
      marketplacePath: '/Users/test/.codex/plugins/marketplaces/openai',
      pluginName: 'documents',
    })
  })

  test('lists local skills through Codex app-server', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      skills: [
        {
          name: 'env-context',
          description: 'Environment facts',
          shortDescription: 'Environment',
          path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
          scope: 'user',
          enabled: true,
        },
        {
          name: 'disabled-skill',
          description: 'Disabled',
          path: '/Users/crystal/.codex/skills/disabled-skill/SKILL.md',
          scope: 'user',
          enabled: false,
        },
      ],
    })
    const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
    const localPluginApi = createLocalCodexPluginApi()

    await expect(localPluginApi.listSkills({ cwds: ['/workspace/repo'] })).resolves.toEqual([
      expect.objectContaining({
        name: 'env-context',
        description: 'Environment',
        short_description: 'Environment',
        path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
        source: 'codex',
        scope: 'user',
      }),
    ])
    expectCodexAppServerRequest('skills/list', {
      cwds: ['/workspace/repo'],
      forceReload: false,
    })
  })

  test('lists enabled local apps through Codex app-server', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      apps: [
        {
          id: 'google-calendar',
          name: 'Google Calendar',
          description: 'Manage calendar events',
          logoUrl: 'https://example.test/calendar.png',
          installUrl: 'https://example.test/install',
          isAccessible: true,
          isEnabled: true,
          pluginDisplayNames: ['Calendar'],
        },
        {
          id: 'disabled-app',
          name: 'Disabled App',
          isAccessible: true,
          isEnabled: false,
        },
        {
          id: 'inaccessible-app',
          name: 'Inaccessible App',
          isAccessible: false,
          isEnabled: true,
        },
      ],
    })
    const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
    const localPluginApi = createLocalCodexPluginApi()

    await expect(localPluginApi.listApps()).resolves.toEqual([
      {
        id: 'google-calendar',
        name: 'Google Calendar',
        description: 'Manage calendar events',
        logoUrl: 'https://example.test/calendar.png',
        installUrl: 'https://example.test/install',
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ['Calendar'],
        source: 'codex-app',
      },
    ])
    expectCodexAppServerRequest('app/list', {
      cursor: null,
      limit: 100,
      forceRefetch: false,
    })
  })

  test('deletes the selected local marketplace', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI',
          path: 'https://github.com/openai/plugins',
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    await userEvent.click(await screen.findByTestId('plugins-manage-marketplaces-button'))
    await userEvent.click(screen.getByTestId('plugins-marketplace-delete-local-openai'))
    expect(screen.getByText('删除市场？')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-marketplace-confirm-delete-button'))

    expectCodexAppServerRequest('marketplace/remove', { marketplaceName: 'local-openai' })
    expect(await screen.findByTestId('plugins-no-marketplace-welcome')).toBeInTheDocument()
  })

  test('manages local marketplaces with sort edit and delete actions', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI',
          path: 'https://github.com/openai/plugins',
        },
        {
          name: 'local-team',
          displayName: 'Team',
          path: '/Users/test/team-marketplace.json',
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    await userEvent.click(await screen.findByTestId('plugins-manage-marketplaces-button'))
    expect(screen.getByTestId('plugins-marketplace-manager-dialog')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-marketplace-move-down-local-openai'))
    expectCodexAppServerRequest('plugin/list', {})

    await userEvent.click(screen.getByTestId('plugins-marketplace-edit-local-openai'))
    expect(screen.getByTestId('plugins-marketplace-config-dialog')).toBeInTheDocument()
    expect(screen.getByText('编辑市场')).toBeInTheDocument()
    expect(screen.getByText('更新 GitHub 仓库或本地市场路径。')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await userEvent.click(screen.getByTestId('plugins-manage-marketplaces-button'))
    await userEvent.click(screen.getByTestId('plugins-marketplace-delete-local-openai'))
    expect(screen.getByText('删除市场？')).toBeInTheDocument()
  })

  test('opens the create menu and creates a custom MCP', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    await userEvent.click(screen.getByTestId('plugins-create-mcp-option'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('custom-mcp-import-json-button'))
    fireEvent.change(screen.getByTestId('custom-mcp-import-json-textarea'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            'local-docs': {
              type: 'streamable-http',
              url: 'https://mcp.example.com/local',
              headers: { Authorization: 'Bearer token' },
              description: 'Local docs search',
            },
          },
        }),
      },
    })
    await userEvent.click(screen.getByTestId('custom-mcp-apply-json-button'))

    expect(screen.getByTestId('custom-mcp-name-input')).toHaveValue('local-docs')
    expect(screen.getByTestId('custom-mcp-url-input')).toHaveValue('https://mcp.example.com/local')
    await userEvent.click(screen.getByTestId('custom-mcp-submit-button'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/custom',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"local-docs"'),
      })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('closes the create menu on outside click and Escape', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()
  })
})
