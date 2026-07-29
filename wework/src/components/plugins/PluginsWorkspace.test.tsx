import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
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

function codexPluginSummary(plugin: CodexPluginMock, installed: boolean, enabled = installed) {
  return {
    id: plugin.id,
    remotePluginId: plugin.remotePluginId ?? plugin.id,
    localVersion: '1.0.0',
    name: plugin.name,
    installed,
    enabled,
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
  installedOnly: boolean,
  pluginEnabledById: Map<string, boolean>
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
      codexPluginSummary(
        plugin,
        installedPluginNames.has(plugin.name),
        pluginEnabledById.get(plugin.id) ?? installedPluginNames.has(plugin.name)
      )
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
    deviceId?: string
  } = {}
) {
  const marketplaces = [...(options.marketplaces ?? [])]
  const installedPluginNames = new Set(options.installedPluginNames ?? [])
  const pluginEnabledById = new Map<string, boolean>()
  marketplaces.forEach(marketplace => {
    const plugins = marketplace.plugins ?? [defaultCodexPlugin]
    plugins.forEach(plugin => {
      if (installedPluginNames.has(plugin.name)) pluginEnabledById.set(plugin.id, true)
    })
  })
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
      return Promise.resolve({ running: true, ready: true, deviceId: options.deviceId })
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
          codexMarketplaceResponse(marketplace, installedPluginNames, false, pluginEnabledById)
        ),
      })
    }
    if (method === 'plugin/installed') {
      return Promise.resolve({
        marketplaces: marketplaces.map(marketplace =>
          codexMarketplaceResponse(marketplace, installedPluginNames, true, pluginEnabledById)
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
      if (plugin) pluginEnabledById.set(plugin.id, true)
      return Promise.resolve({ authPolicy: 'ON_USE', appsNeedingAuth: [] })
    }
    if (method === 'plugin/uninstall') {
      const pluginId = String(params.pluginId ?? '')
      for (const marketplace of marketplaces) {
        for (const plugin of marketplace.plugins ?? [defaultCodexPlugin]) {
          if (plugin.id === pluginId) installedPluginNames.delete(plugin.name)
          if (plugin.id === pluginId) pluginEnabledById.delete(plugin.id)
        }
      }
      return Promise.resolve({})
    }
    if (method === 'config/value/write') {
      const keyPath = String(params.keyPath ?? '')
      for (const marketplace of marketplaces) {
        for (const plugin of marketplace.plugins ?? [defaultCodexPlugin]) {
          const configId = `${plugin.name}@${marketplace.name}`
          if (keyPath === `plugins.${JSON.stringify(configId)}.enabled`) {
            pluginEnabledById.set(plugin.id, params.value !== false)
          }
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
    canPublish: boolean
    marketplaceInstalled: boolean
    marketplaceDeviceState: 'installed' | 'failed' | 'pending'
    marketplaceInstallError: string
    marketplaceLogo: string
    installedMarketplaceLogo: string
  }> = {}
) {
  let marketplaceUpdateAvailable = false
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
    installed:
      overrides.marketplaceInstalled &&
      (overrides.marketplaceDeviceState ?? 'installed') === 'installed',
    enabled:
      overrides.marketplaceInstalled &&
      (overrides.marketplaceDeviceState ?? 'installed') === 'installed',
    installedPluginId: overrides.marketplaceInstalled ? 101 : null,
    interface: {
      displayName: 'Documents',
      shortDescription: 'Create and edit documents',
      logo: overrides.marketplaceLogo ?? '/Users/test/plugins/documents/assets/logo.png',
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
    latestReleaseId: 1001,
    currentDeviceInstallation: overrides.marketplaceInstalled
      ? {
          deviceId: 'current-device',
          desiredReleaseId: 1001,
          actualReleaseId: overrides.marketplaceDeviceState === 'installed' ? 1001 : null,
          state: overrides.marketplaceDeviceState ?? 'installed',
          errorCode: overrides.marketplaceDeviceState === 'failed' ? 'PLUGIN_SYNC_FAILED' : null,
          errorMessage:
            overrides.marketplaceDeviceState === 'failed'
              ? 'Codex App Server rejected install'
              : null,
          attemptCount: 1,
          lastSyncAt: null,
          updatedAt: '2026-07-25T12:00:00',
        }
      : null,
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
        catalogItemId: 'openai-documents',
      },
      displayName: 'Documents',
      description: 'Create and edit document artifacts',
      version: '1.0.0',
      enabled: true,
      installState:
        overrides.marketplaceDeviceState === 'failed'
          ? 'failed'
          : overrides.marketplaceDeviceState === 'pending'
            ? 'not_installed'
            : 'installed',
      origin: 'market',
      pluginId: 101,
      releaseId: 1001,
      componentStates: {},
      components: marketplacePlugin.components,
      interface: {
        ...marketplacePlugin.interface,
        logo: overrides.installedMarketplaceLogo ?? marketplacePlugin.interface.logo,
      },
      packageRef: null,
      sourcePayload: null,
    },
    status: {
      state: overrides.marketplaceDeviceState ?? 'installed',
      devices: [
        marketplacePlugin.currentDeviceInstallation ?? {
          deviceId: 'current-device',
          desiredReleaseId: 1001,
          actualReleaseId: 1001,
          state: 'installed',
          errorCode: null,
          errorMessage: null,
          attemptCount: 1,
          lastSyncAt: '2026-07-25T12:00:00',
          updatedAt: '2026-07-25T12:00:00',
        },
      ],
    },
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
      if (requestUrl.pathname === '/api/plugins/capabilities') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ canPublish: overrides.canPublish ?? false }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: overrides.marketplaceInstalled ? [installedMarketplacePlugin] : [],
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/marketplace') {
        const keyword = requestUrl.searchParams.get('q')
        const currentMarketplacePlugin = marketplaceUpdateAvailable
          ? {
              ...marketplacePlugin,
              version: '1.1.0',
              latestReleaseId: 1002,
              updateAvailable: true,
            }
          : marketplacePlugin
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items:
                keyword && !marketplacePlugin.displayName.toLowerCase().includes(keyword)
                  ? []
                  : [currentMarketplacePlugin],
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/marketplace/101/install') {
        if (overrides.marketplaceInstallError) {
          return Promise.resolve({
            ok: false,
            status: 503,
            text: () =>
              Promise.resolve(JSON.stringify({ detail: overrides.marketplaceInstallError })),
          })
        }
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

  return {
    publishMarketplaceUpdate: () => {
      marketplaceUpdateAvailable = true
    },
  }
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

    expect(screen.getByRole('heading', { name: '插件市场' })).toBeInTheDocument()
    expect(screen.getByText('发现并接入开发工具、企业数据和专业方法。')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-search-input')).toHaveAttribute(
      'placeholder',
      '搜索插件'
    )
    expect(screen.getByTestId('plugins-search-input')).toHaveClass('h-9', 'rounded-lg')
    expect(screen.getByTestId('plugins-marketplace-source-switcher')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-selector')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-refresh-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-tab-default')).toHaveTextContent(
      'Wework 云端市场'
    )
    expect(screen.queryByTestId('plugins-marketplace-source-openai')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-add-marketplace-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-manage-marketplaces-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '技能' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'MCP' })).not.toBeInTheDocument()
    expect(screen.queryByText('帮我整理本周的项目进度并生成可视化报告')).not.toBeInTheDocument()
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(convertFileSrc).toHaveBeenCalledWith('/Users/test/plugins/documents/assets/logo.png')
    expect(screen.getAllByText('Productivity').length).toBeGreaterThan(0)
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

  test('checks cloud plugin updates when the window regains focus', async () => {
    const marketplace = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('在对话中试用')

    marketplace.publishMarketplaceUpdate()
    fireEvent.focus(window)

    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('更新')
    )
  })

  test('installs a marketplace plugin', async () => {
    const marketplaceLogo = 'data:image/svg+xml;base64,PHN2Zy8+'
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockSystemSkillsFetch({
      marketplaceLogo,
      installedMarketplaceLogo: './assets/github-small.svg',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('在对话中试用')
    )
    expect(screen.getByTestId('plugin-marketplace-install-101')).not.toBeDisabled()
    expect(document.querySelector('img')).toHaveAttribute('src', marketplaceLogo)
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace/101/install?device_id=current-device',
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('does not report an account install as installed when this device failed', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'failed',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugin-marketplace-install-101')).toHaveTextContent(
      '重试安装'
    )
    expect(screen.queryByTestId('plugins-installed-strip-item-101')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))

    expect(screen.getByText('0/1 已安装 · 1 失败')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('重试安装')
    expect(screen.getByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Codex App Server rejected install'
    )
    expect(screen.getByTestId('plugin-detail-actions-101')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace?device_id=current-device',
      expect.objectContaining({ method: 'GET' })
    )
  })

  test('shows pending marketplace installation as syncing and prevents duplicate installs', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace />)

    const action = await screen.findByTestId('plugin-marketplace-install-101')
    expect(action).toHaveTextContent('同步中...')
    expect(action).toBeDisabled()

    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('同步中...')
    expect(screen.getByTestId('plugin-detail-toggle-101')).toBeDisabled()
  })

  test('shows publishing only when the cloud capability enables it', async () => {
    mockSystemSkillsFetch({ canPublish: true })
    render(<PluginsWorkspace />)

    await userEvent.type(await screen.findByTestId('plugins-search-input'), 'missing')

    expect(await screen.findByTestId('plugins-publish-empty-button')).toHaveTextContent('发布插件')
  })

  test('opens installed marketplace plugin actions and uninstalls from the row menu', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

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

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101?device_id=current-device',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
    expect(screen.queryByTestId('plugin-marketplace-actions-101')).not.toBeInTheDocument()
  })

  test('does not merge a local plugin into a cloud item by display name', async () => {
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
      deviceId: 'current-device',
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace/101/install?device_id=current-device',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(invoke).not.toHaveBeenCalledWith(
      'local_executor_request',
      expect.objectContaining({
        params: expect.objectContaining({ method: 'plugin/read' }),
      })
    )
  })

  test('opens marketplace plugin detail from the plugin row', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))

    expect(screen.getByTestId('plugin-detail-back-button')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装' })).toBeInTheDocument()
    expect(screen.getByText('Create and edit documents')).toBeInTheDocument()
    expect(screen.getByText('Draft a document outline from this chat')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /其他组件/ })).toBeInTheDocument()
    expect(screen.getByText('Documents App')).toBeInTheDocument()
    expect(screen.getByText('documents-app')).toBeInTheDocument()
  })

  test('keeps the resolved marketplace logo on installed plugin details', async () => {
    const marketplaceLogo = 'data:image/svg+xml;base64,PHN2Zy8+'
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceLogo,
      installedMarketplaceLogo: './assets/github-small.svg',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))

    expect(screen.getByTestId('plugin-detail-back-button')).toBeInTheDocument()
    const detailImages = Array.from(document.querySelectorAll('img'))
    expect(detailImages.length).toBeGreaterThan(0)
    detailImages.forEach(image => expect(image).toHaveAttribute('src', marketplaceLogo))
    expect(document.querySelector('img[src="./assets/github-small.svg"]')).toBeNull()
  })

  test('installs a marketplace plugin from the detail page with visible progress', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('在对话中试用')
    )
  })

  test('shows marketplace installation errors on the plugin detail page', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockSystemSkillsFetch({ marketplaceInstallError: 'GitHub OAuth is not configured' })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace?device_id=current-device',
        expect.objectContaining({ method: 'GET' })
      )
    )
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))

    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      'GitHub OAuth is not configured'
    )
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('安装')
  })

  test('opens installed marketplace plugin actions and uninstalls from the detail menu', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

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

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101?device_id=current-device',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(screen.queryByTestId('plugin-detail-actions-101')).not.toBeInTheDocument()
  })

  test('does not expose arbitrary marketplace controls to ordinary users', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-add-marketplace-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-manage-marketplaces-button')).not.toBeInTheDocument()
  })

  test('keeps the cloud marketplace selected when local marketplaces are configured', async () => {
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
    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toHaveClass('bg-surface')
    expect(screen.getByTestId('plugins-marketplace-tab-existing-market')).toBeInTheDocument()
    expectCodexAppServerRequest('plugin/list', { cwds: null })
  })

  test('renders Codex upstream marketplaces after the cloud marketplace', async () => {
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

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toHaveTextContent(
      'Wework 云端市场'
    )
    expect(screen.getByTestId('plugins-marketplace-tab-openai-curated-remote')).toHaveTextContent(
      'OpenAI 官方市场'
    )
    expectCodexAppServerRequest('plugin/list', {
      cwds: null,
    })
  })

  test('renders configured local marketplaces as secondary market tabs', async () => {
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

    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-tab-local-openai')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-tab-local-team')).toBeInTheDocument()
  })

  test('shows add-marketplace state when no marketplace is configured', async () => {
    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByText('云端插件市场暂不可用')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-cloud-marketplace-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-search-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-source-switcher')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-publish-empty-button')).not.toBeInTheDocument()

    expect(
      screen.queryByTestId('plugins-add-custom-marketplace-empty-button')
    ).not.toBeInTheDocument()
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

  test('disables an installed plugin without uninstalling it', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(isTauri).mockReturnValue(true)
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI',
          path: 'https://github.com/openai/plugins',
        },
      ],
      installedPluginNames: ['documents'],
    })
    const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
    const localPluginApi = createLocalCodexPluginApi()

    await localPluginApi.readState({ refresh: true })
    const updated = await localPluginApi.updateInstalledPlugin('101', { enabled: false })

    expect(updated.spec.enabled).toBe(false)
    expectCodexAppServerRequest('config/value/write', {
      keyPath: 'plugins."documents@openai-official".enabled',
      value: false,
      mergeStrategy: 'upsert',
    })
    expectCodexAppServerRequest('plugin/installed', {
      cwds: null,
      installSuggestionPluginNames: null,
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'local_executor_request',
      expect.objectContaining({
        params: expect.objectContaining({ method: 'plugin/uninstall' }),
      })
    )
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

  test('does not expose deletion for local marketplaces', async () => {
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

    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-manage-marketplaces-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-delete-local-openai')).not.toBeInTheDocument()
  })

  test('does not expose sorting or editing for local marketplaces', async () => {
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

    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-manager-dialog')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('plugins-marketplace-move-down-local-openai')
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-edit-local-openai')).not.toBeInTheDocument()
  })

  test('opens the create menu and navigates to plugin creation', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    await userEvent.click(screen.getByTestId('plugins-create-plugin-option'))

    expect(window.location.pathname).toBe('/plugins/create')
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()
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
