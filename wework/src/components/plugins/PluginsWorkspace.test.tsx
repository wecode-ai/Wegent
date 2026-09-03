import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { authorizeWegentConnector, listWegentConnectorApps } from '@/api/cloud/connectorApps'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { clearLocalConnectorAuthHealthCache } from '@/api/local/localConnectorAuth'
import { clearPluginDeviceAutoSyncAttempts } from '@/features/plugins/pluginDeviceAutoSync'
import {
  resetLocalExecutorCloudConnectionStatus,
  setLocalExecutorCloudConnectionStatus,
} from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import {
  clearPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { resetLocalExecutorStateForTests } from '@/desktop/localExecutor'
import type { PluginMarketplaceItem, PluginPublicationRequestItem } from '@/types/api'
import '@/i18n'
import { PluginsWorkspace } from './PluginsWorkspace'

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}))
const localExecutorMocks = vi.hoisted(() => ({
  ensureStarted: vi.fn(),
  request: vi.fn(),
}))
const desktopHostMock = vi.hoisted(() => vi.fn())

async function installPluginFromMarketCard(testId: string) {
  await userEvent.click(screen.getByTestId(testId))
  await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
  await waitFor(() => expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument())
}

vi.mock('@/desktop/localExecutor', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/localExecutor')>()),
  ensureLocalExecutorStarted: localExecutorMocks.ensureStarted,
  requestLocalExecutor: localExecutorMocks.request,
}))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMock,
}))

vi.mock('@/telemetry/client', () => telemetryMocks)
vi.mock('@/api/cloud/connectorApps', () => ({
  authorizeWegentConnector: vi.fn(),
  listWegentConnectorApps: vi.fn(),
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
  availability?: string
  disabledReason?: string | null
  installPolicy?: string
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
    installPolicy: plugin.installPolicy ?? 'AVAILABLE',
    authPolicy: 'ON_USE',
    availability: plugin.availability ?? 'AVAILABLE',
    disabledReason: plugin.disabledReason ?? null,
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
    backendConnected?: boolean | (() => boolean)
    cloudLinks?: Array<{
      localPluginName: string
      cloudPluginId: number
      cloudReleaseId: number
    }>
    unlinkError?: Error
    wegentStorePlugins?: Array<{
      name: string
      packageId: string
      marketplace: string
      version?: string | null
      enabled: boolean
      displayName?: string | null
      description?: string | null
      logo?: string | null
      category?: string | null
      pluginPath: string
    }>
    localConnectorAuthHealth?: () => Promise<unknown>
    localPluginImport?: {
      archivePath: string
      pluginName: string
      displayName: string
      version: string
    }
  } = {}
) {
  localExecutorMocks.ensureStarted.mockResolvedValue({
    running: true,
    ready: true,
    deviceId: options.deviceId,
  })
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

  vi.mocked(requestLocalExecutor).mockImplementation((method: string, params?: unknown) => {
    if (method === 'executor.plugins.import_package.preview' && options.localPluginImport) {
      return Promise.resolve({
        valid: true,
        archivePath: options.localPluginImport.archivePath,
        sha256: 'a'.repeat(64),
        name: options.localPluginImport.pluginName,
        displayName: options.localPluginImport.displayName,
        version: options.localPluginImport.version,
        description: 'Imported offline fixture',
        skillCount: 1,
        mcpServerCount: 0,
        executableCapabilities: [],
        existing: false,
        existingVersion: null,
        issues: [],
      })
    }
    if (method === 'executor.plugins.import_package' && options.localPluginImport) {
      return Promise.resolve({
        pluginName: options.localPluginImport.pluginName,
        displayName: options.localPluginImport.displayName,
        version: options.localPluginImport.version,
        rollbackId: 'offline-import-rollback',
      })
    }
    if (method === 'executor.plugins.import_package.finalize') return Promise.resolve(undefined)
    if (method === 'executor.codex_home.status') {
      return Promise.resolve({
        weworkCodexHome: '/Users/test/.wework/codex',
        nativeCodexHome: '/Users/test/.codex',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: false,
        shouldPromptMigration: false,
      })
    }
    if (method === 'executor.codex_home.migrate') {
      return Promise.resolve({
        weworkCodexHome: '/Users/test/.wework/codex',
        nativeCodexHome: '/Users/test/.codex',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: true,
        shouldPromptMigration: false,
      })
    }
    if (method === 'executor.plugins.links.list') {
      return Promise.resolve(options.cloudLinks ?? [])
    }
    if (method === 'executor.plugins.store.list') {
      return Promise.resolve({
        storePath: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
        plugins: options.wegentStorePlugins ?? [],
      })
    }
    if (method === 'executor.plugins.personal.list') {
      return Promise.resolve({ marketplacePath: '', plugins: [] })
    }
    if (method === 'executor.plugins.links.unlink' && options.unlinkError) {
      return Promise.reject(options.unlinkError)
    }
    const request = { method, params: params as Record<string, unknown> | undefined }
    if (
      request.method === 'runtime.codex.plugin.install_local_first' &&
      options.localPluginImport
    ) {
      installedPluginNames.add(options.localPluginImport.pluginName)
      return Promise.resolve({
        pluginName: options.localPluginImport.pluginName,
        localCommitted: true,
      })
    }
    if (request.method === 'runtime.codex.plugin.uninstall_local') {
      const pluginName = String(request.params?.pluginName ?? '')
      installedPluginNames.delete(pluginName)
      return Promise.resolve({
        pluginKey: `${pluginName}@wework-personal`,
        localCommitted: true,
      })
    }
    if (request.method === 'executor.backend.status') {
      const connected =
        typeof options.backendConnected === 'function'
          ? options.backendConnected()
          : options.backendConnected !== false
      return Promise.resolve({ configured: true, connected })
    }
    if (request.method === 'runtime.local_connector_auth.health') {
      return options.localConnectorAuthHealth?.() ?? Promise.resolve({ status: 'ok' })
    }

    if (request.method !== 'codex.app_server_request') return Promise.resolve(undefined)
    const appServerRequest = request.params ?? {}
    const appServerMethod = String(appServerRequest.method ?? '')
    const appServerParams = (appServerRequest.params ?? {}) as Record<string, unknown>
    if (appServerMethod === 'plugin/list') {
      return Promise.resolve({
        marketplaces: marketplaces.map(marketplace =>
          codexMarketplaceResponse(marketplace, installedPluginNames, false, pluginEnabledById)
        ),
      })
    }
    if (appServerMethod === 'plugin/installed') {
      return Promise.resolve({
        marketplaces: marketplaces.map(marketplace =>
          codexMarketplaceResponse(marketplace, installedPluginNames, true, pluginEnabledById)
        ),
      })
    }
    if (appServerMethod === 'plugin/read') {
      const pluginName = String(appServerParams.pluginName ?? '')
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
    if (appServerMethod === 'marketplace/add') {
      const source = String(appServerParams.source ?? '')
      const marketplaceName =
        source === 'https://github.com/openai/plugins' ? 'openai-official' : `local-${Date.now()}`
      marketplaces.push({
        name: marketplaceName,
        displayName: source === 'https://github.com/openai/plugins' ? 'OpenAI 官方市场' : source,
        path: source,
      })
      return Promise.resolve({ marketplaceName, installedRoot: '/Users/test/codex/plugins/cache' })
    }
    if (appServerMethod === 'marketplace/remove') {
      const marketplaceName = String(appServerParams.marketplaceName ?? '')
      const index = marketplaces.findIndex(marketplace => marketplace.name === marketplaceName)
      if (index >= 0) marketplaces.splice(index, 1)
      return Promise.resolve({ marketplaceName, installedRoot: null })
    }
    if (appServerMethod === 'plugin/install') {
      const pluginName = String(appServerParams.pluginName ?? '')
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
    if (appServerMethod === 'plugin/uninstall') {
      const pluginId = String(appServerParams.pluginId ?? '')
      for (const marketplace of marketplaces) {
        for (const plugin of marketplace.plugins ?? [defaultCodexPlugin]) {
          const aliases = new Set(
            [
              plugin.id,
              plugin.name,
              `${plugin.name}@${marketplace.name}`,
              plugin.remotePluginId ?? '',
            ].filter(Boolean)
          )
          if (!aliases.has(pluginId)) continue
          installedPluginNames.delete(plugin.name)
          pluginEnabledById.delete(plugin.id)
        }
      }
      return Promise.resolve({})
    }
    if (appServerMethod === 'config/value/write') {
      const keyPath = String(appServerParams.keyPath ?? '')
      for (const marketplace of marketplaces) {
        for (const plugin of marketplace.plugins ?? [defaultCodexPlugin]) {
          const configId = `${plugin.name}@${marketplace.name}`
          if (keyPath === `plugins.${JSON.stringify(configId)}.enabled`) {
            pluginEnabledById.set(plugin.id, appServerParams.value !== false)
          }
        }
      }
      return Promise.resolve({})
    }
    if (appServerMethod === 'skills/config/write') {
      return Promise.resolve({ effectiveEnabled: appServerParams.enabled })
    }
    if (appServerMethod === 'skills/list') {
      return Promise.resolve({
        data: [
          {
            cwd: Array.isArray(appServerParams.cwds) ? String(appServerParams.cwds[0] ?? '') : '',
            skills,
            errors: [],
          },
        ],
      })
    }
    if (appServerMethod === 'app/list') {
      return Promise.resolve({
        data: apps,
        nextCursor: null,
      })
    }
    return Promise.resolve({})
  })
}

function expectCodexAppServerRequest(method: string, params: Record<string, unknown>) {
  expect(requestLocalExecutor).toHaveBeenCalledWith('codex.app_server_request', {
    method,
    params: expect.objectContaining(params),
  })
}

function expectCodexAppServerRequestNotCalled(method: string) {
  expect(requestLocalExecutor).not.toHaveBeenCalledWith('codex.app_server_request', {
    method,
    params: expect.anything(),
  })
}

function expectFetchRequest(path: string, method = 'GET') {
  expect(vi.mocked(fetch).mock.calls).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
        expect.objectContaining({ method }),
      ]),
    ])
  )
}

function mockSystemSkillsFetch(
  overrides: Partial<{
    installState: 'not_installed' | 'installed' | 'update_available'
    enabled: boolean
    installedSkillId: number | null
    marketplaceInstalled: boolean
    marketplaceDeviceState: 'installed' | 'failed' | 'pending'
    marketplaceInstallError: string
    marketplaceLogo: string
    marketplaceBrandColor: string
    installedMarketplaceLogo: string
    marketplaceCount: number
    marketplaceConnectorSlug: string
    marketplaceConnectorLocal: boolean
    marketplaceHasSkill: boolean
    marketplaceVisibility: 'personal' | 'workspace' | 'public'
    marketplaceSourceProvider: 'codex' | 'wegent'
    marketplaceAccessRole: 'catalog' | 'owner' | 'recipient'
    marketplaceName: string
    marketplaceDisplayName: string
    deviceAutoSyncSucceeds: boolean
    reportDeviceFailures: number
    localVersionEvidence: string
    marketplaceUpdateAvailable: boolean
    marketplaceUpdatePolicy: 'manual' | 'auto'
    autoUpdateBatchSizes: number[]
    deviceAutoSyncGate: Promise<void>
    pluginAccessGate: Promise<void>
    publicationRequestGate: Promise<void>
    publicationRequests: PluginPublicationRequestItem[]
    publicationRequestFailures: number
  }> = {}
) {
  let marketplaceUpdateAvailable = Boolean(overrides.marketplaceUpdateAvailable)
  let marketplaceLatestReleaseId = marketplaceUpdateAvailable ? 1002 : 1001
  let marketplaceUpdatePolicy = overrides.marketplaceUpdatePolicy ?? 'manual'
  const autoUpdateBatchSizes = [...(overrides.autoUpdateBatchSizes ?? [])]
  let autoUpdateBatchCalls = 0
  let cloudMarketplacePluginInstalled = Boolean(overrides.marketplaceInstalled)
  let marketplaceDeviceState: 'installed' | 'failed' | 'pending' =
    overrides.marketplaceDeviceState ?? 'installed'
  let syncDeviceCalls = 0
  let reportDeviceCalls = 0
  let remainingReportDeviceFailures = overrides.reportDeviceFailures ?? 0
  let remainingPublicationRequestFailures = overrides.publicationRequestFailures ?? 0
  const deviceAutoSyncSucceeds = Boolean(overrides.deviceAutoSyncSucceeds)
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
  const buildDocumentsMarketplacePlugin = () => ({
    id: 101,
    remotePluginId: 'openai-documents',
    name: overrides.marketplaceName ?? 'documents',
    displayName: overrides.marketplaceDisplayName ?? 'Documents',
    description: 'Create and edit document artifacts',
    version: '1.0.0',
    author: 'OpenAI',
    visibility: overrides.marketplaceVisibility ?? 'public',
    accessRole: overrides.marketplaceAccessRole,
    grantUserCount: overrides.marketplaceAccessRole === 'owner' ? 4 : undefined,
    grantNamespaceCount: overrides.marketplaceAccessRole === 'owner' ? 0 : undefined,
    sourceProvider: overrides.marketplaceSourceProvider ?? 'codex',
    sourceLabel: overrides.marketplaceSourceProvider === 'wegent' ? 'Wegent 官方' : 'Codex 官方',
    featured: false,
    installed: cloudMarketplacePluginInstalled && marketplaceDeviceState === 'installed',
    enabled: cloudMarketplacePluginInstalled && marketplaceDeviceState === 'installed',
    installedPluginId: cloudMarketplacePluginInstalled ? 101 : null,
    interface: {
      displayName: 'Documents',
      shortDescription: 'Create and edit documents',
      logo: overrides.marketplaceLogo ?? '/Users/test/plugins/documents/assets/logo.png',
      composerIcon: null,
      brandColor: overrides.marketplaceBrandColor ?? null,
      category: 'Productivity',
      defaultPrompt: 'Draft a document outline from this chat',
      homepageUrl: null,
      supportUrl: null,
      categories: ['productivity'],
      tags: ['docs'],
    },
    components: {
      skills: overrides.marketplaceHasSkill
        ? [
            {
              name: 'documents',
              description: 'Create and edit documents',
              path: '/skills/documents',
            },
          ]
        : [],
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
      connectors: overrides.marketplaceConnectorSlug
        ? [
            {
              slug: overrides.marketplaceConnectorSlug,
              authPolicy: 'on_install',
              ...(overrides.marketplaceConnectorLocal
                ? {
                    localAuth: {
                      kind: 'browser_oauth',
                      health: ['scripts/local-auth.sh', 'health'],
                      start: ['scripts/local-auth.sh', 'login'],
                      poll: [],
                    },
                  }
                : {}),
            },
          ]
        : [],
    },
    createdAt: null,
    updatedAt: null,
    latestReleaseId: marketplaceLatestReleaseId,
    currentDeviceInstallation: cloudMarketplacePluginInstalled
      ? {
          deviceId: 'current-device',
          desiredReleaseId: 1001,
          actualReleaseId: marketplaceDeviceState === 'installed' ? 1001 : null,
          state: marketplaceDeviceState,
          errorCode: marketplaceDeviceState === 'failed' ? 'PLUGIN_SYNC_FAILED' : null,
          errorMessage:
            marketplaceDeviceState === 'failed' ? 'Codex App Server rejected install' : null,
          attemptCount: 1,
          lastSyncAt: null,
          updatedAt: '2026-07-25T12:00:00',
        }
      : null,
  })
  const buildMarketplacePlugins = () =>
    Array.from({ length: Math.max(1, overrides.marketplaceCount ?? 1) }, (_, index) => {
      if (index === 0) return buildDocumentsMarketplacePlugin()
      const sequence = index + 1
      const documentsPlugin = buildDocumentsMarketplacePlugin()
      return {
        ...documentsPlugin,
        id: 100 + sequence,
        remotePluginId: `openai-plugin-${sequence}`,
        name: `plugin-${sequence}`,
        displayName: `Plugin ${sequence}`,
        installed: false,
        enabled: false,
        installedPluginId: null,
        latestReleaseId: 1000 + sequence,
        currentDeviceInstallation: null,
        interface: {
          ...documentsPlugin.interface,
          displayName: `Plugin ${sequence}`,
          shortDescription: `Plugin ${sequence} description`,
          logo: `/Users/test/plugins/plugin-${sequence}/assets/logo.png`,
        },
      }
    })
  const buildInstalledMarketplacePlugin = () => {
    const marketplaceRow = buildDocumentsMarketplacePlugin()
    return {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: {
        name: marketplaceRow.name,
        namespace: 'default',
        labels: { id: '101' },
      },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: marketplaceRow.name,
          catalogItemId: 'openai-documents',
          marketplace: 'default',
        },
        displayName: marketplaceRow.displayName,
        description: 'Create and edit document artifacts',
        version: '1.0.0',
        enabled: true,
        installState:
          marketplaceDeviceState === 'failed'
            ? 'failed'
            : marketplaceDeviceState === 'pending'
              ? 'not_installed'
              : 'installed',
        origin: 'market',
        sourceProvider: overrides.marketplaceSourceProvider ?? 'codex',
        sourceLabel:
          overrides.marketplaceSourceProvider === 'wegent' ? 'Wegent 官方' : 'Codex 官方',
        visibility: marketplaceRow.visibility,
        pluginId: 101,
        releaseId: 1001,
        updatePolicy: marketplaceUpdatePolicy,
        componentStates: {},
        components: marketplaceRow.components,
        interface: {
          ...marketplaceRow.interface,
          logo: overrides.installedMarketplaceLogo ?? marketplaceRow.interface.logo,
        },
        packageRef: null,
        sourcePayload: overrides.localVersionEvidence
          ? {
              localPresent: true,
              localVersion: overrides.localVersionEvidence,
              cloudInstalledPluginId: '101',
            }
          : null,
      },
      status: {
        state: marketplaceDeviceState,
        devices: [
          marketplaceRow.currentDeviceInstallation ?? {
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
      if (requestUrl.pathname === '/api/plugins/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: cloudMarketplacePluginInstalled ? [buildInstalledMarketplacePlugin()] : [],
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/marketplace/101/access') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        const response = {
          pluginId: 101,
          scope: body?.scope ?? 'restricted',
          targets: body?.targets ?? [
            {
              entityType: 'user',
              entityId: '7',
              displayName: 'Alice',
            },
          ],
          allowCopy: body?.allowCopy ?? true,
          revocationPendingCount: 0,
        }
        return (overrides.pluginAccessGate ?? Promise.resolve()).then(() => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve(response),
        }))
      }
      if (requestUrl.pathname === '/api/plugins/installed/report-device') {
        reportDeviceCalls += 1
        if (remainingReportDeviceFailures > 0) {
          remainingReportDeviceFailures -= 1
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ detail: 'temporarily unavailable' }),
          })
        }
        marketplaceDeviceState = 'installed'
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deviceId: requestUrl.searchParams.get('device_id') || 'current-device',
              acknowledgedCount: 1,
              acknowledgedInstalledPluginIds: [101],
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/installed/sync-device') {
        syncDeviceCalls += 1
        const response = {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deviceId: requestUrl.searchParams.get('device_id') || 'current-device',
              pendingCount: 1,
              sync: {
                success: deviceAutoSyncSucceeds,
                device_id: 'current-device',
                mode: 'replace',
                skills: [],
                plugins: deviceAutoSyncSucceeds
                  ? [{ id: '101', status: 'synced' }]
                  : [{ id: '101', status: 'failed', error: 'still broken' }],
                mcps: [],
                errors: [],
                synced: deviceAutoSyncSucceeds ? 1 : 0,
                failed: deviceAutoSyncSucceeds ? 0 : 1,
                skipped: 0,
                results: [
                  {
                    device_id: 'current-device',
                    success: deviceAutoSyncSucceeds,
                  },
                ],
              },
            }),
        }
        const completeSync = () => {
          if (deviceAutoSyncSucceeds) {
            marketplaceDeviceState = 'installed'
          }
          return response
        }
        return overrides.deviceAutoSyncGate
          ? overrides.deviceAutoSyncGate.then(completeSync)
          : Promise.resolve(completeSync())
      }
      if (requestUrl.pathname === '/api/plugins/installed/auto-update-batch') {
        autoUpdateBatchCalls += 1
        const updatedCount = autoUpdateBatchSizes.shift() ?? 0
        const remainingCount = autoUpdateBatchSizes.reduce((total, count) => total + count, 0)
        if (remainingCount === 0) marketplaceUpdateAvailable = false
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              updated: Array.from({ length: updatedCount }, (_, index) => ({
                installedPluginId: index + 101,
                pluginId: index + 201,
                fromReleaseId: index + 301,
                toReleaseId: index + 401,
                version: '2.0.0',
              })),
              updatedCount,
              remainingCount,
            }),
        })
      }
      if (requestUrl.pathname === '/api/plugins/marketplace') {
        const keyword = requestUrl.searchParams.get('q')
        const currentMarketplacePlugins = buildMarketplacePlugins().map((plugin, index) =>
          marketplaceUpdateAvailable && index === 0
            ? {
                ...plugin,
                version: '1.1.0',
                latestReleaseId: marketplaceLatestReleaseId,
                updateAvailable: true,
              }
            : plugin
        )
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: keyword
                ? currentMarketplacePlugins.filter(plugin =>
                    plugin.displayName.toLowerCase().includes(keyword)
                  )
                : currentMarketplacePlugins,
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
            cloudMarketplacePluginInstalled = true
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ plugin: buildInstalledMarketplacePlugin() }),
            })
          }, 10)
        })
      }
      if (requestUrl.pathname === '/api/plugins/installed/101' && init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        if (body.updatePolicy === 'manual' || body.updatePolicy === 'auto') {
          marketplaceUpdatePolicy = body.updatePolicy
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(buildInstalledMarketplacePlugin()),
          })
        }
      }
      if (requestUrl.pathname === '/api/plugins/installed/101' && init?.method === 'DELETE') {
        cloudMarketplacePluginInstalled = false
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve(null),
        })
      }
      if (requestUrl.pathname === '/api/plugins/publication-requests') {
        if (remainingPublicationRequestFailures > 0) {
          remainingPublicationRequestFailures -= 1
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ detail: 'Publication service unavailable' }),
          })
        }
        const publications = overrides.publicationRequests ?? []
        return (overrides.publicationRequestGate ?? Promise.resolve()).then(() => ({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: publications,
              total: publications.length,
              page: Number(requestUrl.searchParams.get('page') ?? 1),
              limit: Number(requestUrl.searchParams.get('limit') ?? 100),
            }),
        }))
      }
      const publicationRequestMatch = requestUrl.pathname.match(
        /^\/api\/plugins\/publication-requests\/(\d+)$/
      )
      if (publicationRequestMatch) {
        const publication = (overrides.publicationRequests ?? []).find(
          item => item.id === Number(publicationRequestMatch[1])
        )
        return Promise.resolve({
          ok: Boolean(publication),
          status: publication ? 200 : 404,
          json: () => Promise.resolve(publication ?? { detail: 'Not found' }),
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
      marketplaceLatestReleaseId += 1
      marketplaceUpdateAvailable = true
    },
    getSyncDeviceCalls: () => syncDeviceCalls,
    getReportDeviceCalls: () => reportDeviceCalls,
    getAutoUpdateBatchCalls: () => autoUpdateBatchCalls,
  }
}

const emptyPluginComponents = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
  connectors: [],
}

function buildPublicationRequest(
  overrides: Partial<PluginPublicationRequestItem> = {}
): PluginPublicationRequestItem {
  const revision = {
    id: 901,
    number: 1,
    requestedVersion: '1.0.0',
    snapshotSha256: 'a'.repeat(64),
    status: 'published' as const,
    releaseNotes: 'Initial enterprise release',
    testNotes: 'Windows and macOS passed',
    createdAt: '2026-08-28T08:00:00Z',
    declarations: [],
    manifest: {},
    packageEntries: ['dev-tools/.codex-plugin/plugin.json'],
    packageEntryCount: 1,
    packageEntriesTruncated: false,
    capabilities: ['skill:dev-tools'],
  }
  return {
    id: 82,
    pluginId: 101,
    enterprisePluginId: 303,
    pluginName: 'Dev Tools',
    pluginSlug: 'dev-tools',
    requestedVersion: '1.0.0',
    submitter: { id: 7, userName: 'Alice', email: 'alice@example.com' },
    currentRevision: 1,
    stage: 'release',
    status: 'published',
    riskLevel: 'low',
    blockerCount: 0,
    warningCount: 0,
    gitlabStatus: null,
    waitingDurationSeconds: 3600,
    submittedAt: '2026-08-28T08:00:00Z',
    updatedAt: '2026-08-28T09:00:00Z',
    revision,
    revisions: [revision],
    checks: [],
    events: [],
    gitlab: null,
    actionEligibility: {
      canWithdraw: false,
      canCreateRevision: false,
      canViewEnterprisePlugin: true,
      canReturn: false,
      canAccept: false,
      canReconcile: false,
      blockedReasons: [],
    },
    ...overrides,
  }
}

function githubConnectorComponent() {
  return {
    slug: 'github',
    authPolicy: 'on_use' as const,
  }
}

function seedDurableOpenAiGithubPeek(options?: {
  includeGmailInstall?: boolean
  includeGithubConnector?: boolean
}) {
  const githubComponents = options?.includeGithubConnector
    ? { ...emptyPluginComponents, connectors: [githubConnectorComponent()] }
    : emptyPluginComponents
  const githubItem = {
    id: 'github@openai-curated-remote',
    remotePluginId: 'plugin_connector_1p_github',
    name: 'github',
    displayName: 'GitHub',
    description: 'Connect GitHub',
    visibility: 'public',
    featured: false,
    installed: true,
    installedPluginId: 'github@openai-curated-remote',
    installedLocally: true,
    enabled: true,
    sourceType: 'marketplace',
    sourceProvider: 'codex',
    sourceLabel: 'OpenAI 官方',
    components: githubComponents,
    manifest: { marketplaceId: 'openai-curated-remote' },
    ownerUserId: 0,
    latestReleaseId: null,
    interface: {
      displayName: 'GitHub',
      shortDescription: 'Connect GitHub',
      category: 'Developer Tools',
    },
  }
  const gmailItem = {
    ...githubItem,
    id: 'gmail@openai-curated-remote',
    remotePluginId: 'plugin_connector_1p_gmail',
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Connect Gmail',
    installed: true,
    installedPluginId: 'gmail@openai-curated-remote',
    components: emptyPluginComponents,
    interface: {
      displayName: 'Gmail',
      shortDescription: 'Connect Gmail',
      category: 'Communication',
    },
  }
  const githubInstalled = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'github',
      namespace: 'openai-curated-remote',
      labels: { id: 'github@openai-curated-remote' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'openai-curated-remote',
        pluginKey: 'github',
        catalogItemId: 'plugin_connector_1p_github',
        marketplace: 'openai-curated-remote',
      },
      origin: 'market',
      sourceProvider: 'codex',
      sourceLabel: 'OpenAI 官方',
      visibility: 'public',
      displayName: 'GitHub',
      description: 'Connect GitHub',
      version: '0.1.8',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: {},
      components: githubComponents,
      interface: { displayName: 'GitHub' },
      packageRef: null,
      sourcePayload: { marketplaceName: 'openai-curated-remote' },
    },
    status: { state: 'enabled' },
  }
  const gmailInstalled = {
    ...githubInstalled,
    metadata: {
      name: 'gmail',
      namespace: 'openai-curated-remote',
      labels: { id: 'gmail@openai-curated-remote' },
    },
    spec: {
      ...githubInstalled.spec,
      source: {
        ...githubInstalled.spec.source,
        pluginKey: 'gmail',
        catalogItemId: 'plugin_connector_1p_gmail',
      },
      displayName: 'Gmail',
      description: 'Connect Gmail',
      components: emptyPluginComponents,
      interface: { displayName: 'Gmail' },
    },
  }
  window.localStorage.setItem(
    'wework.plugins.codexReadState.v2',
    JSON.stringify({
      version: 2,
      entries: {
        '|all': {
          paramsKey: '|all',
          cachedAt: Date.now() - 120_000,
          state: {
            marketplaceItems: options?.includeGmailInstall ? [githubItem, gmailItem] : [githubItem],
            installedPlugins: options?.includeGmailInstall
              ? [githubInstalled, gmailInstalled]
              : [githubInstalled],
            marketplaces: [{ id: 'openai-curated-remote', name: 'OpenAI', path: null }],
            selectedMarketplaceId: 'openai-curated-remote',
            marketplacePath: '',
            installRegistryPath: '',
            deviceId: 'local-device',
          },
        },
      },
    })
  )
}

function mockEmptyCloudPluginApis() {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/plugins/marketplace')) {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/api/plugins/installed')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

function officialCodexPluginSummary(plugin: {
  id: string
  name: string
  displayName: string
  installed: boolean
}) {
  return {
    id: plugin.id,
    remotePluginId: `plugin_connector_1p_${plugin.name}`,
    localVersion: '0.1.8',
    name: plugin.name,
    installed: plugin.installed,
    enabled: plugin.installed,
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    disabledReason: null,
    interface: {
      displayName: plugin.displayName,
      shortDescription: plugin.displayName,
      longDescription: plugin.displayName,
      logo: null,
      composerIcon: null,
      brandColor: null,
      category: 'Developer Tools',
      defaultPrompt: [],
      homepageUrl: null,
      supportUrl: null,
      categories: ['Developer Tools'],
      tags: [],
    },
  }
}

describe('PluginsWorkspace', () => {
  beforeEach(() => {
    delete window.__WEWORK_RUNTIME_CONFIG__
    telemetryMocks.track.mockClear()
    desktopHostMock.mockReset()
    localExecutorMocks.ensureStarted.mockReset()
    localExecutorMocks.ensureStarted.mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'current-device',
    })
    vi.mocked(requestLocalExecutor).mockReset()
    vi.mocked(requestLocalExecutor).mockImplementation(method => {
      if (method === 'executor.plugins.personal.list') {
        return Promise.resolve({ marketplacePath: '', plugins: [] })
      }
      if (method === 'executor.plugins.store.list') {
        return Promise.resolve({
          storePath: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
          plugins: [],
        })
      }
      if (method === 'executor.plugins.links.list') return Promise.resolve([])
      return Promise.resolve(undefined)
    })
    vi.mocked(listWegentConnectorApps).mockReset()
    vi.mocked(listWegentConnectorApps).mockResolvedValue([])
    vi.mocked(authorizeWegentConnector).mockReset()
    vi.mocked(authorizeWegentConnector).mockResolvedValue({
      status: 'connected',
      external_account_name: null,
      granted_scopes: [],
      expires_at: null,
    })
    window.localStorage.clear()
    window.sessionStorage.clear()
    clearPluginMarketplaceCache()
    clearPluginDeviceAutoSyncAttempts()
    clearLocalCodexPluginsReadStateCache()
    clearLocalConnectorAuthHealthCache()
    resetLocalExecutorStateForTests()
    resetLocalExecutorCloudConnectionStatus()
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: true })
    window.history.replaceState({}, '', '/')
    mockSystemSkillsFetch()
  })

  test('keeps the user on the plugin page when the current device is disconnected', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: false })
    mockCodexAppServerInvoke({ backendConnected: false })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))

    expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
    const notice = await screen.findByTestId('plugin-operation-notice')
    expect(notice).toHaveTextContent('当前设备未连接到云端，暂时无法安装插件。请恢复连接后重试。')
    expect(notice).toHaveAttribute('data-notice-kind', 'error')
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/install'))
    ).toBe(false)
    expect(window.location.pathname).toBe('/')

    await userEvent.click(screen.getByTestId('plugin-operation-notice-action'))

    expect(window.location.pathname).toBe('/settings/connections')
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
  })

  test('rechecks the device connection before confirming a cloud install', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let backendConnected = true
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      backendConnected: () => backendConnected,
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))
    expect(await screen.findByTestId('install-plugin-dialog')).toBeInTheDocument()

    backendConnected = false
    await userEvent.click(screen.getByTestId('install-plugin-dialog-confirm'))

    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
      '当前设备未连接到云端，暂时无法安装插件。请恢复连接后重试。'
    )
    expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/install'))
    ).toBe(false)
  })

  test('renders a Codex-style plugin marketplace page', async () => {
    render(<PluginsWorkspace />)

    expect(screen.getByRole('heading', { name: '插件市场' })).toBeInTheDocument()
    expect(screen.getByText('发现并接入开发工具、企业数据和专业方法。')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-search-input')).toHaveAttribute(
      'placeholder',
      '搜索插件'
    )
    expect(screen.getByTestId('plugins-search-input')).toHaveClass('plugin-market-search-input')
    expect(screen.getByTestId('plugins-marketplace-source-switcher')).toHaveClass('sr-only')
    expect(screen.queryByTestId('plugins-marketplace-selector')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-refresh-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-distribution-tab-all')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    const distributionTabs = within(screen.getByTestId('plugins-market-toolbar'))
      .getAllByRole('tab')
      .map(tab => tab.textContent)
    expect(distributionTabs).toEqual(['全部', 'OpenAI官方', 'Wework官方', '企业内部', '个人创建'])
    expect(screen.getByTestId('plugins-distribution-tab-official')).toHaveTextContent('OpenAI官方')
    expect(screen.getByTestId('plugins-distribution-tab-workspace')).toHaveTextContent('企业内部')
    expect(screen.getByTestId('plugins-distribution-tab-personal')).toHaveTextContent('个人创建')
    expect(screen.getByTestId('plugins-marketplace-tab-default')).toHaveTextContent(
      'Wework 云端市场'
    )
    expect(screen.queryByTestId('plugins-marketplace-source-openai')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-add-marketplace-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-manage-marketplaces-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '技能' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'MCP' })).not.toBeInTheDocument()
    expect(screen.queryByText('帮我整理本周的项目进度并生成可视化报告')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-market-toolbar')).toBeInTheDocument()
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    const flatSection = screen.getByTestId('plugins-category-section-all')
    expect(flatSection).toBeInTheDocument()
    expect(within(flatSection).queryByRole('heading')).not.toBeInTheDocument()
  })

  test('locks admin-disabled remote plugins instead of showing Install', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          displayName: 'OpenAI',
          path: null,
          plugins: [
            {
              id: 'gmail@openai-curated-remote',
              remotePluginId: 'plugin_connector_1p_95d39881713c8191931482a62d6edff9',
              name: 'gmail',
              displayName: 'Gmail',
              description: 'Read and manage Gmail',
              category: 'Communication',
              availability: 'DISABLED_BY_ADMIN',
              disabledReason: 'plan_not_eligible',
              installPolicy: 'NOT_AVAILABLE',
            },
          ],
        },
      ],
    })

    render(<PluginsWorkspace />)

    expect(await screen.findByText('Gmail')).toBeInTheDocument()
    const locked = screen.getByTestId('plugin-marketplace-locked-gmail@openai-curated-remote')
    expect(locked).toHaveTextContent('你的套餐不支持')
    expect(locked).toHaveAttribute('data-lock-kind', 'plan_not_eligible')
    expect(
      screen.queryByTestId('plugin-marketplace-install-gmail@openai-curated-remote')
    ).not.toBeInTheDocument()
  })

  test('keeps local marketplace plugins visible when the cloud marketplace fails', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'desktop-e2e-marketplace',
          displayName: 'Desktop E2E Marketplace',
          path: '/tmp/desktop-e2e-marketplace',
        },
      ],
    })
    const successfulFetch = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation((url: string, init?: RequestInit) => {
      const requestUrl = new URL(url, 'http://localhost')
      if (requestUrl.pathname === '/api/plugins/marketplace') {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve(JSON.stringify({ detail: 'Cloud marketplace unavailable' })),
        }) as Promise<Response>
      }
      return successfulFetch!(url, init)
    })

    render(<PluginsWorkspace />)

    expect(
      await screen.findByTestId('plugin-marketplace-row-desktop-e2e-marketplace:101')
    ).toHaveTextContent('Documents')
    expect(screen.queryByTestId('plugins-marketplace-error')).not.toBeInTheDocument()
  })

  test('keeps an installed local marketplace plugin visible under its market tab', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'desktop-e2e-marketplace',
          displayName: 'Desktop E2E Marketplace',
          path: '/tmp/desktop-e2e-marketplace',
        },
      ],
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(
      await screen.findByTestId('plugins-marketplace-tab-desktop-e2e-marketplace')
    )
    const installId = 'plugin-marketplace-install-desktop-e2e-marketplace:101'
    expect(await screen.findByTestId(installId)).toBeInTheDocument()
    await installPluginFromMarketCard(installId)

    expect(
      await screen.findByTestId('plugin-marketplace-actions-desktop-e2e-marketplace:101')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('plugin-marketplace-row-desktop-e2e-marketplace:101')
    ).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的插件')).not.toBeInTheDocument()
  })

  test('renders provided plugin logos without a second brand-color backdrop', async () => {
    mockSystemSkillsFetch({
      marketplaceLogo: 'data:image/png;base64,cG5n',
      marketplaceBrandColor: '#013B7B',
    })
    render(<PluginsWorkspace />)

    const row = await screen.findByTestId('plugin-marketplace-row-101')
    const logoFrame = row.querySelector('.plugin-market-card-logo')

    expect(logoFrame).toHaveClass('plugin-logo-provided')
    expect(logoFrame).not.toHaveAttribute('style')
    expect(logoFrame?.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,cG5n')
  })

  test('keeps marketplace controls fixed above the scrollable content region', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    const scrollRegion = screen.getByTestId('plugins-market-scroll-region')
    expect(scrollRegion).toHaveClass('overflow-y-auto')
    expect(scrollRegion).not.toHaveClass('scrollbar-soft')
    expect(scrollRegion).toContainElement(screen.getByTestId('plugins-installed-strip'))
    expect(scrollRegion).toContainElement(screen.getByTestId('plugins-all-section'))
    expect(scrollRegion).not.toContainElement(screen.getByTestId('plugins-topbar'))
    expect(scrollRegion).not.toContainElement(screen.getByTestId('plugins-market-toolbar'))
    expect(screen.getByTestId('plugins-installed-scroll-region')).toHaveClass(
      'plugin-installed-icons-scroller'
    )
  })

  test('aggregates installed plugins beyond the visible strip limit', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const plugins = Array.from({ length: 14 }, (_, index) => ({
      id: String(200 + index),
      name: `installed-plugin-${index + 1}`,
      displayName: `Installed Plugin ${index + 1}`,
      description: `Installed plugin ${index + 1}`,
      logo: `/Users/test/plugins/installed-plugin-${index + 1}/assets/logo.png`,
    }))
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-official',
          path: 'openai-official',
          plugins,
        },
      ],
      installedPluginNames: plugins.map(plugin => plugin.name),
    })

    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-installed-overflow-button')).toHaveTextContent(
      '另有 2 个'
    )
    expect(screen.getAllByTestId(/^plugins-installed-strip-item-/)).toHaveLength(12)
    expect(
      screen.getByTestId('plugins-installed-overflow-button').querySelectorAll('img')
    ).toHaveLength(2)
  })

  test('previews four plugins per category and opens a browse dialog for the rest', async () => {
    mockSystemSkillsFetch({ marketplaceCount: 20 })
    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-category-section-category-productivity')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^plugin-marketplace-row-/)).toHaveLength(4)

    const reveal = screen.getByTestId('plugins-category-more-category-productivity')
    expect(reveal).toHaveTextContent('查看 Plugin 5, Plugin 6，以及另外 14 个')
    expect(reveal.querySelector('img')).toHaveAttribute(
      'src',
      'file:///Users/test/plugins/plugin-5/assets/logo.png'
    )

    await userEvent.click(reveal)

    const dialog = await screen.findByTestId('plugins-category-browse-dialog')
    expect(dialog).toHaveTextContent('Productivity')
    expect(dialog).toHaveTextContent('20 个插件')
    expect(within(dialog).getAllByTestId(/^plugin-marketplace-row-/)).toHaveLength(20)
    expect(within(dialog).getByTestId('plugin-marketplace-row-101')).toHaveTextContent('Documents')
    expect(within(dialog).getByTestId('plugin-marketplace-row-120')).toHaveTextContent('Plugin 20')

    await userEvent.click(screen.getByTestId('plugins-category-browse-close'))
    expect(screen.queryByTestId('plugins-category-browse-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-official'))

    await waitFor(() => expect(screen.getAllByTestId(/^plugin-marketplace-row-/)).toHaveLength(4))
    expect(screen.getByTestId('plugins-category-more-category-productivity')).toHaveTextContent(
      '查看 Plugin 5, Plugin 6，以及另外 14 个'
    )
  })

  test('filters the plugin marketplace from the search box', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    const marketplaceFetchesBeforeSearch = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).startsWith('/api/plugins/marketplace')).length

    const searchInput = screen.getByTestId('plugins-search-input')
    await userEvent.type(searchInput, 'missing')

    expect(await screen.findByText('没有匹配的插件')).toBeInTheDocument()
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
    // Search is client-side over the already-loaded catalog; typing must not refetch.
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).startsWith('/api/plugins/marketplace')).length
    ).toBe(marketplaceFetchesBeforeSearch)
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes('/api/plugins/marketplace?q='))
    ).toBe(false)

    await userEvent.click(screen.getByTestId('plugins-search-clear-button'))
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(searchInput).toHaveFocus()

    await userEvent.type(searchInput, 'cument')
    expect(await screen.findByText('Documents')).toBeInTheDocument()
  })

  test('keeps the current catalog stable while the user is still typing', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    const searchInput = screen.getByTestId('plugins-search-input')

    fireEvent.change(searchInput, { target: { value: 'missing' } })

    expect(searchInput).toHaveValue('missing')
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的插件')).not.toBeInTheDocument()

    expect(await screen.findByText('没有匹配的插件')).toBeInTheDocument()
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
  })

  test('waits for IME composition to finish before searching', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    const searchInput = screen.getByTestId('plugins-search-input')

    fireEvent.compositionStart(searchInput)
    fireEvent.change(searchInput, { target: { value: '不存在' } })
    await new Promise(resolve => window.setTimeout(resolve, 250))

    expect(screen.getByText('Documents')).toBeInTheDocument()

    fireEvent.compositionEnd(searchInput, { data: '不存在' })
    expect(await screen.findByText('没有匹配的插件')).toBeInTheDocument()
  })

  test('renders large search result sets in bounded batches', async () => {
    mockSystemSkillsFetch({ marketplaceCount: 80 })
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('plugins-search-input'), {
      target: { value: 'plugin' },
    })

    await waitFor(() => expect(screen.getAllByTestId(/^plugin-marketplace-row-/)).toHaveLength(40))

    await userEvent.click(screen.getByTestId('plugins-category-more-all'))

    await waitFor(() =>
      expect(screen.queryByTestId('plugins-category-more-all')).not.toBeInTheDocument()
    )
    expect(screen.getAllByTestId(/^plugin-marketplace-row-/).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('plugins-category-browse-dialog')).not.toBeInTheDocument()
  })

  test('filters marketplace plugins by the prototype distribution tabs', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-workspace'))

    expect(await screen.findByText('没有匹配的插件')).toBeInTheDocument()
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-official'))

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-category-section-all')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Productivity' })).not.toBeInTheDocument()
    expect(screen.queryByText('精选')).not.toBeInTheDocument()
  })

  test('switching distribution tabs does not start extra plugin/list requests', async () => {
    render(<PluginsWorkspace />)
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    const listCallCount = () =>
      vi.mocked(requestLocalExecutor).mock.calls.filter(([command, args]) => {
        if (command !== 'codex.app_server_request') return false
        const request = args as { method?: string; params?: { method?: string } }
        return request.method === 'plugin/list'
      }).length
    const listCallsBefore = listCallCount()

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-all'))
    expect(await screen.findByText('Documents')).toBeInTheDocument()

    expect(listCallCount()).toBe(listCallsBefore)
  })

  test('shows OpenAI official sync empty state when the official catalog is empty', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      marketplaces: [],
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/plugins/marketplace')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/plugins/installed')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))

    expect(await screen.findByTestId('plugins-openai-official-empty')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-openai-official-empty')).toHaveTextContent(
      'OpenAI 官方市场暂无可用插件'
    )
    expect(screen.getByTestId('plugins-openai-official-empty-refresh')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的插件')).not.toBeInTheDocument()
  })

  test('shows OpenAI loading while a fresh non-official cache is being completed', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    window.localStorage.setItem(
      'wework.plugins.codexReadState.v2',
      JSON.stringify({
        version: 2,
        entries: {
          '|all': {
            paramsKey: '|all',
            cachedAt: Date.now(),
            state: {
              marketplaceItems: [
                {
                  id: 'notion@wework-personal',
                  remotePluginId: 'notion',
                  name: 'notion',
                  displayName: 'Notion',
                  description: 'Personal Notion plugin',
                  visibility: 'personal',
                  featured: false,
                  installed: true,
                  installedPluginId: 'notion@wework-personal',
                  enabled: true,
                  sourceType: 'marketplace',
                  sourceProvider: 'codex',
                  sourceLabel: '个人创建',
                  components: {
                    skills: [],
                    commands: [],
                    agents: [],
                    hooks: [],
                    mcps: [],
                    lsps: [],
                    monitors: [],
                    bins: [],
                  },
                  manifest: { marketplaceId: 'wework-personal' },
                  ownerUserId: 0,
                  latestReleaseId: null,
                  interface: {
                    displayName: 'Notion',
                    shortDescription: 'Personal Notion plugin',
                    category: 'Productivity',
                  },
                },
              ],
              installedPlugins: [],
              marketplaces: [
                { id: 'wework-personal', name: '个人创建', path: '/tmp/wework-personal' },
              ],
              selectedMarketplaceId: 'wework-personal',
              marketplacePath: '/tmp/wework-personal',
              installRegistryPath: '',
              deviceId: 'local-device',
            },
          },
        },
      })
    )
    mockCodexAppServerInvoke({ deviceId: 'local-device', marketplaces: [] })

    let resolveList: ((value: unknown) => void) | null = null
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return new Promise(resolve => {
            resolveList = resolve
          })
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByTestId('plugins-marketplace-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-openai-official-empty')).not.toBeInTheDocument()
    // Even a fresh local snapshot must revalidate when it has personal rows but no
    // OpenAI catalog; otherwise the normal one-minute cache TTL hides the sync.
    // plugin/list waits for live plugin/installed so it cannot jump wegent installs.
    await waitFor(() => expect(resolveList).not.toBeNull())

    resolveList?.({
      marketplaces: [
        codexMarketplaceResponse(
          {
            name: 'openai-curated-remote',
            displayName: 'OpenAI',
            path: 'https://github.com/openai/plugins',
            plugins: [
              {
                id: 'gmail',
                name: 'gmail',
                displayName: 'Gmail',
                description: 'Read and manage Gmail',
                category: 'Communication',
              },
            ],
          },
          new Set(),
          false,
          new Map()
        ),
      ],
    })

    expect(await screen.findByText('Gmail')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
  })

  test('paints OpenAI durable peek even when the account cache only has cloud rows', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    window.localStorage.setItem(
      'wework.plugins.codexReadState.v2',
      JSON.stringify({
        version: 1,
        entries: {
          '|all': {
            paramsKey: '|all',
            // Stale enough to revalidate, but still within the 7-day durable TTL.
            cachedAt: Date.now() - 120_000,
            state: {
              marketplaceItems: [
                {
                  id: 'gmail@openai-curated-remote',
                  remotePluginId: 'gmail',
                  name: 'gmail',
                  displayName: 'Gmail',
                  description: 'Read and manage Gmail',
                  visibility: 'public',
                  featured: false,
                  installed: false,
                  installedPluginId: null,
                  enabled: false,
                  sourceType: 'marketplace',
                  sourceProvider: 'codex',
                  sourceLabel: 'OpenAI 官方',
                  components: {
                    skills: [],
                    commands: [],
                    agents: [],
                    hooks: [],
                    mcps: [],
                    lsps: [],
                    monitors: [],
                    bins: [],
                  },
                  manifest: { marketplaceId: 'openai-curated-remote' },
                  ownerUserId: 0,
                  latestReleaseId: null,
                  interface: {
                    displayName: 'Gmail',
                    shortDescription: 'Read and manage Gmail',
                    category: 'Communication',
                  },
                },
              ],
              installedPlugins: [],
              marketplaces: [{ id: 'openai-curated-remote', name: 'OpenAI', path: null }],
              selectedMarketplaceId: 'openai-curated-remote',
              marketplacePath: '',
              installRegistryPath: '',
              deviceId: 'local-device',
            },
          },
        },
      })
    )

    let resolveList: ((value: unknown) => void) | null = null
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command !== 'codex.app_server_request') return Promise.resolve(undefined)
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (request.method === 'plugin/list') {
        return new Promise(resolve => {
          resolveList = resolve
        })
      }
      if (request.method === 'plugin/installed') {
        return Promise.resolve({ marketplaces: [] })
      }
      return Promise.resolve(undefined)
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/plugins/marketplace')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/plugins/installed')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByText('Gmail')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-openai-official-empty')).not.toBeInTheDocument()
    // Stale durable peek must paint immediately and stay interactive. Warm OpenAI
    // rows skip GitHub plugin/list so chat send is not blocked on reconcile.
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled()
    expect(resolveList).toBeNull()

    const marketplaceFetchesBeforeFocus = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes('/api/plugins/marketplace')).length
    fireEvent.focus(window)
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([url]) => String(url).includes('/api/plugins/marketplace')).length
      ).toBeGreaterThan(marketplaceFetchesBeforeFocus)
    )
    // Cloud revalidation can legitimately omit the Codex-owned OpenAI catalog.
    // It must update cloud rows without deleting the already-painted official list.
    expect(screen.getByText('Gmail')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-openai-official-empty')).not.toBeInTheDocument()
    expect(resolveList).toBeNull()
  })

  test('keeps OpenAI official installed strip from durable peek when plugin/installed omits it', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    window.localStorage.setItem(
      'wework.plugins.codexReadState.v2',
      JSON.stringify({
        version: 2,
        entries: {
          '|all': {
            paramsKey: '|all',
            cachedAt: Date.now() - 120_000,
            state: {
              marketplaceItems: [
                {
                  id: 'github@openai-curated-remote',
                  remotePluginId: 'plugin_connector_1p_github',
                  name: 'github',
                  displayName: 'GitHub',
                  description: 'Connect GitHub',
                  visibility: 'public',
                  featured: false,
                  installed: true,
                  installedPluginId: 'github@openai-curated-remote',
                  installedLocally: true,
                  enabled: true,
                  sourceType: 'marketplace',
                  sourceProvider: 'codex',
                  sourceLabel: 'OpenAI 官方',
                  components: {
                    skills: [],
                    commands: [],
                    agents: [],
                    hooks: [],
                    mcps: [],
                    lsps: [],
                    monitors: [],
                    bins: [],
                  },
                  manifest: { marketplaceId: 'openai-curated-remote' },
                  ownerUserId: 0,
                  latestReleaseId: null,
                  interface: {
                    displayName: 'GitHub',
                    shortDescription: 'Connect GitHub',
                    category: 'Developer Tools',
                  },
                },
              ],
              installedPlugins: [
                {
                  apiVersion: 'agent.wecode.io/v1',
                  kind: 'InstalledPlugin',
                  metadata: {
                    name: 'github',
                    namespace: 'openai-curated-remote',
                    labels: { id: 'github@openai-curated-remote' },
                  },
                  spec: {
                    source: {
                      type: 'marketplace',
                      providerKey: 'openai-curated-remote',
                      pluginKey: 'github',
                      catalogItemId: 'plugin_connector_1p_github',
                      marketplace: 'openai-curated-remote',
                    },
                    origin: 'market',
                    sourceProvider: 'codex',
                    sourceLabel: 'OpenAI 官方',
                    visibility: 'public',
                    displayName: 'GitHub',
                    description: 'Connect GitHub',
                    version: '0.1.8',
                    installState: 'installed',
                    enabled: true,
                    componentStates: {},
                    manifest: {},
                    components: {
                      skills: [],
                      commands: [],
                      agents: [],
                      hooks: [],
                      mcps: [],
                      lsps: [],
                      monitors: [],
                      bins: [],
                    },
                    interface: { displayName: 'GitHub' },
                    packageRef: null,
                    sourcePayload: { marketplaceName: 'openai-curated-remote' },
                  },
                  status: { state: 'enabled' },
                },
              ],
              marketplaces: [{ id: 'openai-curated-remote', name: 'OpenAI', path: null }],
              selectedMarketplaceId: 'openai-curated-remote',
              marketplacePath: '',
              installRegistryPath: '',
              deviceId: 'local-device',
            },
          },
        },
      })
    )

    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command !== 'codex.app_server_request') return Promise.resolve(undefined)
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (request.method === 'plugin/list') {
        return new Promise(() => undefined)
      }
      if (request.method === 'plugin/installed') {
        return Promise.resolve({ marketplaces: [] })
      }
      return Promise.resolve(undefined)
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/plugins/marketplace')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/plugins/installed')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(
      await screen.findByTestId('plugins-installed-strip-item-github@openai-curated-remote')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip-empty')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('plugin-marketplace-actions-github@openai-curated-remote')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('plugin-marketplace-install-github@openai-curated-remote')
    ).not.toBeInTheDocument()
  })

  test('keeps OpenAI official installed strip when live plugin/installed only returns bundled', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    seedDurableOpenAiGithubPeek()

    const githubCatalog = officialCodexPluginSummary({
      id: 'github@openai-curated-remote',
      name: 'github',
      displayName: 'GitHub',
      installed: false,
    })
    const documentsInstalled = officialCodexPluginSummary({
      id: 'documents@openai-bundled',
      name: 'documents',
      displayName: 'Documents',
      installed: true,
    })
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command !== 'codex.app_server_request') return Promise.resolve(undefined)
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (request.method === 'plugin/list') {
        return Promise.resolve({
          marketplaces: [
            {
              name: 'openai-curated-remote',
              path: 'openai-curated-remote',
              interface: { displayName: 'OpenAI' },
              plugins: [githubCatalog],
            },
            {
              name: 'openai-bundled',
              path: 'openai-bundled',
              interface: { displayName: 'Bundled' },
              plugins: [documentsInstalled],
            },
          ],
        })
      }
      if (request.method === 'plugin/installed') {
        return Promise.resolve({
          marketplaces: [
            {
              name: 'openai-bundled',
              path: 'openai-bundled',
              interface: { displayName: 'Bundled' },
              plugins: [documentsInstalled],
            },
            {
              name: 'openai-curated-remote',
              path: 'openai-curated-remote',
              interface: { displayName: 'OpenAI' },
              plugins: [],
            },
          ],
        })
      }
      return Promise.resolve(undefined)
    })
    mockEmptyCloudPluginApis()

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await waitFor(() => {
      expect(
        screen.getByTestId('plugins-installed-strip-item-github@openai-curated-remote')
      ).toBeInTheDocument()
      expect(
        screen.queryByTestId('plugin-marketplace-install-github@openai-curated-remote')
      ).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId('plugins-installed-strip-empty')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('plugin-marketplace-actions-github@openai-curated-remote')
    ).toBeInTheDocument()
  })

  test('does not restore an uninstalled OpenAI remote plugin when live membership lists that marketplace', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    seedDurableOpenAiGithubPeek({ includeGmailInstall: true })

    const githubCatalog = officialCodexPluginSummary({
      id: 'github@openai-curated-remote',
      name: 'github',
      displayName: 'GitHub',
      installed: false,
    })
    const gmailCatalog = officialCodexPluginSummary({
      id: 'gmail@openai-curated-remote',
      name: 'gmail',
      displayName: 'Gmail',
      installed: true,
    })
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command !== 'codex.app_server_request') return Promise.resolve(undefined)
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (request.method === 'plugin/list') {
        return Promise.resolve({
          marketplaces: [
            {
              name: 'openai-curated-remote',
              path: 'openai-curated-remote',
              interface: { displayName: 'OpenAI' },
              plugins: [githubCatalog, gmailCatalog],
            },
          ],
        })
      }
      if (request.method === 'plugin/installed') {
        return Promise.resolve({
          marketplaces: [
            {
              name: 'openai-curated-remote',
              path: 'openai-curated-remote',
              interface: { displayName: 'OpenAI' },
              plugins: [gmailCatalog],
            },
          ],
        })
      }
      return Promise.resolve(undefined)
    })
    mockEmptyCloudPluginApis()

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(
      await screen.findByTestId('plugins-installed-strip-item-gmail@openai-curated-remote')
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.queryByTestId('plugins-installed-strip-item-github@openai-curated-remote')
      ).not.toBeInTheDocument()
    })
    expect(
      await screen.findByTestId('plugin-marketplace-install-github@openai-curated-remote')
    ).toBeInTheDocument()
  })

  test('keeps the warm catalog painted while live plugin/installed is still pending', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    window.localStorage.setItem(
      'wework.plugins.codexReadState.v2',
      JSON.stringify({
        version: 1,
        entries: {
          '|all': {
            paramsKey: '|all',
            cachedAt: Date.now() - 120_000,
            state: {
              marketplaceItems: [
                {
                  id: 'gmail@openai-curated-remote',
                  remotePluginId: 'gmail',
                  name: 'gmail',
                  displayName: 'Gmail',
                  description: 'Read and manage Gmail',
                  visibility: 'public',
                  featured: false,
                  installed: false,
                  installedPluginId: null,
                  enabled: false,
                  sourceType: 'marketplace',
                  sourceProvider: 'codex',
                  sourceLabel: 'OpenAI 官方',
                  components: {
                    skills: [],
                    commands: [],
                    agents: [],
                    hooks: [],
                    mcps: [],
                    lsps: [],
                    monitors: [],
                    bins: [],
                  },
                  manifest: { marketplaceId: 'openai-curated-remote' },
                  ownerUserId: 0,
                  latestReleaseId: null,
                  interface: {
                    displayName: 'Gmail',
                    shortDescription: 'Read and manage Gmail',
                    category: 'Communication',
                  },
                },
              ],
              installedPlugins: [],
              marketplaces: [{ id: 'openai-curated-remote', name: 'OpenAI', path: null }],
              selectedMarketplaceId: 'openai-curated-remote',
              marketplacePath: '',
              installRegistryPath: '',
              deviceId: 'local-device',
            },
          },
        },
      })
    )

    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command !== 'codex.app_server_request') return Promise.resolve(undefined)
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (request.method === 'plugin/list' || request.method === 'plugin/installed') {
        return new Promise(() => undefined)
      }
      return Promise.resolve(undefined)
    })

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByText('Gmail')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled()
  })

  test('refreshes the selected marketplace from the top bar', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-refresh-button'))

    await waitFor(() => expectFetchRequest('/api/plugins/marketplace'))
    const marketplaceFetches = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/api/plugins/marketplace'))
    expect(marketplaceFetches.length).toBeGreaterThanOrEqual(2)
  })

  test('checks cloud plugin updates when the window regains focus', async () => {
    const marketplace = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')

    marketplace.publishMarketplaceUpdate()
    fireEvent.focus(window)

    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('更新')
    )
  })

  test('automatically updates cloud plugins in bounded serial batches', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplace = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'auto',
      autoUpdateBatchSizes: [5, 1],
      deviceAutoSyncSucceeds: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplace.getAutoUpdateBatchCalls()).toBe(2))
    await waitFor(() => expect(marketplace.getSyncDeviceCalls()).toBe(2))
    expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('已自动更新 6 个插件')
    expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'success'
    )
  })

  test('automatically retries when a newer release follows a failed release', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplace = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'auto',
      autoUpdateBatchSizes: [1, 1],
      deviceAutoSyncSucceeds: false,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplace.getAutoUpdateBatchCalls()).toBe(1))
    await screen.findByText(/插件自动更新失败/)

    marketplace.publishMarketplaceUpdate()
    fireEvent.focus(window)

    await waitFor(() => expect(marketplace.getAutoUpdateBatchCalls()).toBe(2))
    expect(marketplace.getSyncDeviceCalls()).toBe(2)
  })

  test('does not automatically update a marketplace plugin with manual policy', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplace = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'manual',
      autoUpdateBatchSizes: [1],
      deviceAutoSyncSucceeds: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(await screen.findByTestId('plugin-detail-toggle-101')).toHaveTextContent('更新')
    expect(marketplace.getAutoUpdateBatchCalls()).toBe(0)
    expect(marketplace.getSyncDeviceCalls()).toBe(0)
  })

  test('lets users explicitly opt in to automatic marketplace plugin updates', async () => {
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdatePolicy: 'manual',
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    const toggle = await screen.findByTestId('plugin-auto-update-toggle-101')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ updatePolicy: 'auto' }),
      })
    )
  })

  test('installs a marketplace plugin', async () => {
    const marketplaceLogo = 'data:image/svg+xml;base64,PHN2Zy8+'
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceLogo,
      installedMarketplaceLogo: './assets/github-small.svg',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await installPluginFromMarketCard('plugin-marketplace-install-101')

    expect(await screen.findByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('Documents 已安装')
    expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'success'
    )
    expect(screen.queryByTestId('plugin-marketplace-install-101')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('plugins-installed-strip-item-101').querySelector('img')
    ).toHaveAttribute('src', marketplaceLogo)
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace/101/install?device_id=current-device',
      expect.objectContaining({ method: 'POST' })
    )
    expect(telemetryMocks.track).toHaveBeenCalledWith('plugin_installed', { source: 'cloud' })
  })

  test('waits for a cloud plugin to reach the local executor before starting local auth', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceName: 'dingtalk',
      marketplaceDisplayName: '钉钉',
      marketplaceConnectorSlug: 'dingtalk',
      marketplaceConnectorLocal: true,
    })
    let postInstallHealthCalls = 0
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      localConnectorAuthHealth: () => {
        const installRequested = vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/install'))
        if (!installRequested) {
          return Promise.reject(
            new Error("plugin_not_installed: Installed plugin 'dingtalk' was not found")
          )
        }
        postInstallHealthCalls += 1
        if (postInstallHealthCalls === 1) {
          return Promise.reject(
            new Error("plugin_not_installed: Installed plugin 'dingtalk' was not found")
          )
        }
        return Promise.resolve({ status: 'ok' })
      },
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await screen.findByTestId('plugin-marketplace-install-101')
    await installPluginFromMarketCard('plugin-marketplace-install-101')

    const notice = await screen.findByTestId('plugin-operation-notice', {}, { timeout: 4_000 })
    await waitFor(() => expect(notice).toHaveTextContent('钉钉 已安装'), { timeout: 4_000 })
    expect(postInstallHealthCalls).toBeGreaterThanOrEqual(2)
    expect(screen.queryByTestId('local-connector-auth-dialog')).not.toBeInTheDocument()
  })

  test('shows a lightweight notice while browser authorization is pending', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ marketplaceConnectorSlug: 'github' })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    vi.mocked(listWegentConnectorApps).mockResolvedValue([
      {
        id: 1,
        slug: 'github',
        name: 'GitHub',
        description: 'Connect GitHub',
        icon_url: 'https://example.com/github.png',
        auth_type: 'oauth2',
        connection: {
          status: 'disconnected',
          external_account_name: null,
          granted_scopes: [],
          expires_at: null,
        },
      },
    ])
    let finishAuthorization = () => undefined
    vi.mocked(authorizeWegentConnector).mockImplementation(
      () =>
        new Promise(resolve => {
          finishAuthorization = () =>
            resolve({
              status: 'connected',
              external_account_name: 'octocat',
              granted_scopes: [],
              expires_at: null,
            })
        })
    )

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))
    const confirmInstall = await screen.findByTestId('install-plugin-dialog-confirm')
    expect(confirmInstall).toHaveTextContent('安装并连接 GitHub')
    expect(screen.getByTestId('install-plugin-dialog')).toHaveTextContent('需要连接 GitHub')
    await userEvent.click(confirmInstall)

    const notice = await screen.findByTestId('plugin-operation-notice')
    expect(notice).toHaveAttribute('data-notice-kind', 'authorization')
    expect(notice).toHaveTextContent('请在浏览器中完成 GitHub 连接')
    expect(notice.querySelector('img')).toHaveAttribute('src', 'https://example.com/github.png')

    finishAuthorization()

    await waitFor(() =>
      expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
        'data-notice-kind',
        'success'
      )
    )
  })

  test('does not request authorization when the required connector is already connected', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ marketplaceConnectorSlug: 'github' })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    vi.mocked(listWegentConnectorApps).mockResolvedValue([
      {
        id: 1,
        slug: 'github',
        name: 'GitHub',
        description: 'Connect GitHub',
        icon_url: 'https://example.com/github.png',
        auth_type: 'oauth2',
        connection: {
          status: 'connected',
          external_account_name: 'octocat',
          granted_scopes: [],
          expires_at: null,
        },
      },
    ])

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))
    // Dialog opens immediately with sync connector labels, then drops already-connected
    // connectors once connector-apps / health resolve.
    const confirmInstall = await screen.findByTestId('install-plugin-dialog-confirm')
    await waitFor(() => {
      expect(confirmInstall).toHaveTextContent('安装插件')
      expect(screen.getByTestId('install-plugin-dialog')).not.toHaveTextContent('需要连接 GitHub')
    })
    await userEvent.click(confirmInstall)

    await waitFor(() =>
      expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
    )
    expect(authorizeWegentConnector).not.toHaveBeenCalled()
  })

  test('does not authorize Wegent OAuth when managing an OpenAI GitHub connector', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    seedDurableOpenAiGithubPeek({ includeGithubConnector: true, includeGmailInstall: true })
    mockCodexAppServerInvoke({ deviceId: 'local-device' })
    mockEmptyCloudPluginApis()
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/read' || request.method === 'plugin/list') {
          return new Promise(() => undefined)
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })
    vi.mocked(listWegentConnectorApps).mockResolvedValue([
      {
        id: 1,
        slug: 'github',
        name: 'GitHub',
        description: 'Connect GitHub',
        icon_url: 'https://example.com/github.png',
        auth_type: 'oauth2',
        connection: {
          status: 'disconnected',
          external_account_name: null,
          granted_scopes: [],
          expires_at: null,
        },
      },
    ])

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-github@openai-curated-remote')
    )
    await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:github'))

    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      '此插件通过对话授权 GitHub，请在聊天中按提示完成登录。'
    )
    expect(authorizeWegentConnector).not.toHaveBeenCalled()
    expect(listWegentConnectorApps).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-gmail@openai-curated-remote')
    )
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-github@openai-curated-remote'))
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      '此插件通过对话授权 GitHub，请在聊天中按提示完成登录。'
    )
  })

  test('authorizes Wegent OAuth when managing a cloud plugin GitHub connector', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceConnectorSlug: 'github',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    vi.mocked(listWegentConnectorApps).mockResolvedValue([
      {
        id: 1,
        slug: 'github',
        name: 'GitHub',
        description: 'Connect GitHub',
        icon_url: 'https://example.com/github.png',
        auth_type: 'oauth2',
        connection: {
          status: 'disconnected',
          external_account_name: null,
          granted_scopes: [],
          expires_at: null,
        },
      },
    ])

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:github'))

    await waitFor(() => {
      expect(authorizeWegentConnector).toHaveBeenCalledWith(
        '/api',
        'cloud-token',
        'github',
        expect.any(Function)
      )
    })
  })

  test('does not report an account install as installed when this device failed', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'failed',
      deviceAutoSyncSucceeds: false,
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace />)

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('重试安装')
    )
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))

    expect(screen.getByText('0/1 已安装 · 1 失败')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('重试安装')
    expect(screen.getByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Codex App Server rejected install'
    )
    expect(screen.getByTestId('plugin-detail-actions-101')).toBeInTheDocument()
    expectFetchRequest('/api/plugins/marketplace?device_id=current-device')
  })

  test('auto-syncs account installs onto the current device once per session', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'failed',
      deviceAutoSyncSucceeds: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    const firstRender = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/sync-device?device_id=current-device',
      expect.objectContaining({ method: 'POST' })
    )
    await waitFor(() => {
      expect(screen.queryByText('重试安装')).not.toBeInTheDocument()
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    })
    firstRender.unmount()

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    expect(await screen.findByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(1)
  })

  test('waits for the live socket connection before auto-syncing account installs', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: false })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('重试安装')
    )
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    act(() => {
      setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: true })
    })

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    )
  })

  test('stops showing syncing when the socket disconnects during auto-sync', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let releaseDeviceSync: (() => void) | null = null
    const deviceAutoSyncGate = new Promise<void>(resolve => {
      releaseDeviceSync = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: false,
      deviceAutoSyncGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('同步中')

    act(() => {
      setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: false })
    })

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('重试安装')
    )

    act(() => releaseDeviceSync?.())
  })

  test('does not auto-sync an account install before same-device local state resolves', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'failed',
      deviceAutoSyncSucceeds: false,
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
    })
    const localMarketplace = {
      name: 'wegent',
      path: '/Users/test/.wework/capabilities/store/plugins',
      plugins: [defaultCodexPlugin],
    }
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [localMarketplace],
      installedPluginNames: ['documents'],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    resolveLocalList?.({
      marketplaces: [
        codexMarketplaceResponse(
          localMarketplace,
          new Set(['documents']),
          false,
          new Map([['101', true]])
        ),
      ],
    })

    await waitFor(() => {
      expect(screen.getByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    })
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))
  })

  test('does not auto-sync pending wegent cards when live plugin/installed omitted local packages', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      deviceAutoSyncSucceeds: false,
    })
    const localMarketplace = {
      name: 'wegent',
      path: '/Users/test/.wework/capabilities/store/plugins',
      plugins: [defaultCodexPlugin],
    }
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [localMarketplace],
      installedPluginNames: ['documents'],
    })
    await createLocalCodexPluginApi().readState({
      mergeAllMarketplaces: true,
      refresh: true,
    })

    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/installed') {
          return Promise.resolve({
            marketplaces: [
              {
                name: 'openai-curated-remote',
                path: 'openai-curated-remote',
                interface: { displayName: 'OpenAI' },
                plugins: [],
              },
            ],
          })
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    })
    expect(screen.queryByText('同步中')).not.toBeInTheDocument()
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))
  })

  test('does not auto-sync before live plugin/installed membership returns', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    let resolveInstalled: ((value: unknown) => void) | null = null
    const pendingInstalled = new Promise(resolve => {
      resolveInstalled = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/installed') {
          return pendingInstalled
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    resolveInstalled?.({
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/capabilities/store/plugins',
          interface: { displayName: 'wegent' },
          plugins: [],
        },
      ],
    })

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(marketplaceMock.getReportDeviceCalls()).toBe(0)
  })

  test('does not auto-sync a pending cloud row when live plugin/installed already has the package', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      deviceAutoSyncSucceeds: false,
      localVersionEvidence: '1.0.0',
    })
    const localMarketplace = {
      name: 'wegent',
      path: '/Users/test/.wework/capabilities/store/plugins',
      plugins: [defaultCodexPlugin],
    }
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [localMarketplace],
      installedPluginNames: ['documents'],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    })
    expect(screen.queryByText('同步中')).not.toBeInTheDocument()
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))

    resolveLocalList?.({
      marketplaces: [
        codexMarketplaceResponse(
          localMarketplace,
          new Set(['documents']),
          false,
          new Map([['101', true]])
        ),
      ],
    })

    await waitFor(() => {
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    })
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
    expect(marketplaceMock.getReportDeviceCalls()).toBe(1)
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
    expect(screen.getByTestId('plugin-detail-toggle-101')).not.toHaveTextContent('安装插件')
  })

  test('retries a failed device status report before acknowledging the local package', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      reportDeviceFailures: 1,
      localVersionEvidence: '1.0.0',
    })
    const localMarketplace = {
      name: 'wegent',
      path: '/Users/test/.wework/capabilities/store/plugins',
      plugins: [defaultCodexPlugin],
    }
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [localMarketplace],
      installedPluginNames: ['documents'],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    })
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(2), {
      timeout: 3000,
    })
    resolveLocalList?.({
      marketplaces: [
        codexMarketplaceResponse(
          localMarketplace,
          new Set(['documents']),
          false,
          new Map([['101', true]])
        ),
      ],
    })
    await waitFor(() => {
      expect(screen.getByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
    })
  })

  test('offers try-in-chat when the wegent store directory is already on this device', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      marketplaceName: 'wegent-sites',
      marketplaceDisplayName: '快速建站',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
          plugins: [
            {
              id: '267250-wegent-wegent-sites-0.1.6',
              name: '267250-wegent-wegent-sites-0.1.6',
              displayName: '快速建站',
            },
          ],
        },
      ],
      installedPluginNames: ['267250-wegent-wegent-sites-0.1.6'],
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('快速建站')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
    expect(screen.getByTestId('plugin-detail-toggle-101')).not.toHaveTextContent('安装插件')
  })

  test('offers try-in-chat from a manifest-backed package when Codex membership omitted it', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      marketplaceName: 'wegent-sites',
      marketplaceDisplayName: '快速建站',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
          plugins: [
            {
              id: '101-wegent-wegent-sites-1.0.0',
              name: '101-wegent-wegent-sites-1.0.0',
              displayName: '快速建站',
            },
          ],
        },
      ],
      installedPluginNames: [],
      wegentStorePlugins: [
        {
          name: 'wegent-sites',
          packageId: '101-wegent-wegent-sites-1.0.0',
          marketplace: 'wegent',
          version: '1.0.0',
          enabled: true,
          displayName: '快速建站',
          pluginPath:
            '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins/101-wegent-wegent-sites-1.0.0',
        },
      ],
    })

    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return new Promise(() => undefined)
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('快速建站')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await waitFor(() => {
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
    })
    expect(screen.getByTestId('plugin-detail-toggle-101')).not.toHaveTextContent('同步中')
    expect(screen.getByTestId('plugin-detail-toggle-101')).not.toHaveTextContent('安装插件')
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
  })

  test('reports local packages even when the executor socket is disconnected', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: false })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      deviceAutoSyncSucceeds: false,
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/capabilities/store/plugins',
          plugins: [defaultCodexPlugin],
        },
      ],
      installedPluginNames: ['documents'],
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
    expect(screen.getByTestId('plugin-detail-toggle-101')).not.toHaveTextContent('安装插件')
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    expect(
      screen.queryByText('当前设备未连接到云端，暂时无法安装插件。请恢复连接后重试。')
    ).not.toBeInTheDocument()
  })

  test('queues plugin trial from detail without calling plugin/list', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/capabilities/store/plugins',
          plugins: [defaultCodexPlugin],
        },
      ],
      installedPluginNames: ['documents'],
    })

    let pluginListCalls = 0
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          pluginListCalls += 1
          return new Promise(() => undefined)
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    const listCallsBeforeTry = pluginListCalls
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))

    await waitFor(() => {
      const raw = window.sessionStorage.getItem('wework:pending-plugin-trial')
      expect(raw).toBeTruthy()
      expect(raw).toContain('plugin://documents@')
    })
    expect(pluginListCalls).toBe(listCallsBeforeTry)
  })

  test('tries an OpenAI official plugin from detail while plugin/read is hung', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    seedDurableOpenAiGithubPeek()
    const githubCatalog = officialCodexPluginSummary({
      id: 'github@openai-curated-remote',
      name: 'github',
      displayName: 'GitHub',
      installed: true,
    })
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command !== 'codex.app_server_request') return Promise.resolve(undefined)
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (request.method === 'plugin/read' || request.method === 'plugin/list') {
        return new Promise(() => undefined)
      }
      if (request.method === 'plugin/installed') {
        return Promise.resolve({
          marketplaces: [
            {
              name: 'openai-curated-remote',
              path: 'openai-curated-remote',
              interface: { displayName: 'OpenAI' },
              plugins: [githubCatalog],
            },
          ],
        })
      }
      return Promise.resolve(undefined)
    })
    mockEmptyCloudPluginApis()
    window.history.pushState({}, '', '/plugins')

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-github@openai-curated-remote')
    )
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-github@openai-curated-remote'))

    expect(window.location.pathname).toBe('/')
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toEqual(
      expect.objectContaining({
        input: expect.stringContaining('plugin://github@openai-curated-remote'),
        pluginName: 'GitHub',
        openInNewChat: true,
      })
    )
  })

  test('does not start plugin/list until device package sync finishes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let releaseSyncGate: (() => void) | null = null
    const deviceAutoSyncGate = new Promise<void>(resolve => {
      releaseSyncGate = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: true,
      deviceAutoSyncGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    let resolveInstalled: ((value: unknown) => void) | null = null
    const pendingInstalled = new Promise(resolve => {
      resolveInstalled = resolve
    })
    let pluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/installed') {
          return pendingInstalled
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)

    resolveInstalled?.({
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/capabilities/store/plugins',
          interface: { displayName: 'wegent' },
          plugins: [],
        },
      ],
    })

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(pluginListStarted).toBe(false)

    releaseSyncGate?.()
    await waitFor(() => expect(pluginListStarted).toBe(true))
  })

  test('auto-syncs a confirmed gap before plugin/list starts', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let releaseSyncGate: (() => void) | null = null
    const deviceAutoSyncGate = new Promise<void>(resolve => {
      releaseSyncGate = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: true,
      deviceAutoSyncGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    let pluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
          return new Promise(() => undefined)
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(pluginListStarted).toBe(false)
    releaseSyncGate?.()
    await waitFor(() => expect(pluginListStarted).toBe(true))
  })

  test('does not start plugin/list from a warm cache before live cloud pending can sync', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let releaseSyncGate: (() => void) | null = null
    const deviceAutoSyncGate = new Promise<void>(resolve => {
      releaseSyncGate = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      deviceAutoSyncSucceeds: true,
      deviceAutoSyncGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    const cachedMarketplace = (await (
      await fetch('/api/plugins/marketplace?device_id=current-device')
    ).json()) as { items: PluginMarketplaceItem[] }
    setPluginMarketplaceCache({
      cacheKey: '/api|cloud-token',
      marketplaceItems: cachedMarketplace.items.map(item => ({
        ...item,
        installed: true,
        installedPluginId: 101,
        currentDeviceInstallation: item.currentDeviceInstallation
          ? {
              ...item.currentDeviceInstallation,
              state: 'installed',
              actualReleaseId: item.currentDeviceInstallation.desiredReleaseId,
              errorCode: null,
              errorMessage: null,
            }
          : {
              deviceId: 'current-device',
              desiredReleaseId: 1001,
              actualReleaseId: 1001,
              state: 'installed',
              errorCode: null,
              errorMessage: null,
              attemptCount: 1,
              lastSyncAt: null,
              updatedAt: '2026-07-25T12:00:00',
            },
      })),
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'current-device',
      fetchedAt: Date.now(),
    })

    let releaseMarketplace: (() => void) | null = null
    const marketplaceGate = new Promise<void>(resolve => {
      releaseMarketplace = resolve
    })
    let pluginListStarted = false
    const previousFetch = vi.mocked(fetch)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const requestUrl = new URL(url, 'http://localhost')
        if (requestUrl.pathname === '/api/plugins/marketplace') {
          return marketplaceGate.then(() => previousFetch(url, init))
        }
        return previousFetch(url, init)
      })
    )
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
          return new Promise(() => undefined)
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    releaseMarketplace?.()
    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(pluginListStarted).toBe(false)

    releaseSyncGate?.()
    await waitFor(() => expect(pluginListStarted).toBe(true))
  })

  test('does not start plugin/list from an unscoped catalog that looks installed before device pending can sync', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let releaseSyncGate: (() => void) | null = null
    const deviceAutoSyncGate = new Promise<void>(resolve => {
      releaseSyncGate = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      deviceAutoSyncSucceeds: true,
      deviceAutoSyncGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    let pluginListStarted = false
    const previousFetch = vi.mocked(fetch)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const requestUrl = new URL(url, 'http://localhost')
        if (
          requestUrl.pathname === '/api/plugins/marketplace' &&
          !requestUrl.searchParams.get('device_id')
        ) {
          return previousFetch(url, init).then(async response => {
            const payload = (await response.json()) as { items: PluginMarketplaceItem[] }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                items: payload.items.map(item => ({
                  ...item,
                  installed: true,
                  enabled: true,
                  currentDeviceInstallation: null,
                })),
              }),
            }
          })
        }
        return previousFetch(url, init)
      })
    )
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
          return new Promise(() => undefined)
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)
    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    expect(pluginListStarted).toBe(false)

    releaseSyncGate?.()
    await waitFor(() => expect(pluginListStarted).toBe(true))
  })

  test('starts plugin/list after live inventory when no device package gap exists', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    let resolveInstalled: ((value: unknown) => void) | null = null
    const pendingInstalled = new Promise(resolve => {
      resolveInstalled = resolve
    })
    let pluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/installed') {
          return pendingInstalled
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    resolveInstalled?.({
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/capabilities/store/plugins',
          interface: { displayName: 'wegent' },
          plugins: [],
        },
      ],
    })

    await waitFor(() => expect(pluginListStarted).toBe(true))
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
  })

  test('does not start plugin/list from a warm OpenAI catalog until the user refreshes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'local-device' })
    seedDurableOpenAiGithubPeek()

    let resolveInstalled: ((value: unknown) => void) | null = null
    const pendingInstalled = new Promise(resolve => {
      resolveInstalled = resolve
    })
    let pluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/installed') {
          return pendingInstalled
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)

    resolveInstalled?.({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          interface: { displayName: 'OpenAI' },
          plugins: [],
        },
      ],
    })

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(
      await screen.findByTestId('plugin-marketplace-row-github@openai-curated-remote')
    ).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    await userEvent.click(screen.getByTestId('plugins-refresh-button'))
    await waitFor(() => expect(pluginListStarted).toBe(true))
  })

  test('does not start plugin/list until personal-created disk listing finishes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    let resolvePersonalDisk: ((value: unknown) => void) | null = null
    const pendingPersonalDisk = new Promise(resolve => {
      resolvePersonalDisk = resolve
    })
    let pluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'executor.plugins.personal.list') {
        return pendingPersonalDisk
      }
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(pluginListStarted).toBe(false)
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    resolvePersonalDisk?.({
      marketplaceId: 'wework-personal',
      marketplacePath: '/tmp/wework-personal',
      plugins: [],
    })

    await waitFor(() => expect(pluginListStarted).toBe(true))
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
  })

  test('restores same-device local installs from the durable snapshot on restart', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'failed',
      deviceAutoSyncSucceeds: false,
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wegent',
          path: '/Users/test/.wework/capabilities/store/plugins',
          plugins: [defaultCodexPlugin],
        },
      ],
      installedPluginNames: ['documents'],
    })
    await createLocalCodexPluginApi().readState({
      mergeAllMarketplaces: true,
      refresh: true,
    })
    const cachedMarketplace = (await (
      await fetch('/api/plugins/marketplace?device_id=current-device')
    ).json()) as { items: PluginMarketplaceItem[] }
    setPluginMarketplaceCache({
      cacheKey: '/api|cloud-token',
      marketplaceItems: cachedMarketplace.items.map(item => ({
        ...item,
        installed: true,
        installedPluginId: 101,
      })),
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'current-device',
      fetchedAt: Date.now(),
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
    expect(await screen.findByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-workspace'))
    expect(screen.getByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    expect(screen.queryByText('重试安装')).not.toBeInTheDocument()
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
  })

  test('offers retry when pending gaps remain after auto-sync settles', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: false,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('重试安装')
    )
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('重试安装')
    expect(screen.getByTestId('plugin-detail-toggle-101')).not.toBeDisabled()
  })

  test('clears search and distribution from the empty marketplace state', async () => {
    mockSystemSkillsFetch()
    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-workspace'))
    await userEvent.type(await screen.findByTestId('plugins-search-input'), 'missing')

    expect(await screen.findByText('没有匹配的插件')).toBeInTheDocument()
    expect(screen.getByText('可以清除搜索和分类后重新浏览。')).toBeInTheDocument()
    const clearFilters = screen.getByTestId('plugins-clear-marketplace-filters')
    expect(clearFilters).toHaveClass('bg-surface', 'text-text-primary')
    expect(clearFilters).not.toHaveClass('bg-text-primary')
    await userEvent.click(clearFilters)

    expect(screen.getByTestId('plugins-search-input')).toHaveValue('')
    expect(screen.getByTestId('plugins-distribution-tab-all')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByText('Documents')).toBeInTheDocument()
  })

  test('opens installed marketplace plugin actions and uninstalls from the row menu', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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

    expect(await screen.findByTestId('plugin-marketplace-install-101')).toBeInTheDocument()
    await installPluginFromMarketCard('plugin-marketplace-install-101')

    expect(await screen.findByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-marketplace-actions-101'))

    expect(screen.getByTestId('plugin-marketplace-actions-menu-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-marketplace-try-101')).toHaveTextContent('立即对话')
    expect(screen.getByTestId('plugin-marketplace-manage-101')).toHaveTextContent('管理')
    expect(screen.getByTestId('plugin-marketplace-uninstall-101')).toHaveTextContent('卸载')

    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('plugin-marketplace-actions-menu-101')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-marketplace-actions-101'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101?device_id=current-device',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
    expect(screen.queryByTestId('plugin-marketplace-actions-101')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(telemetryMocks.track).toHaveBeenCalledWith('plugin_uninstalled', { source: 'local' })
    )
  })

  test('keeps local uninstall settled when cloud-link cleanup fails', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: 'documents-local-id',
              name: 'documents',
              displayName: 'Documents',
              description: 'Create and edit document artifacts',
            },
          ],
        },
      ],
      installedPluginNames: ['documents'],
      cloudLinks: [
        {
          localPluginName: 'documents',
          cloudPluginId: 101,
          cloudReleaseId: 1001,
        },
      ],
      unlinkError: new Error('Cloud link registry is read-only'),
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expectCodexAppServerRequest('plugin/list', { cwds: null }))
    await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
    await userEvent.click(await screen.findByTestId('plugin-marketplace-actions-101'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/installed/101?device_id=current-device',
        expect.objectContaining({ method: 'DELETE' })
      )
    )
    // Bare ids like documents-local-id look like Codex remote plugin ids and must
    // not be probed for local/personal uninstalls.
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.plugin.uninstall_local', {
      marketplacePath:
        '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal/.agents/plugins/marketplace.json',
      pluginName: 'documents',
    })
    expectCodexAppServerRequestNotCalled('plugin/uninstall')
    expect(requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.links.unlink', {
      marketplacePath: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
      localPluginName: 'documents',
    })
    expect(await screen.findByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
    expect(
      await screen.findByText(
        /Documents 已从本机卸载，但部分清理失败.*Cloud link registry is read-only/
      )
    ).toBeInTheDocument()
  })

  test('uninstalls a local Codex plugin even when cloud installs own the installed list', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: 'superpowers-local-id',
              name: 'superpowers',
              displayName: 'Superpowers',
              description: 'Planning, TDD, debugging, and delivery workflows',
              category: 'Productivity',
            },
          ],
        },
      ],
      installedPluginNames: ['superpowers'],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Superpowers')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-actions-superpowers-local-id'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-superpowers-local-id'))
    expect(screen.getByTestId('plugin-uninstall-confirm-button')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    expectCodexAppServerRequest('plugin/uninstall', { pluginId: 'superpowers-local-id' })
    expect(
      await screen.findByTestId('plugin-marketplace-install-superpowers-local-id')
    ).toHaveTextContent('安装')
    expect(
      screen.queryByTestId('plugin-marketplace-actions-superpowers-local-id')
    ).not.toBeInTheDocument()
  })

  test('shows why a remote OpenAI plugin failed to uninstall', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'openai-curated-remote',
          displayName: 'OpenAI',
          path: 'openai-curated-remote',
          plugins: [
            {
              id: 'github@openai-curated-remote',
              remotePluginId: 'plugin_connector_1p_github',
              name: 'github',
              displayName: 'GitHub',
              description: 'Connect GitHub',
            },
          ],
        },
      ],
      installedPluginNames: ['github'],
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      const request = args as {
        method?: string
        params?: { method?: string }
      }
      if (command === 'codex.app_server_request' && request.method === 'plugin/uninstall') {
        return Promise.reject(
          new Error('chatgpt authentication required for remote plugin catalog')
        )
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })
    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-actions-github@openai-curated-remote')
    )
    await userEvent.click(
      screen.getByTestId('plugin-marketplace-uninstall-github@openai-curated-remote')
    )
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    const notice = await screen.findByTestId('plugin-operation-notice')
    expect(notice).toHaveAttribute('data-notice-kind', 'error')
    expect(notice).toHaveTextContent('卸载该远程插件需要先登录 ChatGPT / Codex 账号。')
    expect(
      screen.getByTestId('plugin-marketplace-actions-github@openai-curated-remote')
    ).toBeInTheDocument()
  })

  test('tries an installed cloud Codex plugin from the row menu', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    sessionStorage.clear()
    window.history.pushState({}, '', '/plugins')

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-actions-101'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-try-101'))

    expect(window.location.pathname).toBe('/')
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input: '[$Documents](plugin://documents@wework) Draft a document outline from this chat',
        pluginName: 'Documents',
        openInNewChat: true,
      }
    )
  })

  test('adds an installed plugin example to a new chat from the detail page', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    sessionStorage.clear()
    window.history.pushState({}, '', '/plugins')

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
    await userEvent.click(screen.getByTestId('plugin-prompt-0'))

    expect(window.location.pathname).toBe('/')
    expect(screen.queryByText('Codex plugin is not installed')).not.toBeInTheDocument()
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input: '[$Documents](plugin://documents@wework) Draft a document outline from this chat',
        pluginName: 'Documents',
        openInNewChat: true,
      }
    )
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'codex.app_server_request',
      expect.objectContaining({
        params: expect.objectContaining({ method: 'plugin/read' }),
      })
    )
  })

  test('does not reload the marketplace when a plugin component is toggled', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceHasSkill: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
    const toggle = await screen.findByTestId('plugin-component-toggle-skill:documents')
    const marketplaceRequestsBefore = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes('/api/plugins/marketplace')).length

    await userEvent.click(toggle)
    await waitFor(() =>
      expect(telemetryMocks.track).toHaveBeenCalledWith('operation_failed', {
        operation: 'plugin_toggle',
      })
    )

    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes('/api/plugins/marketplace'))
    ).toHaveLength(marketplaceRequestsBefore)
  })

  test('does not merge a local plugin into a cloud item by display name', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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

    expect(await screen.findByTestId('plugin-marketplace-install-101')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('Documents').length).toBeGreaterThan(1))
    await installPluginFromMarketCard('plugin-marketplace-install-101')

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace/101/install?device_id=current-device',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'codex.app_server_request',
      expect.objectContaining({
        params: expect.objectContaining({ method: 'plugin/read' }),
      })
    )
  })

  test('loads local marketplace plugin components on the detail page', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-primary-runtime',
          displayName: 'openai-primary-runtime',
          path: 'openai-primary-runtime',
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))

    await waitFor(() =>
      expectCodexAppServerRequest('plugin/read', {
        pluginName: 'documents',
      })
    )
    expect(await screen.findByRole('heading', { name: /包含能力/ })).toBeInTheDocument()
    expect(screen.getByText('Documents App')).toBeInTheDocument()
  })

  test('shows OpenAI official plugin skills and apps from plugin/read without plugin/list', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    seedDurableOpenAiGithubPeek()
    mockCodexAppServerInvoke({ deviceId: 'local-device' })
    mockEmptyCloudPluginApis()
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string; params?: Record<string, unknown> }
        }
        if (request.method === 'plugin/list') {
          throw new Error('plugin/list must not run for OpenAI plugin detail')
        }
        if (request.method === 'plugin/read') {
          return Promise.resolve({
            plugin: {
              marketplaceName: 'openai-curated-remote',
              summary: {
                id: 'github@openai-curated-remote',
                name: 'github',
                installed: true,
                enabled: true,
                interface: {
                  displayName: 'GitHub',
                  homepageUrl: 'https://github.com/',
                },
              },
              description: 'Triage PRs, issues, CI, and publish flows.',
              skills: [
                {
                  name: 'Review Follow-up',
                  description: 'Address actionable PR feedback.',
                  enabled: true,
                },
                {
                  name: 'CI Debug',
                  description: 'Debug failing GitHub Actions checks.',
                  enabled: true,
                },
              ],
              apps: [
                {
                  id: 'github',
                  name: 'GitHub',
                  description: 'Access repositories, issues, and pull requests.',
                },
                {
                  id: 'github-enterprise',
                  name: 'GitHub Enterprise',
                  description: 'Workspace-specific GitHub connector for a GitHub Enterprise host.',
                },
              ],
              hooks: [],
              connectors: [],
            },
          })
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-github@openai-curated-remote')
    )

    expect(await screen.findByRole('heading', { name: /包含能力/ })).toBeInTheDocument()
    expect(screen.getByText('Review Follow-up')).toBeInTheDocument()
    expect(screen.getByText('CI Debug')).toBeInTheDocument()
    expect(screen.getByText('GitHub Enterprise')).toBeInTheDocument()
    expect(screen.getByText('Access repositories, issues, and pull requests.')).toBeInTheDocument()
  })

  test('keeps fallback plugin logos contained on the detail page', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'personal',
          displayName: 'Personal',
          path: '/Users/test/.codex/plugins/marketplaces/personal',
          plugins: [
            {
              ...defaultCodexPlugin,
              id: 'code-review',
              name: 'code-review',
              displayName: 'Code Review',
              logo: '',
              defaultPrompt: [
                'Review my current working-tree changes.',
                'Compare this branch with its merge base.',
                'Inspect the latest commit for high-risk issues.',
              ],
            },
          ],
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByText('Code Review')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-official'))
    expect(screen.queryByText('Code Review')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-personal'))
    await userEvent.click((await screen.findAllByTestId(/^plugin-marketplace-row-/))[0])

    expect(screen.getByTestId('plugin-detail-logo')).toHaveClass('plugin-logo-fallback')
    expect(screen.getByRole('heading', { name: '试试这些任务' })).toBeInTheDocument()
    expect(screen.getAllByTestId(/^plugin-prompt-/)).toHaveLength(3)
    expect(screen.getByTestId('plugin-prompt-1')).toHaveTextContent(
      'Code Review Compare this branch with its merge base.'
    )
    expect(screen.getByTestId('plugin-prompt-1')).toHaveAttribute(
      'data-plugin-distribution',
      'personal'
    )
    const actionsBar = screen.getByTestId('plugin-detail-actions-bar')
    const actionMenu = screen.getByTestId('plugin-detail-actions-code-review')
    const installAction = screen.getByTestId('plugin-detail-toggle-code-review')
    expect(Array.from(actionsBar.children).indexOf(actionMenu.parentElement!)).toBeLessThan(
      Array.from(actionsBar.children).indexOf(installAction)
    )
    await userEvent.click(actionMenu)
    await userEvent.click(screen.getByTestId('plugin-detail-delete-code-review'))
    expect(screen.getByTestId('delete-personal-plugin-dialog')).toHaveTextContent(
      '将永久删除「Code Review」的本地插件源码'
    )
    await userEvent.click(screen.getByTestId('plugin-delete-confirm-button'))
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.personal.delete', {
        marketplacePath: '/Users/test/.codex/plugins/marketplaces/personal',
        pluginName: 'code-review',
      })
    )
  })

  test('opens marketplace plugin detail from the plugin row', async () => {
    render(<PluginsWorkspace />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))

    expect(screen.getByTestId('plugin-detail-back-button')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装插件' })).toBeInTheDocument()
    expect(screen.getByText('Create and edit documents')).toBeInTheDocument()
    expect(screen.getByText(/Draft a document outline from this chat/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /包含能力/ })).toBeInTheDocument()
    expect(screen.getByText('Documents App')).toBeInTheDocument()
    expect(screen.getByText('documents-app')).toBeInTheDocument()
    expect(screen.getByText('OpenAI官方')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI官方 · Codex 官方')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '试试这些任务' })).toBeInTheDocument()

    const promptCard = screen.getByTestId('plugin-prompt-0')
    expect(promptCard).toHaveTextContent('Documents Draft a document outline from this chat')
    expect(promptCard).not.toHaveTextContent('安装并试用')
  })

  test('opens cloud marketplace plugin detail from a plugin route', async () => {
    render(
      <PluginsWorkspace pluginReference={{ pluginName: 'documents', marketplaceName: 'wegent' }} />
    )

    expect(await screen.findByTestId('plugin-detail-back-button')).toBeInTheDocument()
    expect(screen.getByText('Create and edit documents')).toBeInTheDocument()
  })

  test('paints plugin detail from a route on the first frame when the catalog is warm', () => {
    setPluginMarketplaceCache({
      cacheKey: '|anon',
      marketplaceItems: [
        {
          id: 101,
          remotePluginId: 'openai-documents',
          name: 'documents',
          displayName: 'Documents',
          description: 'Create and edit document artifacts',
          visibility: 'public',
          featured: false,
          installed: true,
          installedPluginId: 101,
          enabled: true,
          sourceType: 'marketplace',
          sourceProvider: 'wegent',
          sourceLabel: 'Wegent 官方',
          components: emptyPluginComponents,
          manifest: {},
          ownerUserId: 0,
          latestReleaseId: 1001,
          interface: {
            displayName: 'Documents',
            shortDescription: 'Create and edit documents',
          },
        },
      ],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })

    render(
      <PluginsWorkspace pluginReference={{ pluginName: 'documents', marketplaceName: 'wegent' }} />
    )

    expect(screen.getByTestId('plugin-detail-back-button')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-workspace')).not.toBeInTheDocument()
  })

  test('returns from a plugin route on the first back without reopening detail', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined)
    try {
      setPluginMarketplaceCache({
        cacheKey: '|anon',
        marketplaceItems: [
          {
            id: 101,
            remotePluginId: 'openai-documents',
            name: 'documents',
            displayName: 'Documents',
            description: 'Create and edit document artifacts',
            visibility: 'public',
            featured: false,
            installed: true,
            installedPluginId: 101,
            enabled: true,
            sourceType: 'marketplace',
            sourceProvider: 'wegent',
            sourceLabel: 'Wegent 官方',
            components: emptyPluginComponents,
            manifest: {},
            ownerUserId: 0,
            latestReleaseId: 1001,
            interface: {
              displayName: 'Documents',
              shortDescription: 'Create and edit documents',
            },
          },
        ],
        installedPlugins: [],
        marketplaces: [
          {
            key: 'cloud:default',
            id: 'default',
            name: 'Wework 云端市场',
            kind: 'cloud',
          },
        ],
        selectedMarketplaceKey: 'cloud:default',
        deviceId: 'local-device',
        fetchedAt: Date.now(),
      })

      render(
        <PluginsWorkspace
          pluginReference={{ pluginName: 'documents', marketplaceName: 'wegent' }}
        />
      )

      expect(screen.getByTestId('plugin-detail-back-button')).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('plugin-detail-back-button'))

      expect(historyBack).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('plugin-detail-back-button')).not.toBeInTheDocument()
      expect(screen.getByTestId('plugins-workspace')).toBeInTheDocument()
    } finally {
      historyBack.mockRestore()
    }
  })

  test('keeps the resolved marketplace logo on installed plugin details', async () => {
    const marketplaceLogo = 'data:image/svg+xml;base64,PHN2Zy8+'
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    expect(screen.getByTestId('plugin-detail-logo')).toHaveClass('plugin-logo-provided')
    expect(screen.getByRole('heading', { name: '试试这些任务' })).toBeInTheDocument()
    expect(document.querySelector('img[src="./assets/github-small.svg"]')).toBeNull()
  })

  test('automatically installs from a detail example and restores it in a new chat', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-prompt-0'))
    expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')
      ).toMatchObject({
        input: expect.stringContaining('Draft a document outline from this chat'),
        pluginName: 'Documents',
        openInNewChat: true,
      })
    )
    expect(window.location.pathname).toBe('/')
  })

  test('shows marketplace installation errors on the plugin detail page', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))

    const notice = await screen.findByTestId('plugin-operation-notice')
    expect(notice).toHaveTextContent('GitHub OAuth is not configured')
    expect(notice).toHaveAttribute('data-notice-kind', 'error')
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('安装插件')
  })

  test('shows share for personal owners before local created install hydrates', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'openai-official',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: '101',
              name: 'dev-tools',
              displayName: 'Dev Tools',
              description: 'Owner market install only',
            },
          ],
        },
      ],
      installedPluginNames: ['dev-tools'],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    expect(await screen.findByTestId('plugin-detail-share-101')).toHaveTextContent('分享')
    expect(await screen.findByTestId('plugin-detail-manage-access')).toHaveTextContent('管理权限')
    await userEvent.click(screen.getByTestId('plugin-detail-actions-101'))
    expect(screen.getByTestId('plugin-detail-edit-101')).toHaveTextContent('继续编辑')
    expect(screen.queryByTestId('plugin-detail-menu-publish-101')).not.toBeInTheDocument()
  })

  test('waits for existing personal access before opening share and preserves its targets', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let resolvePluginAccess!: () => void
    const pluginAccessGate = new Promise<void>(resolve => {
      resolvePluginAccess = resolve
    })
    let resolvePublicationRequests!: () => void
    const publicationRequestGate = new Promise<void>(resolve => {
      resolvePublicationRequests = resolve
    })
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
      pluginAccessGate,
      publicationRequestGate,
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      installedPluginNames: ['dev-tools'],
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: 'dev-tools-local',
              name: 'dev-tools',
              displayName: 'Dev Tools',
              description: 'Developer tools',
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId(/^plugin-detail-share-/))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace/101/access',
        expect.objectContaining({ method: 'GET' })
      )
    )
    expect(screen.queryByTestId('plugin-share-intent-dialog')).not.toBeInTheDocument()

    resolvePluginAccess()
    await act(async () => Promise.resolve())
    expect(screen.queryByTestId('plugin-share-intent-dialog')).not.toBeInTheDocument()

    resolvePublicationRequests()
    expect(await screen.findByTestId('plugin-share-intent-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-share-intent-restricted')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await userEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    expect(screen.getByTestId('plugin-share-targets')).toHaveTextContent('Alice')
    await userEvent.click(screen.getByTestId('plugin-share-save-scope'))

    await waitFor(() => {
      const updateCall = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        return String(input) === '/api/plugins/marketplace/101/access' && init?.method === 'PUT'
      })
      expect(updateCall).toBeDefined()
      expect(JSON.parse(String(updateCall?.[1]?.body))).toMatchObject({
        targets: [{ entityType: 'user', entityId: '7', displayName: 'Alice' }],
      })
    })
  })

  test('restores every request and keeps an earlier published enterprise version reachable', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const published = buildPublicationRequest()
    const withdrawnRevision = {
      ...published.revision,
      id: 902,
      number: 1,
      requestedVersion: '2.0.0',
      snapshotSha256: 'b'.repeat(64),
      status: 'withdrawn' as const,
      createdAt: '2026-08-29T08:00:00Z',
    }
    const withdrawn = buildPublicationRequest({
      id: 83,
      enterprisePluginId: null,
      requestedVersion: '2.0.0',
      status: 'withdrawn',
      updatedAt: '2026-08-29T09:00:00Z',
      revision: withdrawnRevision,
      revisions: [withdrawnRevision],
      actionEligibility: {
        canWithdraw: false,
        canCreateRevision: false,
        canViewEnterprisePlugin: false,
        canReturn: false,
        canAccept: false,
        canReconcile: false,
        blockedReasons: [],
      },
    })
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
      publicationRequests: [withdrawn, published],
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      installedPluginNames: ['dev-tools'],
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: 'dev-tools-local',
              name: 'dev-tools',
              displayName: 'Dev Tools',
              description: 'Developer tools',
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(await screen.findByTestId('plugin-publication-card-82')).toHaveTextContent('v1.0.0')
    await userEvent.click(screen.getByTestId('plugin-publication-view-history-82'))

    expect(await screen.findByTestId('plugin-publication-request-history')).toHaveTextContent(
      '#82 · v1.0.0'
    )
    expect(screen.getByTestId('plugin-publication-request-history')).toHaveTextContent(
      '#83 · v2.0.0'
    )
  })

  test('keeps enterprise publication available without a server capability gate', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      installedPluginNames: ['dev-tools'],
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: 'dev-tools-local',
              name: 'dev-tools',
              displayName: 'Dev Tools',
              description: 'Developer tools',
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId(/^plugin-detail-share-/))

    expect(await screen.findByTestId('plugin-share-intent-enterprise')).toBeEnabled()
  })

  test('offers a retry when publication readiness cannot be loaded', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
      publicationRequestFailures: 2,
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      installedPluginNames: ['dev-tools'],
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: 'dev-tools-local',
              name: 'dev-tools',
              displayName: 'Dev Tools',
              description: 'Developer tools',
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId(/^plugin-detail-share-/))

    expect(await screen.findByTestId('plugin-operation-notice-action')).toHaveTextContent('重试')
    expect(screen.queryByTestId('plugin-share-intent-dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-operation-notice-action'))
    expect(await screen.findByTestId('plugin-share-intent-dialog')).toBeInTheDocument()
  })

  test('allows deleting local source after a personal plugin has been published', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: 'dev-tools-local',
              name: 'dev-tools',
              displayName: 'Dev Tools',
              description: 'Developer tools',
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(screen.getByTestId(/^plugin-detail-share-/)).toHaveTextContent('分享')
    await userEvent.click(screen.getByTestId(/^plugin-detail-actions-(?!bar$)/))

    expect(screen.getByTestId(/^plugin-detail-edit-/)).toHaveTextContent('继续编辑')
    expect(screen.queryByTestId(/^plugin-detail-menu-publish-/)).not.toBeInTheDocument()
    expect(screen.getByTestId(/^plugin-detail-delete-/)).toHaveTextContent('删除插件')
  })

  test('opens installed marketplace plugin actions and uninstalls from the detail menu', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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

    expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
    await waitFor(() =>
      expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
    )

    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
    )
    await userEvent.click(screen.getByTestId('plugin-detail-actions-101'))

    expect(screen.getByTestId('plugin-detail-actions-menu-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-uninstall-101')).toHaveTextContent('卸载')

    await userEvent.click(screen.getByTestId('plugin-detail-uninstall-101'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

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
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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

    await waitFor(() =>
      expect(screen.getByTestId('plugins-marketplace-tab-default')).toHaveClass('bg-surface')
    )
    expect(screen.getByTestId('plugins-marketplace-tab-existing-market')).toBeInTheDocument()
    await waitFor(() => expectCodexAppServerRequest('plugin/list', { cwds: null }))
  })

  test('treats the OpenAI curated remote marketplace as a built-in source', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    expect(
      screen.queryByTestId('plugins-marketplace-tab-openai-curated-remote')
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expectCodexAppServerRequest('plugin/list', {
        cwds: null,
      })
    )
  })

  test('keeps openai-curated plugins under the OpenAI official filter', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated',
          displayName: 'Codex official',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: 'linear',
              name: 'linear',
              displayName: 'Linear',
              description: 'Official Linear plugin',
            },
          ],
        },
        {
          name: 'awesome-codex-plugins',
          displayName: 'Awesome Codex Plugins',
          path: 'https://github.com/example/awesome-codex-plugins',
          plugins: [
            {
              id: 'superpowers',
              name: 'superpowers',
              displayName: 'SuperPowers',
              description: 'Community plugin',
            },
          ],
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByText('Linear')).toBeInTheDocument()
    expect(screen.getByText('SuperPowers')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-tab-openai-curated')).not.toBeInTheDocument()
    expect(screen.queryByText('Codex official')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-official'))
    expect(screen.getByText('Linear')).toBeInTheDocument()
    expect(screen.queryByText('SuperPowers')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-marketplace-tab-awesome-codex-plugins'))
    expect(screen.getByText('SuperPowers')).toBeInTheDocument()
    expect(screen.queryByText('Linear')).not.toBeInTheDocument()
  })

  test('merges plugins from all local Codex marketplaces into one catalog', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-primary-runtime',
          displayName: 'openai-primary-runtime',
          path: 'openai-primary-runtime',
          plugins: [defaultCodexPlugin],
        },
        {
          name: 'wework-personal',
          displayName: 'Personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [
            {
              id: '202',
              name: 'my-skill',
              displayName: 'My Skill',
              description: 'Personal plugin',
            },
          ],
        },
      ],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(screen.getByText('My Skill')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-tab-wework-personal')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-personal'))
    expect(screen.getByText('My Skill')).toBeInTheDocument()
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
  })

  test('renders configured local marketplaces as secondary market tabs', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'local-openai',
          displayName: 'OpenAI 官方市场',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: '302',
              name: 'local-docs',
              displayName: 'Local Docs',
              description: 'Local marketplace plugin',
            },
          ],
        },
        {
          name: 'local-team',
          displayName: 'Team 市场',
          path: '/Users/test/team-marketplace.json',
          plugins: [
            {
              id: '303',
              name: 'team-tool',
              displayName: 'Team Tool',
              description: 'Team marketplace plugin',
            },
          ],
        },
      ],
    })

    render(<PluginsWorkspace />)

    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-marketplace-tab-local-openai')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-tab-local-team')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-marketplace-tab-local-openai'))
    expect(screen.getByText('Local Docs')).toBeInTheDocument()
    expect(screen.queryByText('Team Tool')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-marketplace-tab-local-team'))
    expect(screen.queryByText('Local Docs')).not.toBeInTheDocument()
    expect(screen.getByText('Team Tool')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-all'))
    expect(screen.getByText('Local Docs')).toBeInTheDocument()
    expect(screen.getByText('Team Tool')).toBeInTheDocument()
  })

  test('keeps OpenAI official, enterprise, and user marketplace plugins in separate filters', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-bundled',
          displayName: 'OpenAI Bundled',
          path: 'openai-bundled',
          plugins: [
            {
              id: 'mailagent',
              name: 'mailagent',
              displayName: 'MailAgent',
              description: 'Official mail plugin',
            },
          ],
        },
        {
          name: 'wegent',
          displayName: 'Wegent',
          path: 'wegent',
          plugins: [
            {
              id: 'echoid',
              name: 'echoid',
              displayName: 'EchoID',
              description: 'Enterprise speaker id plugin',
            },
          ],
        },
        {
          name: 'wework',
          displayName: 'Wegent',
          path: 'wework',
          plugins: [],
        },
        {
          name: 'awesome-codex-plugins',
          displayName: 'Awesome Codex Plugins',
          path: 'https://github.com/example/awesome-codex-plugins',
          plugins: [
            {
              id: 'superpowers',
              name: 'superpowers',
              displayName: 'SuperPowers',
              description: 'Community plugin',
            },
          ],
        },
      ],
      installedPluginNames: ['mailagent', 'echoid', 'superpowers'],
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByText('MailAgent')).toBeInTheDocument()
    expect(screen.getByText('EchoID')).toBeInTheDocument()
    expect(screen.getByText('SuperPowers')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-tab-wework')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-official'))
    expect(screen.getByText('MailAgent')).toBeInTheDocument()
    expect(screen.queryByText('EchoID')).not.toBeInTheDocument()
    expect(screen.queryByText('SuperPowers')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-installed-strip-item-mailagent')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip-item-echoid')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip-item-superpowers')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-workspace'))
    expect(screen.getByText('EchoID')).toBeInTheDocument()
    expect(screen.queryByText('MailAgent')).not.toBeInTheDocument()
    expect(screen.queryByText('SuperPowers')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-installed-strip-item-echoid')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip-item-mailagent')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-marketplace-tab-awesome-codex-plugins'))
    expect(screen.getByText('SuperPowers')).toBeInTheDocument()
    expect(screen.queryByText('MailAgent')).not.toBeInTheDocument()
    expect(screen.queryByText('EchoID')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-installed-strip-item-superpowers')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip-item-mailagent')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip-item-echoid')).not.toBeInTheDocument()
  })

  test('selects a newly added local marketplace', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated',
          displayName: 'Codex official',
          path: 'https://github.com/openai/plugins',
        },
      ],
    })
    const { unmount } = render(<PluginsWorkspace />)

    await userEvent.click(await screen.findByTestId('plugins-create-button'))
    await userEvent.click(screen.getByTestId('plugins-add-market-option'))
    expect(screen.getByRole('dialog', { name: '添加插件市场' })).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-save-button')).toBeDisabled()
    expect(screen.getByTestId('plugins-marketplace-sparse-path-input')).toBeInstanceOf(
      HTMLTextAreaElement
    )
    expect(screen.queryByText('市场显示名称')).not.toBeInTheDocument()
    const sourceInput = screen.getByTestId('plugins-marketplace-path-input')
    await waitFor(() => expect(sourceInput).toHaveFocus())
    await userEvent.type(sourceInput, 'invalid')
    await userEvent.tab()
    expect(screen.getByText('请输入 GitHub 简写、Git URL 或本地目录。')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-marketplace-save-button')).toBeDisabled()
    await userEvent.clear(sourceInput)
    await userEvent.type(sourceInput, '/Users/test/plugins')
    expect(screen.getByTestId('plugins-marketplace-save-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('plugins-marketplace-save-button'))

    await waitFor(() =>
      expect(screen.getByTestId('plugins-marketplace-tab-local-1234')).toHaveClass('bg-surface')
    )
    expect(window.localStorage.getItem('wework.plugins.selectedMarketplaceKey')).toBe(
      'local:local-1234'
    )

    unmount()
    render(<PluginsWorkspace />)

    // Navigating back into the marketplace always defaults to the "全部" tab.
    expect(await screen.findByTestId('plugins-distribution-tab-all')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('plugins-marketplace-tab-local-1234')).not.toHaveClass('bg-surface')
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
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    vi.mocked(requestLocalExecutor).mockImplementation((command: string) => {
      if (command === 'executor.codex_home.status') {
        return Promise.resolve({
          weworkCodexHome: '/Users/test/.wework/codex',
          nativeCodexHome: '/Users/test/.codex',
          weworkCodexHomeExists: true,
          nativeCodexHomeExists: false,
          shouldPromptMigration: false,
        })
      }
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true })
      }
      if (command === 'codex.app_server_request') {
        return new Promise(() => undefined)
      }
      return Promise.resolve(undefined)
    })

    render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)

    expect(await screen.findByTestId('plugins-marketplace-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-no-marketplace-welcome')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-publish-empty-button')).not.toBeInTheDocument()
  })

  test('does not start plugin/list until the cloud marketplace can decide device sync', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      marketplaces: [
        {
          name: 'openai-curated',
          displayName: 'Codex official',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: 'linear',
              name: 'linear',
              displayName: 'Linear',
              description: 'Official Linear plugin',
            },
          ],
        },
      ],
    })

    let resolveMarketplace: ((value: Response) => void) | null = null
    const pendingMarketplace = new Promise<Response>(resolve => {
      resolveMarketplace = resolve
    })
    let pluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          pluginListStarted = true
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })
    const previousFetch = vi.mocked(fetch)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const requestUrl = new URL(url, 'http://localhost')
        if (requestUrl.pathname === '/api/plugins/marketplace') {
          return pendingMarketplace
        }
        return previousFetch(url, init)
      })
    )

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    expect(screen.queryByText('Linear')).not.toBeInTheDocument()
    expect(pluginListStarted).toBe(false)

    resolveMarketplace?.({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 999,
            remotePluginId: 'cloud-only',
            name: 'cloud-only',
            displayName: 'Cloud Only Plugin',
            description: 'Cloud catalog plugin',
            version: '1.0.0',
            author: 'Wegent',
            visibility: 'public',
            featured: false,
            installed: false,
            enabled: false,
            installedPluginId: null,
            sourceType: 'marketplace',
            sourceProvider: 'wegent',
            sourceLabel: 'Wework',
            ownerUserId: 1,
            interface: {
              displayName: 'Cloud Only Plugin',
              shortDescription: 'Cloud catalog plugin',
              logo: null,
              composerIcon: null,
              brandColor: null,
              category: 'Productivity',
              defaultPrompt: [],
              homepageUrl: null,
              supportUrl: null,
              categories: ['productivity'],
              tags: [],
            },
            components: {
              skills: [],
              commands: [],
              apps: [],
              agents: [],
              hooks: [],
              mcps: [],
              lsps: [],
              monitors: [],
              bins: [],
              connectors: [],
            },
            manifest: {},
            latestReleaseId: 1,
          },
        ],
      }),
    } as Response)

    expect(await screen.findByText('Cloud Only Plugin')).toBeInTheDocument()
    expect(await screen.findByText('Linear')).toBeInTheDocument()
    expect(pluginListStarted).toBe(true)
  })

  test('paints personal-created plugins from disk before Codex plugin/list returns', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      marketplaces: [],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'executor.plugins.personal.initialize') {
        return Promise.resolve({
          id: 'wework-personal',
          path: '/tmp/wework-personal',
          pluginCount: 1,
        })
      }
      if (command === 'executor.plugins.personal.list') {
        return Promise.resolve({
          marketplaceId: 'wework-personal',
          marketplacePath: '/tmp/wework-personal',
          plugins: [
            {
              name: 'my-notes',
              version: '0.1.0',
              displayName: 'My Notes',
              description: 'Personal notes plugin',
              logo: null,
              category: 'Productivity',
              pluginPath: '/tmp/wework-personal/plugins/my-notes',
            },
          ],
        })
      }
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-personal'))
    expect(await screen.findByText('My Notes')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()

    resolveLocalList?.({ marketplaces: [] })
  })

  test('paints disk personal plugins even when a cloud marketplace cache already exists', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setPluginMarketplaceCache({
      cacheKey: '/api|cloud-token',
      marketplaceItems: [
        {
          id: 42,
          remotePluginId: '42',
          name: 'cloud-docs',
          displayName: 'Cloud Docs',
          description: 'Cloud only',
          version: '1.0.0',
          author: null,
          visibility: 'public',
          featured: false,
          installed: false,
          enabled: false,
          sourceType: 'marketplace',
          sourceProvider: 'wegent',
          latestReleaseId: 7,
          components: {
            skills: [],
            commands: [],
            apps: [],
            agents: [],
            mcps: [],
            hooks: [],
            lsps: [],
            monitors: [],
            bins: [],
          },
          manifest: {},
          ownerUserId: 1,
        },
      ],
      installedPlugins: [],
      marketplaces: [
        {
          key: 'cloud:default',
          id: 'default',
          name: 'Wework 云端市场',
          kind: 'cloud',
        },
      ],
      selectedMarketplaceKey: 'cloud:default',
      deviceId: 'local-device',
      fetchedAt: Date.now(),
    })
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      marketplaces: [],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'executor.plugins.personal.list') {
        return Promise.resolve({
          marketplaceId: 'wework-personal',
          marketplacePath: '/tmp/wework-personal',
          plugins: [
            {
              name: 'cached-notes',
              version: '0.1.0',
              displayName: 'Cached Notes',
              description: 'Should paint despite catalog cache',
              logo: null,
              category: 'Productivity',
              pluginPath: '/tmp/wework-personal/plugins/cached-notes',
              installed: true,
            },
          ],
        })
      }
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-personal'))
    expect(await screen.findByText('Cached Notes')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()

    resolveLocalList?.({ marketplaces: [] })
  })

  test('paints cloud marketplace plugins before a slow local Codex readState responds', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      marketplaces: [
        {
          name: 'openai-curated',
          displayName: 'Codex official',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: 'linear',
              name: 'linear',
              displayName: 'Linear',
              description: 'Official Linear plugin',
            },
          ],
        },
      ],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
    expect(screen.queryByText('Linear')).not.toBeInTheDocument()

    resolveLocalList?.({
      marketplaces: [
        {
          name: 'openai-curated',
          path: 'https://github.com/openai/plugins',
          interface: { displayName: 'Codex official' },
          plugins: [
            {
              id: 'linear',
              remotePluginId: 'linear',
              localVersion: '1.0.0',
              name: 'linear',
              installed: false,
              enabled: false,
              installPolicy: 'AVAILABLE',
              authPolicy: 'ON_USE',
              interface: {
                displayName: 'Linear',
                shortDescription: 'Official Linear plugin',
                longDescription: 'Official Linear plugin',
                logo: null,
                composerIcon: null,
                brandColor: null,
                category: 'Productivity',
                defaultPrompt: [],
                homepageUrl: null,
                supportUrl: null,
                categories: ['productivity'],
                tags: [],
              },
              components: {
                skills: [],
                commands: [],
                apps: [],
                agents: [],
                hooks: [],
                mcps: [],
                lsps: [],
                monitors: [],
                bins: [],
                connectors: [],
              },
            },
          ],
        },
      ],
    })

    expect(await screen.findByText('Linear')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expectCodexAppServerRequest('plugin/list', { cwds: null })
  })

  test('keeps Wework official catalog rows after a local Codex snapshot that only has OpenAI plugins', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceName: 'dingtalk',
      marketplaceDisplayName: '钉钉',
      marketplaceVisibility: 'public',
      marketplaceSourceProvider: 'wegent',
    })
    window.localStorage.setItem(
      'wework.plugins.codexReadState.v2',
      JSON.stringify({
        version: 2,
        entries: {
          '|all': {
            paramsKey: '|all',
            cachedAt: Date.now() - 120_000,
            state: {
              marketplaceItems: [
                {
                  id: 'gmail@openai-curated-remote',
                  remotePluginId: 'gmail',
                  name: 'gmail',
                  displayName: 'Gmail',
                  description: 'Read and manage Gmail',
                  visibility: 'public',
                  featured: false,
                  installed: false,
                  installedPluginId: null,
                  enabled: false,
                  sourceType: 'marketplace',
                  sourceProvider: 'codex',
                  sourceLabel: 'OpenAI 官方',
                  components: {
                    skills: [],
                    commands: [],
                    agents: [],
                    hooks: [],
                    mcps: [],
                    lsps: [],
                    monitors: [],
                    bins: [],
                  },
                  manifest: { marketplaceId: 'openai-curated-remote' },
                  ownerUserId: 0,
                  latestReleaseId: null,
                  interface: {
                    displayName: 'Gmail',
                    shortDescription: 'Read and manage Gmail',
                    category: 'Communication',
                  },
                },
              ],
              installedPlugins: [],
              marketplaces: [{ id: 'openai-curated-remote', name: 'OpenAI', path: null }],
              selectedMarketplaceId: 'openai-curated-remote',
              marketplacePath: '',
              installRegistryPath: '',
              deviceId: 'local-device',
            },
          },
        },
      })
    )

    let resolveList: ((value: unknown) => void) | null = null
    mockCodexAppServerInvoke({ deviceId: 'local-device' })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return new Promise(resolve => {
            resolveList = resolve
          })
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('钉钉')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-public'))
    expect(screen.getByText('钉钉')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的插件')).not.toBeInTheDocument()

    resolveList?.({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: null,
          interface: { displayName: 'OpenAI' },
          plugins: [
            {
              id: 'gmail@openai-curated-remote',
              name: 'gmail',
              installed: false,
              enabled: false,
              interface: { displayName: 'Gmail' },
            },
          ],
        },
      ],
    })

    await userEvent.click(screen.getByTestId('plugins-distribution-tab-all'))
    await waitFor(() => expect(screen.getByText('Gmail')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('plugins-distribution-tab-public'))
    expect(screen.getByText('钉钉')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的插件')).not.toBeInTheDocument()
  })

  test('paints local installed strip from plugin/installed before plugin/list finishes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      installedPluginNames: ['linear'],
      marketplaces: [
        {
          name: 'openai-curated',
          displayName: 'Codex official',
          path: 'https://github.com/openai/plugins',
          plugins: [
            {
              id: 'linear',
              name: 'linear',
              displayName: 'Linear',
              description: 'Official Linear plugin',
            },
          ],
        },
      ],
    })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string; params?: Record<string, unknown> }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-installed-strip-item-linear')).toBeInTheDocument()

    resolveLocalList?.({
      marketplaces: [
        {
          name: 'openai-curated',
          path: 'https://github.com/openai/plugins',
          interface: { displayName: 'Codex official' },
          plugins: [
            {
              id: 'linear',
              remotePluginId: 'linear',
              localVersion: '1.0.0',
              name: 'linear',
              installed: true,
              enabled: true,
              installPolicy: 'AVAILABLE',
              authPolicy: 'ON_USE',
              interface: {
                displayName: 'Linear',
                shortDescription: 'Official Linear plugin',
                longDescription: 'Official Linear plugin',
                logo: null,
                composerIcon: null,
                brandColor: null,
                category: 'Productivity',
                defaultPrompt: [],
                homepageUrl: null,
                supportUrl: null,
                categories: ['productivity'],
                tags: [],
              },
              components: {
                skills: [],
                commands: [],
                apps: [],
                agents: [],
                hooks: [],
                mcps: [],
                lsps: [],
                monitors: [],
                bins: [],
                connectors: [],
              },
            },
          ],
        },
      ],
    })

    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByText('Linear')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByTestId('plugins-installed-strip-empty')).not.toBeInTheDocument()
    })
  })

  test('paints cloud installed strip before Codex plugin/list finishes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    clearPluginMarketplaceCache()
    clearLocalCodexPluginsReadStateCache()
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'local-device' })

    let resolveLocalList: ((value: unknown) => void) | null = null
    const pendingLocalList = new Promise(resolve => {
      resolveLocalList = resolve
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { method?: string }
        }
        if (request.method === 'plugin/list') {
          return pendingLocalList
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    // Wework/cloud installs must not wait on Codex plugin/list (~10s) or the strip flashes.
    expect(await screen.findByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()

    resolveLocalList?.({ marketplaces: [] })
    await waitFor(() => {
      expect(screen.getByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
    })
  })

  test('paints cloud installed strip even when marketplace catalog is still empty', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    clearPluginMarketplaceCache()
    clearLocalCodexPluginsReadStateCache()
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'local-device', marketplaces: [] })

    let resolveMarketplace: ((value: unknown) => void) | null = null
    const pendingMarketplace = new Promise(resolve => {
      resolveMarketplace = resolve
    })
    const previousFetch = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation((input, init) => {
      const requestUrl = new URL(String(input), 'http://localhost')
      if (requestUrl.pathname === '/api/plugins/marketplace') {
        return pendingMarketplace as Promise<Response>
      }
      return previousFetch?.(input, init) as Promise<Response>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    // Installed strip must paint from /plugins/installed even before marketplace rows arrive.
    expect(await screen.findByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()

    resolveMarketplace?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items: [] }),
    })
    await waitFor(() => {
      expect(screen.getByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
    })
  })

  test('sends remote plugin id for remote marketplace install', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    await localPluginApi.installAvailablePlugin('local-openai:5715908889684902000')

    expectCodexAppServerRequest('plugin/install', {
      pluginName: 'openai-documents',
    })
  })

  test('sends plugin name for local marketplace install', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    await localPluginApi.installAvailablePlugin('local-openai:5715908889684902000')

    expectCodexAppServerRequest('plugin/install', {
      marketplacePath: '/Users/test/.codex/plugins/marketplaces/openai',
      pluginName: 'documents',
    })
  })

  test('installs from the item marketplace after another marketplace was selected', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'target-marketplace',
          displayName: 'Target',
          path: '/Users/test/.codex/plugins/marketplaces/target',
          plugins: [
            {
              ...defaultCodexPlugin,
              id: 'target-plugin',
              name: 'target-plugin',
            },
          ],
        },
        {
          name: 'other-marketplace',
          displayName: 'Other',
          path: '/Users/test/.codex/plugins/marketplaces/other',
        },
      ],
    })
    const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
    const localPluginApi = createLocalCodexPluginApi()

    await localPluginApi.selectMarketplace('other-marketplace')
    await localPluginApi.installAvailablePlugin(
      'target-marketplace:target-plugin',
      'target-marketplace'
    )

    expectCodexAppServerRequest('plugin/install', {
      marketplacePath: '/Users/test/.codex/plugins/marketplaces/target',
      pluginName: 'target-plugin',
    })
  })

  test('disables an installed plugin without uninstalling it', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'codex.app_server_request',
      expect.objectContaining({
        params: expect.objectContaining({ method: 'plugin/uninstall' }),
      })
    )
  })

  test('lists local skills through Codex app-server', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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

  test('lists enabled accessible apps and can retain inaccessible apps for internal merging', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    await expect(
      localPluginApi.listApps({ includeInaccessible: true }).then(apps => apps.map(app => app.id))
    ).resolves.toEqual(['google-calendar', 'inaccessible-app'])
    expectCodexAppServerRequest('app/list', {
      cursor: null,
      limit: 100,
      forceRefetch: false,
    })
  })

  test('does not expose deletion for local marketplaces', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
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

  test('opens the managed Plugin Creator workspace', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    const createPluginOption = screen.getByTestId('plugins-create-plugin-option')
    expect(createPluginOption.querySelector('.lucide-plug')).toBeInTheDocument()
    expect(createPluginOption.querySelector('.lucide-at-sign')).not.toBeInTheDocument()
    await userEvent.click(createPluginOption)

    expect(window.location.pathname).toBe('/plugins/create')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()
  })

  test('refreshes only local plugin state after importing a ZIP', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    desktopHostMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/offline-import.zip'],
    })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'wework-personal',
          displayName: '个人创建',
          path: '/Users/test/.agents/plugins/marketplace.json',
          plugins: [
            {
              id: 'offline-import',
              name: 'offline-import',
              displayName: 'Offline Import',
            },
          ],
        },
      ],
      localPluginImport: {
        archivePath: '/tmp/offline-import.zip',
        pluginName: 'offline-import',
        displayName: 'Offline Import',
        version: '1.0.0',
      },
    })

    render(<PluginsWorkspace />)

    await screen.findByTestId('plugins-create-button')
    await waitFor(() =>
      expect(
        vi
          .mocked(requestLocalExecutor)
          .mock.calls.filter(
            ([command, args]) =>
              command === 'codex.app_server_request' &&
              (args as { method?: string })?.method === 'plugin/list'
          )
      ).toHaveLength(1)
    )
    const pluginListCallsBeforeImport = vi
      .mocked(requestLocalExecutor)
      .mock.calls.filter(
        ([command, args]) =>
          command === 'codex.app_server_request' &&
          (args as { method?: string })?.method === 'plugin/list'
      ).length

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    await userEvent.click(screen.getByTestId('plugins-import-plugin-option'))
    await userEvent.click(screen.getByTestId('plugin-import-select'))
    await userEvent.click(await screen.findByTestId('plugin-import-confirm'))

    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
      '插件已导入并安装。如需连接器授权，可稍后在插件详情中登录。'
    )
    await waitFor(() =>
      expect(
        vi
          .mocked(requestLocalExecutor)
          .mock.calls.some(([command]) => command === 'runtime.codex.plugin.install_local_first')
      ).toBe(true)
    )
    expect(
      vi
        .mocked(requestLocalExecutor)
        .mock.calls.filter(
          ([command, args]) =>
            command === 'codex.app_server_request' &&
            (args as { method?: string })?.method === 'plugin/list'
        )
    ).toHaveLength(pluginListCallsBeforeImport)
  })

  test('closes the create menu on outside click and Escape', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toHaveClass('border-border/30', 'shadow-lg')

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()
  })
})
