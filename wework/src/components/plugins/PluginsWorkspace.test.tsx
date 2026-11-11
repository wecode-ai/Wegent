import {
  authorizeWegentConnector,
  listWegentConnectorApps,
  refreshWegentConnector,
} from '@/api/cloud/connectorApps'
import * as fileHash from '@/api/fileHash'
import * as codexPlugins from '@/api/local/codexPlugins'
import { ExpiredPluginInventoryRequest } from '@/api/local/codexInstalledCatalog'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { clearLocalConnectorAuthHealthCache } from '@/api/local/localConnectorAuth'
import * as localExecutor from '@/desktop/localExecutor'
import { requestLocalExecutor, resetLocalExecutorStateForTests } from '@/desktop/localExecutor'
import {
  resetLocalExecutorCloudConnectionStatus,
  setLocalExecutorCloudConnectionStatus,
} from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import { CodexAuthorizationTimeoutError } from '@/features/plugins/codexConnectorAuthorization'
import * as connectorCleanup from '@/features/plugins/logoutLocalQrConnectors'
import { PLUGIN_AUTO_UPDATE_COMPLETED_EVENT } from '@/features/plugins/PluginAutoUpdateCoordinator'
import {
  clearPluginDeviceAutoSyncAttempts,
  hasAttemptedPluginDeviceAutoSync,
  hasSettledPluginDeviceAutoSync,
  hasInFlightPluginDeviceSync,
} from '@/features/plugins/pluginDeviceAutoSync'
import {
  pluginInventoryReadIsCurrent,
  selectComposerPluginApps,
  writePluginInventory,
} from '@/features/plugins/pluginInventory'
import { inventoryIdentity } from '@/features/plugins/pluginInventorySources'
import {
  clearPluginMarketplaceCache,
  flushPluginMarketplaceCachePersist,
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  resetPluginMarketplaceCacheMemory,
  setPluginMarketplaceCache,
  subscribePluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import * as refreshReconciliation from '@/features/plugins/pluginRefreshReconciliation'
import '@/i18n'
import * as navigation from '@/lib/navigation'
import type {
  InstalledPlugin,
  InstalledPluginComponents,
  InstalledPluginListResponse,
  PluginMarketplaceItem,
  PluginPublicationRequestItem,
} from '@/types/api'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mergeMarketplaceCatalog } from './marketplaceCatalogMerge'
import * as pluginDetailView from './PluginDetailView'
import { PluginsWorkspace } from './PluginsWorkspace'
import * as pluginUninstall from './pluginUninstall'
import * as marketplaceWorkspaceHelpers from './workspace/marketplaceWorkspaceHelpers'

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}))
const localExecutorMocks = vi.hoisted(() => ({
  ensureStarted: vi.fn(),
  ensureAvailable: vi.fn(),
  knownDeviceId: 'current-device' as string | null,
  deviceRouteId: null as string | null,
  request: vi.fn(),
}))
const desktopHostMock = vi.hoisted(() => vi.fn())
const ensurePythonMock = vi.hoisted(() => vi.fn())

function mockKnownExecutorDevice(deviceId: string, deviceRouteId: string | null = null): void {
  const routeId = deviceRouteId ?? deviceId
  localExecutorMocks.knownDeviceId = deviceId
  localExecutorMocks.deviceRouteId = routeId
  const status = {
    running: true,
    ready: true,
    deviceId,
    deviceRouteId: routeId,
  }
  localExecutorMocks.ensureStarted.mockResolvedValue(status)
  localExecutorMocks.ensureAvailable.mockResolvedValue(status)
}

async function installPluginFromMarketCard(testId: string) {
  await userEvent.click(screen.getByTestId(testId))
  await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
  await waitFor(() => expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument())
}

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({ sha256: 'test-account' }),
}))

vi.mock('@/desktop/localExecutor', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/localExecutor')>()),
  ensureLocalExecutorStarted: localExecutorMocks.ensureStarted,
  ensureLocalExecutorAvailable: localExecutorMocks.ensureAvailable,
  getKnownLocalExecutorDeviceId: () => localExecutorMocks.knownDeviceId,
  requestLocalExecutor: localExecutorMocks.request,
}))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMock,
}))

vi.mock('@/telemetry/businessEvents', () => ({ trackPluginEvent: telemetryMocks.track }))
vi.mock('@/api/cloud/connectorApps', () => ({
  authorizeWegentConnector: vi.fn(),
  connectorAuthorizationErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  listWegentConnectorApps: vi.fn(),
  notifyConnectorAuthorizationChanged: vi.fn(),
  refreshWegentConnector: vi.fn(),
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
  localVersion?: string
  remotePluginId?: string
  displayName?: string
  description?: string
  category?: string
  logo?: string
  defaultPrompt?: string | string[]
  availability?: string
  disabledReason?: string | null
  installPolicy?: string
  connectors?: Array<{
    slug: string
    authPolicy: 'on_use'
  }>
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
    localVersion: plugin.localVersion ?? '1.0.0',
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
    connectors: plugin.connectors ?? [],
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
    deviceRouteId?: string
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
      installedPluginId?: number | null
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
    localConnectorAuthLogout?: () => Promise<unknown>
    localPluginImport?: {
      archivePath: string
      pluginName: string
      displayName: string
      version: string
    }
  } = {}
) {
  mockKnownExecutorDevice(options.deviceId ?? 'current-device', options.deviceRouteId)
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
    if (method === 'executor.plugins.local_sync') {
      return Promise.reject(
        Object.assign(new Error('Legacy Runtime'), { code: 'unsupported_method' })
      )
    }
    if (method === 'executor.plugins.device_route') {
      return Promise.resolve(localExecutorMocks.ensureAvailable.getMockImplementation()?.()).then(
        status => ({
          device_id: status?.deviceId,
          device_route_id: status?.deviceRouteId,
        })
      )
    }
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
      const personal = marketplaces.filter(marketplace =>
        ['personal', 'wework-personal'].includes(marketplace.name)
      )
      return Promise.resolve({
        marketplaceId: 'wework-personal',
        marketplacePath: personal[0]?.path ?? '/tmp/wework-personal',
        plugins: personal.flatMap(marketplace =>
          (marketplace.plugins ?? [defaultCodexPlugin]).map(plugin => ({
            ...plugin,
            version: plugin.localVersion,
            marketplacePath: marketplace.path,
            pluginPath: `${marketplace.path}/plugins/${plugin.name}`,
          }))
        ),
      })
    }
    if (method === 'executor.codex_home.config.read') {
      const keys = (enabled: boolean) =>
        marketplaces.flatMap(marketplace =>
          (marketplace.plugins ?? [defaultCodexPlugin])
            .filter(
              plugin =>
                installedPluginNames.has(plugin.name) &&
                (pluginEnabledById.get(plugin.id) !== false) === enabled
            )
            .map(plugin => `${plugin.name}@${marketplace.name}`)
        )
      return Promise.resolve({ enabledPluginKeys: keys(true), disabledPluginKeys: keys(false) })
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
    if (request.method === 'runtime.local_connector_auth.logout') {
      return options.localConnectorAuthLogout?.() ?? Promise.resolve({ status: 'ok' })
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
    deviceId: string
    marketplaceDeviceState: 'installed' | 'failed' | 'pending' | 'uninstalling'
    marketplaceActualReleaseId: number
    marketplaceInstallError: string
    marketplaceLogo: string
    marketplaceBrandColor: string
    installedMarketplaceLogo: string
    marketplaceCount: number
    marketplaceConnectorSlug: string
    marketplaceConnectorAuthPolicy: 'on_install' | 'on_use' | 'optional'
    marketplaceConnectorLocal: boolean
    marketplaceConnectorAccountAuth: boolean
    installedMarketplaceConnectors: InstalledPluginComponents['connectors']
    marketplaceHasSkill: boolean
    marketplaceVisibility: 'personal' | 'workspace' | 'public'
    marketplaceSourceProvider: 'codex' | 'wegent' | 'user'
    marketplaceAccessRole: 'catalog' | 'owner' | 'recipient'
    marketplaceName: string
    marketplaceDisplayName: string
    deviceAutoSyncSucceeds: boolean
    reportDeviceFailures: number
    reportDeviceGate: Promise<void>
    localVersionEvidence: string
    marketplaceUpdateAvailable: boolean
    marketplaceUpdatePolicy: 'manual' | 'auto'
    autoUpdateBatchSizes: number[]
    deviceAutoSyncGate: Promise<void>
    pluginAccessGate: Promise<void>
    publicationRequestGate: Promise<void>
    publicationRequests: PluginPublicationRequestItem[]
    publicationRequestFailures: number
    cloudToken: string
    deviceId: string
  }> = {}
) {
  const fixtureDeviceId = overrides.deviceId ?? 'current-device'
  let marketplaceUpdateAvailable = Boolean(overrides.marketplaceUpdateAvailable)
  let marketplaceLatestReleaseId = marketplaceUpdateAvailable ? 1002 : 1001
  let marketplaceUpdatePolicy = overrides.marketplaceUpdatePolicy ?? 'manual'
  const autoUpdateBatchSizes = [...(overrides.autoUpdateBatchSizes ?? [])]
  let autoUpdateBatchCalls = 0
  let nextAutoUpdateInstalledPluginId = 101
  let cloudMarketplacePluginInstalled = Boolean(overrides.marketplaceInstalled)
  let marketplaceDeviceState: 'installed' | 'failed' | 'pending' | 'uninstalling' =
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
  const buildDocumentsMarketplacePlugin = (deviceId = fixtureDeviceId) => ({
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
              authPolicy: overrides.marketplaceConnectorAuthPolicy ?? 'on_install',
              ...(overrides.marketplaceConnectorAccountAuth
                ? {
                    accountAuth: {
                      protocolVersion: 1,
                      credentialType: 'oauth2',
                      adapter: 'scripts/account-auth.py',
                    },
                  }
                : {}),
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
          deviceId,
          desiredReleaseId: 1001,
          actualReleaseId:
            overrides.marketplaceActualReleaseId ??
            (marketplaceDeviceState === 'installed' ? 1001 : null),
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
  const buildMarketplacePlugins = (deviceId = fixtureDeviceId) =>
    Array.from({ length: Math.max(1, overrides.marketplaceCount ?? 1) }, (_, index) => {
      if (index === 0) return buildDocumentsMarketplacePlugin(deviceId)
      const sequence = index + 1
      const documentsPlugin = buildDocumentsMarketplacePlugin(deviceId)
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
  const buildInstalledMarketplacePlugin = (deviceId = fixtureDeviceId) => {
    const marketplaceRow = buildDocumentsMarketplacePlugin(deviceId)
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
        components: {
          ...marketplaceRow.components,
          connectors:
            overrides.installedMarketplaceConnectors ?? marketplaceRow.components.connectors,
        },
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
            deviceId,
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

  const previousFetch = fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      // Late work from an earlier account must retain its own HTTP fixture.
      if (
        overrides.cloudToken &&
        new Headers(init?.headers).get('Authorization') !== `Bearer ${overrides.cloudToken}`
      ) {
        return previousFetch(url, init)
      }
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
              items: cloudMarketplacePluginInstalled
                ? [
                    buildInstalledMarketplacePlugin(
                      requestUrl.searchParams.get('device_id') || undefined
                    ),
                  ]
                : [],
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
        return (overrides.reportDeviceGate ?? Promise.resolve()).then(() => ({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deviceId: requestUrl.searchParams.get('device_id') || fixtureDeviceId,
              acknowledgedCount: 1,
              acknowledgedInstalledPluginIds: [101],
            }),
        }))
      }
      if (
        requestUrl.pathname === '/api/plugins/installed/sync-device' ||
        /^\/api\/plugins\/installed\/\d+\/sync-device$/.test(requestUrl.pathname)
      ) {
        syncDeviceCalls += 1
        const installedPluginId =
          /\/installed\/(\d+)\/sync-device$/.exec(requestUrl.pathname)?.[1] ?? '101'
        const response = {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deviceId: requestUrl.searchParams.get('device_id') || fixtureDeviceId,
              pendingCount: 1,
              reconciled: requestUrl.searchParams.get('reconcile') === 'true',
              sync: {
                success: deviceAutoSyncSucceeds,
                device_id: fixtureDeviceId,
                mode: 'replace',
                skills: [],
                plugins: deviceAutoSyncSucceeds
                  ? [
                      {
                        id: installedPluginId,
                        name: `plugin-${installedPluginId}`,
                        status: 'synced',
                      },
                    ]
                  : [
                      {
                        id: installedPluginId,
                        name: `plugin-${installedPluginId}`,
                        status: 'failed',
                        stage: 'codex_config',
                        error_code: 'INVALID_CODEX_CONFIG',
                        error: 'still broken',
                      },
                    ],
                mcps: [],
                errors: [],
                synced: deviceAutoSyncSucceeds ? 1 : 0,
                failed: deviceAutoSyncSucceeds ? 0 : 1,
                skipped: 0,
                results: [
                  {
                    device_id: fixtureDeviceId,
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
        const firstInstalledPluginId = nextAutoUpdateInstalledPluginId
        nextAutoUpdateInstalledPluginId += updatedCount
        if (remainingCount === 0) marketplaceUpdateAvailable = false
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              updated: Array.from({ length: updatedCount }, (_, index) => ({
                installedPluginId: firstInstalledPluginId + index,
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
        const currentMarketplacePlugins = buildMarketplacePlugins(
          requestUrl.searchParams.get('device_id') || undefined
        ).map((plugin, index) =>
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
              json: () =>
                Promise.resolve({
                  plugin: buildInstalledMarketplacePlugin(
                    requestUrl.searchParams.get('device_id') || undefined
                  ),
                }),
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
    setMarketplaceInstallation: (installed: boolean, state: typeof marketplaceDeviceState) => {
      cloudMarketplacePluginInstalled = installed
      marketplaceDeviceState = state
    },
    publishMarketplaceUpdate: () => {
      marketplaceLatestReleaseId += 1
      marketplaceUpdateAvailable = true
    },
    getSyncDeviceCalls: () => syncDeviceCalls,
    getReportDeviceCalls: () => reportDeviceCalls,
    getAutoUpdateBatchCalls: () => autoUpdateBatchCalls,
  }
}

function mockPersonalRefreshInventory(pluginName = 'offline-notes') {
  const personalPlugins = [
    {
      id: `${pluginName}@wework-personal`,
      name: pluginName,
      displayName: 'Offline Notes',
      description: 'Existing personal source',
      localVersion: '0.1.0',
    },
  ]
  mockCodexAppServerInvoke({
    deviceId: 'current-device',
    installedPluginNames: [pluginName],
    marketplaces: [
      {
        name: 'wework-personal',
        path: '/tmp/wework-personal',
        plugins: personalPlugins,
      },
    ],
  })
  const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
  const diskError = new Error('Personal source executor unavailable')
  let diskReadState: 'present' | 'unavailable' | 'malformed' | 'empty' = 'present'
  vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
    if (method !== 'executor.plugins.personal.list') return originalInvoke(method, params)
    if (diskReadState === 'unavailable') return Promise.reject(diskError)
    if (diskReadState === 'malformed') return Promise.resolve({ plugins: null })
    return Promise.resolve({
      marketplaceId: 'wework-personal',
      marketplacePath: '/tmp/wework-personal',
      plugins:
        diskReadState === 'empty'
          ? []
          : [
              {
                name: pluginName,
                version: '0.1.0',
                displayName: 'Offline Notes',
                description: 'Existing personal source',
                pluginPath: `/tmp/wework-personal/plugins/${pluginName}`,
              },
            ],
    })
  })
  return {
    diskError,
    setDiskReadState: (state: typeof diskReadState) => {
      diskReadState = state
      if (state === 'empty') personalPlugins.length = 0
    },
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
  seedInventory?: boolean
  remoteFetchedAt?: number
  cacheKey?: string
}) {
  mockKnownExecutorDevice('local-device')
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
  if (options?.seedInventory) {
    setPluginMarketplaceCache(
      {
        cacheKey: options.cacheKey ?? '|anon',
        marketplaceItems: (options.includeGmailInstall
          ? [githubItem, gmailItem]
          : [githubItem]) as PluginMarketplaceItem[],
        installedPlugins: options.includeGmailInstall
          ? [githubInstalled, gmailInstalled]
          : [githubInstalled],
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
        openAiCatalogFetchedAt: options.remoteFetchedAt,
      },
      { remoteCatalog: true }
    )
  }
  window.localStorage.setItem(
    'wework.plugins.codexCatalog.v1',
    JSON.stringify({
      version: 2,
      entries: {
        '|all|all-kinds': {
          paramsKey: '|all|all-kinds',
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

function holdNextCloudPluginRead(source: 'marketplace' | 'installed') {
  let release!: () => void
  let reject!: (error: Error) => void
  const gate = new Promise<void>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  const ready = vi.fn()
  const returned = vi.fn()
  const read = vi.mocked(fetch).getMockImplementation()!
  let held = false
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const response = await read(input, init)
    if (!held && new URL(String(input), 'http://localhost').pathname === `/api/plugins/${source}`) {
      held = true
      ready()
      await gate
      returned()
    }
    return response
  })
  return { release, reject, ready, returned, read }
}

function holdLocalCatalogReads(outcomes: Array<'partial' | 'reject' | 'expired'>) {
  const localApi = createLocalCodexPluginApi()
  const readState = localApi.readState.bind(localApi)
  const requests = outcomes.map(outcome => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    return { outcome, gate, release, ready: vi.fn(), returned: vi.fn() }
  })
  let heldCount = 0
  const read = vi.spyOn(localApi, 'readState').mockImplementation(async params => {
    const state = await readState(params)
    if (
      heldCount === requests.length ||
      !params?.refresh ||
      !params?.reuseInstalledInventory ||
      !params.marketplaceKinds?.includes('local')
    )
      return state
    const held = requests[heldCount++]
    held.ready()
    await held.gate
    held.returned()
    if (held.outcome === 'expired') throw new ExpiredPluginInventoryRequest()
    if (held.outcome === 'reject') throw new Error('Local catalog unavailable')
    return { ...state, partial: true }
  })
  const createApi = vi.spyOn(codexPlugins, 'createLocalCodexPluginApi').mockReturnValue(localApi)
  return {
    requests,
    restore: () => {
      read.mockRestore()
      createApi.mockRestore()
    },
  }
}

describe('PluginsWorkspace', () => {
  let restoreMenuGeometry: Array<() => void> = []
  afterEach(() => {
    restoreMenuGeometry.forEach(restore => restore())
    restoreMenuGeometry = []
  })
  beforeEach(() => {
    // Radix hides detached anchors. Model visible action triggers instead of
    // jsdom's zero-size rectangles without replacing the real popover logic.
    const getRect = HTMLElement.prototype.getBoundingClientRect
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        const id = this.dataset.testid ?? ''
        return id.startsWith('plugin-marketplace-actions-') && !id.includes('actions-menu-')
          ? new DOMRect(16, 16, 28, 28)
          : getRect.call(this)
      })
    const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024)
    const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768)
    restoreMenuGeometry = [
      () => bounds.mockRestore(),
      () => width.mockRestore(),
      () => height.mockRestore(),
    ]
    delete window.__WEWORK_RUNTIME_CONFIG__
    telemetryMocks.track.mockClear()
    desktopHostMock.mockReset()
    ensurePythonMock.mockReset().mockResolvedValue({ state: 'installed' })
    window.weworkElectronExecutionEnvironments = {
      list: vi.fn().mockResolvedValue([]),
      ensurePython: ensurePythonMock,
      chooseNodeExecutable: vi.fn().mockResolvedValue(null),
      useBuiltinNode: vi.fn().mockResolvedValue(undefined),
    }
    localExecutorMocks.ensureStarted.mockReset()
    localExecutorMocks.ensureAvailable.mockReset()
    mockKnownExecutorDevice('current-device')
    vi.mocked(requestLocalExecutor).mockReset()
    vi.mocked(requestLocalExecutor).mockImplementation(method => {
      if (method === 'executor.plugins.device_route') {
        return Promise.resolve(localExecutorMocks.ensureAvailable.getMockImplementation()?.()).then(
          status => ({
            device_id: status?.deviceId,
            device_route_id: status?.deviceRouteId,
          })
        )
      }
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
    vi.mocked(refreshWegentConnector).mockReset()
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

  test.each([
    'cloud-catalog',
    'cloud-installed',
    'local-membership',
    'store',
    'personal',
    'bad-catalog',
    'bad-installed',
  ])('keeps healthy plugin rows visible after a %s read fails', async source => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch()
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'custom-local',
          path: '/tmp/custom-local',
          plugins: [
            { ...defaultCodexPlugin, id: 'local-1', name: 'local-docs', displayName: 'Local Docs' },
          ],
        },
      ],
      installedPluginNames: ['local-docs'],
    })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const catalog = path === '/api/plugins/marketplace'
      const installed = path === '/api/plugins/installed'
      if ((catalog && source === 'cloud-catalog') || (installed && source === 'cloud-installed'))
        return Promise.reject(new Error('source unavailable'))
      if ((catalog && source === 'bad-catalog') || (installed && source === 'bad-installed'))
        return Promise.resolve(
          new Response(JSON.stringify({ items: [null] }), {
            headers: { 'Content-Type': 'application/json' },
          })
        )
      return originalFetch(input, init)
    })
    const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
    vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
      if (
        (source === 'store' && method === 'executor.plugins.store.list') ||
        (source === 'personal' && method === 'executor.plugins.personal.list') ||
        (source === 'local-membership' &&
          method === 'codex.app_server_request' &&
          (args as { method?: string })?.method === 'plugin/installed')
      )
        return Promise.reject(new Error('source unavailable'))
      return originalInvoke(method, args)
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    expect(await screen.findByText('Local Docs')).toBeInTheDocument()
    if (!['cloud-catalog', 'bad-catalog'].includes(source))
      expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'error'
    )
    await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
  })

  test.each(['codex', 'store'] as const)(
    'retains the failed %s source after restart while a successful empty source clears only its membership',
    async failedSource => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({ marketplaceInstalled: true, marketplaceDeviceState: 'installed' })
      const nativeMarket = {
        name: 'native-market',
        path: '/tmp/native-market',
        plugins: [
          {
            ...defaultCodexPlugin,
            id: 'native-docs',
            name: 'native-docs',
            displayName: 'Native Docs',
          },
        ],
      }
      mockCodexAppServerInvoke({
        marketplaces: [nativeMarket],
        installedPluginNames: ['native-docs'],
        wegentStorePlugins: [
          {
            name: 'documents',
            packageId: '101-wegent-documents-1.0.0',
            installedPluginId: 101,
            marketplace: 'wegent',
            version: '1.0.0',
            enabled: true,
            pluginPath: '/tmp/store/101-wegent-documents-1.0.0',
          },
        ],
      })
      const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
      const first = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await waitFor(() =>
        expect(getPluginMarketplaceCache(cacheKey)?.installedPlugins).toHaveLength(2)
      )
      await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
      const initial = getPluginMarketplaceCache(cacheKey)!
      const native = initial.installedPlugins.find(
        plugin => plugin.spec.source.pluginKey === 'native-docs'
      )!
      const stored = initial.installedPlugins.find(plugin => plugin.spec.pluginId === 101)!
      expect(native).toBeDefined()
      expect(stored.spec.sourcePayload?.localPresent).toBe(true)
      first.unmount()
      flushPluginMarketplaceCachePersist()
      resetPluginMarketplaceCacheMemory()
      clearLocalCodexPluginsReadStateCache()
      mockCodexAppServerInvoke({ marketplaces: [nativeMarket], installedPluginNames: [] })
      const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
        if (
          (failedSource === 'store' && method === 'executor.plugins.store.list') ||
          (failedSource === 'codex' &&
            method === 'codex.app_server_request' &&
            (args as { method?: string })?.method === 'plugin/installed')
        )
          return Promise.reject(new Error(`${failedSource} unavailable after restart`))
        return originalInvoke(method, args)
      })

      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
        'data-notice-kind',
        'error'
      )
      await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
      const restored = getPluginMarketplaceCache(cacheKey)!
      expect(
        restored.installedPlugins.some(plugin => plugin.spec.source.pluginKey === 'native-docs')
      ).toBe(failedSource === 'codex')
      expect(
        restored.installedPlugins.find(plugin => plugin.spec.pluginId === 101)?.spec.sourcePayload
          ?.localPresent === true
      ).toBe(failedSource === 'store')
      expect(restored.localInstalledSources).toMatchObject({
        codex: failedSource === 'codex' ? [inventoryIdentity(native)] : [],
        store: failedSource === 'store' ? [inventoryIdentity(stored)] : [],
      })
      expect(restored.localInstalledSourceStatus).toMatchObject({
        codex: failedSource === 'codex' ? 'rejected' : 'fulfilled',
        store: failedSource === 'store' ? 'rejected' : 'fulfilled',
      })
      expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
    }
  )

  test('revokes automatic write readiness when another consumer publishes a rejected source', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ marketplaceInstalled: true, marketplaceDeviceState: 'installed' })
    mockCodexAppServerInvoke({
      wegentStorePlugins: [
        {
          name: 'documents',
          packageId: '101-wegent-documents-1.0.0',
          installedPluginId: 101,
          marketplace: 'wegent',
          version: '1.0.0',
          enabled: true,
          pluginPath: '/tmp/store/101-wegent-documents-1.0.0',
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await waitFor(() => expectCodexAppServerRequest('plugin/list', { cwds: null }))
    const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const before = getPluginMarketplaceCache(cacheKey)!
    expect(before.localInstalledSourceStatus).toMatchObject({
      codex: 'fulfilled',
      store: 'fulfilled',
    })
    const stored = before.installedPlugins.find(plugin => plugin.spec.pluginId === 101)!
    expect(stored.spec.sourcePayload?.localPresent).toBe(true)
    act(() =>
      writePluginInventory(cacheKey, 'current-device', {
        localInstalledSourceStatus: { codex: 'fulfilled', store: 'rejected' },
        marketplaceItems: before.marketplaceItems.map(item => ({
          ...item,
          version: '2.0.0',
          latestReleaseId: 1002,
          currentDeviceInstallation: item.currentDeviceInstallation
            ? {
                ...item.currentDeviceInstallation,
                desiredReleaseId: 1002,
                actualReleaseId: null,
                state: 'pending' as const,
              }
            : null,
        })),
      })
    )
    expect(getPluginMarketplaceCache(cacheKey)?.installedPlugins).toEqual(before.installedPlugins)
    await userEvent.type(screen.getByTestId('plugins-search-input'), 'Documents')

    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
    expect(hasInFlightPluginDeviceSync('current-device')).toBe(false)
  })

  test('does not synchronize a device gap while cloud installed membership is still pending or failed', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ marketplaceInstalled: true, marketplaceDeviceState: 'pending' })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const held = holdNextCloudPluginRead('installed')
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('plugins-search-input'), 'Documents')
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
    expect(hasInFlightPluginDeviceSync('current-device')).toBe(false)

    await act(async () => held.reject(new Error('Installed membership unavailable')))
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'error'
    )
    await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
    expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
  })

  test('retains the independent cloud catalog after an installed failure and clears the error on refresh', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ deviceAutoSyncSucceeds: true })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
    vi.mocked(requestLocalExecutor).mockImplementation(async (method, args) => {
      const result = await originalInvoke(method, args)
      return method === 'executor.plugins.store.list'
        ? { ...(result as Record<string, unknown>), supportsPluginReconciliation: true }
        : result
    })
    const held = holdNextCloudPluginRead('installed')
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()

    await act(async () => held.reject(new Error('Installed membership unavailable')))
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'error'
    )
    const refresh = screen.getByTestId('plugins-refresh-button')
    await waitFor(() => expect(refresh).not.toBeDisabled())
    expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    await userEvent.click(refresh)

    await waitFor(() => expect(refresh).not.toBeDisabled())
    expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByTestId('plugin-operation-notice')?.getAttribute('data-notice-kind')
      ).not.toBe('error')
    )
  })

  test.each(['account', 'device', 'mutation'] as const)(
    'ignores a late cloud catalog after a newer %s',
    async change => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({ marketplaceDisplayName: 'Old Scope Catalog' })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const held = holdNextCloudPluginRead('marketplace')
      const { rerender } = render(
        <PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />
      )
      await waitFor(() => expect(held.ready).toHaveBeenCalled())
      const token = change === 'account' ? 'other-account' : 'cloud-token'
      const deviceId = change === 'device' ? 'new-device' : 'current-device'
      const cacheKey = pluginMarketplaceCacheKey('/api', token)
      if (change === 'mutation') {
        const response = await held.read('/api/plugins/marketplace')
        const { items } = (await response.json()) as { items: PluginMarketplaceItem[] }
        act(() =>
          writePluginInventory(
            cacheKey,
            deviceId,
            {
              marketplaceItems: items.map(item => ({ ...item, displayName: 'New Scope Catalog' })),
            },
            { mutation: true }
          )
        )
      } else {
        mockSystemSkillsFetch({
          marketplaceDisplayName: 'New Scope Catalog',
          cloudToken: token,
          deviceId,
        })
        mockCodexAppServerInvoke({ deviceId })
        rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken={token} />)
      }
      expect(await screen.findByText('New Scope Catalog')).toBeInTheDocument()
      await act(async () => held.release())
      await waitFor(() => expect(held.returned).toHaveBeenCalled())

      expect(screen.queryByText('Old Scope Catalog')).not.toBeInTheDocument()
      expect(screen.getByText('New Scope Catalog')).toBeInTheDocument()
      expect(getPluginMarketplaceCache(cacheKey)?.marketplaceItems).toEqual([
        expect.objectContaining({ displayName: 'New Scope Catalog' }),
      ])
      await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).toBeEnabled())
    }
  )

  test.each([false, true])(
    'keeps refresh available after every plugin source fails and recovers (warm cache: %s)',
    async warm => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({ deviceAutoSyncSucceeds: true })
      mockCodexAppServerInvoke({
        marketplaces: [
          {
            name: 'custom-local',
            path: '/tmp/custom-local',
            plugins: [
              {
                ...defaultCodexPlugin,
                id: 'local-1',
                name: 'local-docs',
                displayName: 'Local Docs',
              },
            ],
          },
        ],
        installedPluginNames: ['local-docs'],
      })
      let unavailable = !warm
      const recoveryEvents: string[] = []
      const fetchHealthy = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation((input, init) => {
        const url = new URL(String(input), 'http://localhost')
        const path = url.pathname
        if (
          unavailable &&
          (path === '/api/plugins/marketplace' || path === '/api/plugins/installed')
        )
          return Promise.reject(new Error('Cloud plugin sources unavailable'))
        if (path === '/api/plugins/installed/sync-device' && url.searchParams.get('reconcile'))
          recoveryEvents.push('reconcile')
        return fetchHealthy(input, init)
      })
      const invokeHealthy = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
        const appServerMethod = (args as { method?: string })?.method
        if (
          unavailable &&
          ([
            'executor.plugins.store.list',
            'executor.plugins.personal.list',
            'executor.codex_home.config.read',
          ].includes(method) ||
            (method === 'codex.app_server_request' &&
              ['plugin/list', 'plugin/installed'].includes(appServerMethod ?? '')))
        )
          return Promise.reject(new Error('Local plugin sources unavailable'))
        if (method === 'codex.app_server_request' && appServerMethod === 'plugin/list')
          recoveryEvents.push('catalog')
        if (method === 'executor.plugins.store.list')
          return Promise.resolve(invokeHealthy(method, args)).then(inventory => ({
            ...(inventory as Record<string, unknown>),
            supportsPluginReconciliation: true,
          }))
        return invokeHealthy(method, args)
      })
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      const refresh = screen.getByTestId('plugins-refresh-button')
      if (warm) {
        expect(await screen.findByText('Local Docs')).toBeInTheDocument()
        await waitFor(() => expect(refresh).not.toBeDisabled())
        unavailable = true
        await userEvent.click(refresh)
      }

      expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
        'data-notice-kind',
        'error'
      )
      await waitFor(() => expect(refresh).not.toBeDisabled())
      expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
      if (warm) {
        expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
        expect(screen.getByText('Local Docs')).toBeInTheDocument()
      }

      recoveryEvents.length = 0
      unavailable = false
      await userEvent.click(refresh)

      expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
      expect(await screen.findByText('Local Docs')).toBeInTheDocument()
      await waitFor(() => expect(refresh).not.toBeDisabled())
      await waitFor(() =>
        expect(
          screen.queryByTestId('plugin-operation-notice')?.getAttribute('data-notice-kind'),
          screen.queryByTestId('plugin-operation-notice')?.textContent
        ).not.toBe('error')
      )
      expect(recoveryEvents.filter(event => event === 'reconcile')).toHaveLength(1)
      expect(recoveryEvents.slice(recoveryEvents.indexOf('reconcile'))).toEqual([
        'reconcile',
        'catalog',
      ])
    }
  )

  test('retains a failed cloud catalog and clears only cloud rows after an empty successful refresh', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch()
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'custom-local',
          path: '/tmp/custom-local',
          plugins: [
            { ...defaultCodexPlugin, id: 'local-1', name: 'local-docs', displayName: 'Local Docs' },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    expect(await screen.findByText('Local Docs')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let fail = true
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/plugins/marketplace')
        return fail
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(
              new Response(JSON.stringify({ items: [] }), {
                headers: { 'Content-Type': 'application/json' },
              })
            )
      return originalFetch(input, init)
    })
    await userEvent.click(screen.getByTestId('plugins-refresh-button'))
    await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
    expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(screen.getByText('Local Docs')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByTestId('plugins-refresh-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-marketplace-row-101')).not.toBeInTheDocument()
    )
    expect(screen.getByText('Local Docs')).toBeInTheDocument()
  })

  test.each(['marketplace', 'installed'])(
    'keeps healthy rows when the device-scoped cloud %s pass fails',
    async endpoint => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const marketplace = mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceDeviceState: 'installed',
        marketplaceSourceProvider: 'wegent',
        deviceAutoSyncSucceeds: false,
      })
      mockCodexAppServerInvoke({
        marketplaces: [
          {
            name: 'custom-local',
            path: '/tmp/custom-local',
            plugins: [
              {
                ...defaultCodexPlugin,
                id: 'local-1',
                name: 'local-docs',
                displayName: 'Local Docs',
              },
            ],
          },
        ],
      })
      localExecutorMocks.knownDeviceId = null
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let scopedFailures = 0
      vi.mocked(fetch).mockImplementation((input, init) => {
        const url = new URL(String(input), 'http://localhost')
        if (
          url.pathname === `/api/plugins/${endpoint}` &&
          url.searchParams.get('device_id') === 'current-device'
        ) {
          scopedFailures += 1
          return Promise.reject(new Error('device pass unavailable'))
        }
        return originalFetch(input, init)
      })
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      expect(await screen.findByText('Local Docs')).toBeInTheDocument()
      await waitFor(() => expect(scopedFailures).toBeGreaterThan(0))
      expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
      expect(screen.getByTestId('plugins-installed-strip-item-101')).toBeInTheDocument()
      expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
        'data-notice-kind',
        'error'
      )
      expect(marketplace.getSyncDeviceCalls()).toBe(0)
      expect(marketplace.getReportDeviceCalls()).toBe(0)
    }
  )

  test.each([null, undefined, 'plain failure'])(
    'shows installation failure for non-object rejection %s',
    async rejection => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch()
      mockCodexAppServerInvoke()
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation((input, init) =>
        String(input).includes('/plugins/marketplace/101/install')
          ? Promise.reject(rejection)
          : originalFetch(input, init)
      )
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await screen.findByTestId('plugin-marketplace-install-101')
      await installPluginFromMarketCard('plugin-marketplace-install-101')
      expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
        'data-notice-kind',
        'error'
      )
      await waitFor(() =>
        expect(screen.getByTestId('plugin-marketplace-install-101')).not.toBeDisabled()
      )
    }
  )

  test('HTTP installation works without a device id or cloud registration', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: false })
    const fixture = mockSystemSkillsFetch()
    mockCodexAppServerInvoke({ deviceId: '', backendConnected: false })
    const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
    vi.mocked(requestLocalExecutor).mockImplementation(async (method, params) => {
      if (method !== 'executor.plugins.local_sync') return original(method, params)
      const request = params as { probeOnly?: boolean; action?: string }
      if (request.probeOnly) return { enabled: true, protocolVersion: 1 }
      fixture.setMarketplaceInstallation(true, 'installed')
      const inventory = await (await fetch('/api/plugins/installed')).json()
      return {
        enabled: true,
        protocolVersion: 1,
        localCompleted: true,
        operation: {
          plugin: inventory.items.find((item: InstalledPlugin) => item.spec.pluginId === 101),
        },
        result: {
          scope: 'plugin_delta',
          plugins: [{ id: 101, status: 'synced', version: '1.0.0' }],
        },
      }
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await screen.findByTestId('plugin-marketplace-install-101')
    await installPluginFromMarketCard('plugin-marketplace-install-101')
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith(
        'executor.plugins.local_sync',
        expect.objectContaining({ action: 'install', targetId: 101 })
      )
    )
    expect(await screen.findByTestId('plugin-marketplace-actions-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'success'
    )
    expect(
      vi
        .mocked(requestLocalExecutor)
        .mock.calls.some(([method]) => method === 'executor.plugins.device_route')
    ).toBe(false)
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/install'))
    ).toBe(false)
  })

  test.each([
    ['plugin_route_profile_mismatch', '本机运行环境已变化'],
    ['plugin_local_http_unavailable', '暂时无法连接服务'],
  ])(
    'shows capability preflight errors without submitting an install: %s',
    async (code, message) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockCodexAppServerInvoke({ backendConnected: false })
      const invoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
        if (method === 'executor.plugins.local_sync') {
          return Promise.reject(Object.assign(new Error(code), { code }))
        }
        return invoke(method, params)
      })
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))
      const notice = await screen.findByTestId('plugin-operation-notice')
      expect(notice).toHaveAttribute('data-notice-kind', 'error')
      expect(notice).toHaveTextContent(message)
      expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/install'))
      ).toBe(false)
    }
  )

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
    expect(notice).toHaveClass('electron-titlebar-interactive-region')
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/install'))
    ).toBe(false)
    expect(window.location.pathname).toBe('/')

    await userEvent.click(screen.getByTestId('plugin-operation-notice-dismiss'))
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))
    expect(await screen.findByTestId('plugin-operation-notice')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-operation-notice-action'))

    expect(window.location.pathname).toBe('/settings/connections')
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
  })

  test('clears a stale disconnected notice when the device reconnects', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: false })
    mockCodexAppServerInvoke({ backendConnected: false })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
      '当前设备未连接到云端'
    )

    act(() => {
      setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: true })
    })

    await waitFor(() =>
      expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
    )
  })

  test('uses the live executor device when plugin state has not loaded its device id', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({ backendConnected: true })
    localExecutorMocks.ensureStarted.mockResolvedValue({
      running: true,
      ready: true,
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))

    expect(await screen.findByTestId('install-plugin-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
    expect(requestLocalExecutor).toHaveBeenCalledWith('executor.backend.status')

    await userEvent.click(screen.getByTestId('install-plugin-dialog-confirm'))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace/101/install?device_id=current-device',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('已安装')
  })

  test('routes a cloud install to the runtime record while publishing stable device inventory', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const deviceId = 'electron-plugins'
    mockSystemSkillsFetch({ deviceId })
    mockCodexAppServerInvoke({ deviceId, deviceRouteId: 'app-record-70' })
    const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
    writePluginInventory(cacheKey, deviceId, { installedPlugins: [] })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await screen.findByTestId('plugin-marketplace-install-101')
    await waitFor(() => expect(getPluginMarketplaceCache(cacheKey)?.deviceId).toBe(deviceId))

    await installPluginFromMarketCard('plugin-marketplace-install-101')

    await waitFor(() =>
      expect(getPluginMarketplaceCache(cacheKey)?.installedPlugins).toHaveLength(1)
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace/101/install?device_id=app-record-70',
      expect.objectContaining({ method: 'POST' })
    )
    const inventory = getPluginMarketplaceCache(cacheKey)!
    expect(inventory.deviceId).toBe(deviceId)
    expect(
      inventory.marketplaceItems.find(item => item.id === 101)?.currentDeviceInstallation
    ).toEqual(expect.objectContaining({ deviceId, state: 'installed' }))
    expect(selectComposerPluginApps(inventory).some(app => app.pluginKey === 'documents')).toBe(
      true
    )
    expect(telemetryMocks.track).toHaveBeenCalledWith(
      'plugin_installed',
      expect.objectContaining({ source: 'cloud' })
    )
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('已安装')
  })

  test.each([
    ['install', false],
    ['install', true],
    ['try', false],
    ['try', true],
  ] as const)(
    'cancels a held %s device preflight after an account switch (return to original=%s)',
    async (entry, returnToOriginal) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch()
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await screen.findByTestId('plugin-marketplace-install-101')
      await waitFor(() =>
        expect(
          getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))
        ).not.toBeNull()
      )
      let finishPreflight!: () => void
      const preflightGate = new Promise<void>(resolve => {
        finishPreflight = resolve
      })
      let preflightHeld = false
      localExecutorMocks.ensureAvailable.mockImplementation(async options => {
        if (options?.refresh && !preflightHeld) {
          preflightHeld = true
          await preflightGate
          return {
            running: true,
            ready: true,
            deviceId: 'stale-preflight-device',
            deviceRouteId: 'stale-preflight-route',
          }
        }
        return {
          running: true,
          ready: true,
          deviceId: 'current-device',
          deviceRouteId: 'current-device',
        }
      })
      const observedDevices: Array<string | undefined> = []
      const unsubscribe = subscribePluginMarketplaceCache(snapshot => {
        observedDevices.push(snapshot?.deviceId)
      })
      try {
        if (entry === 'try') {
          await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
          await userEvent.click(await screen.findByTestId('plugin-prompt-0'))
        } else {
          await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))
        }
        await waitFor(() => expect(preflightHeld).toBe(true))
        expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()

        view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
        await waitFor(() =>
          expect(
            getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'another-account'))
          ).not.toBeNull()
        )
        if (returnToOriginal) {
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
          await screen.findByTestId('plugin-marketplace-install-101')
        }
        await act(async () => finishPreflight())

        expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
        expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
        expect(observedDevices).not.toContain('stale-preflight-device')
        expect(
          vi.mocked(fetch).mock.calls.some(([input, init]) => {
            const url = String(input)
            return (
              url.includes('stale-preflight-device') ||
              url.endsWith('/plugins/marketplace/101/owner') ||
              (url.includes('/plugins/marketplace/101/install') && init?.method === 'POST')
            )
          })
        ).toBe(false)
        expect(requestLocalExecutor).not.toHaveBeenCalledWith(
          'runtime.codex.plugin.install_local_first',
          expect.anything()
        )
        expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
      } finally {
        unsubscribe()
        view.unmount()
      }
    }
  )

  test('clears a pending plugin update confirmation when the account changes', async () => {
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    try {
      await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
      const action = await screen.findByTestId('plugin-detail-toggle-101')
      await waitFor(() => expect(action).toHaveTextContent('更新'))
      await userEvent.click(action)
      await screen.findByTestId('plugin-update-confirm-button')

      view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
      expect(screen.queryByTestId('plugin-update-confirm-button')).not.toBeInTheDocument()
      view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      expect(screen.queryByTestId('plugin-update-confirm-button')).not.toBeInTheDocument()
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([input, init]) =>
              String(input).includes('/plugins/installed/101') && init?.method === 'PUT'
          )
      ).toBe(false)
    } finally {
      view.unmount()
    }
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
      '/wework/executor/v1/plugin-image?path=%2FUsers%2Ftest%2Fplugins%2Fplugin-5%2Fassets%2Flogo.png'
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

  test('search reveals a local plugin outside the category preview without rereading catalogs', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ marketplaceCount: 20 })
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'custom-local',
          path: '/tmp/custom-local',
          plugins: [
            {
              ...defaultCodexPlugin,
              id: 'local-1',
              name: 'local-docs',
              displayName: 'Local Docs',
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await screen.findByTestId('plugins-marketplace-tab-custom-local')
    await waitFor(() =>
      expect(
        getPluginMarketplaceCache(
          pluginMarketplaceCacheKey('/api', 'cloud-token')
        )?.marketplaceItems.some(item => item.name === 'local-docs')
      ).toBe(true)
    )
    const localRow = 'plugin-marketplace-row-custom-local:local-1'
    expect(screen.getAllByTestId(/^plugin-marketplace-row-/)).toHaveLength(4)
    expect(screen.queryByTestId(localRow)).not.toBeInTheDocument()
    const cloudCatalogReads = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).startsWith('/api/plugins/marketplace')).length
    const localCatalogReads = () =>
      vi
        .mocked(requestLocalExecutor)
        .mock.calls.filter(
          ([method, args]) =>
            method === 'codex.app_server_request' &&
            (args as { method?: string })?.method === 'plugin/list'
        ).length
    const cloudReadsBeforeSearch = cloudCatalogReads()
    const localReadsBeforeSearch = localCatalogReads()
    expect(cloudReadsBeforeSearch).toBeGreaterThan(0)
    expect(localReadsBeforeSearch).toBeGreaterThan(0)

    fireEvent.change(screen.getByTestId('plugins-search-input'), {
      target: { value: 'Local Docs' },
    })

    expect(await screen.findByTestId(localRow)).toHaveTextContent('Local Docs')
    expect(cloudCatalogReads()).toBe(cloudReadsBeforeSearch)
    expect(localCatalogReads()).toBe(localReadsBeforeSearch)
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
    // The real virtualizer needs a non-zero scroll viewport in jsdom.
    const geometry = [
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(88),
    ]
    try {
      mockSystemSkillsFetch({ marketplaceCount: 80 })
      render(<PluginsWorkspace />)

      expect(await screen.findByText('Documents')).toBeInTheDocument()
      fireEvent.change(screen.getByTestId('plugins-search-input'), {
        target: { value: 'plugin' },
      })

      await waitFor(() =>
        expect(screen.getAllByTestId(/^plugin-marketplace-row-/)).toHaveLength(40)
      )

      await userEvent.click(screen.getByTestId('plugins-category-more-all'))

      await waitFor(() =>
        expect(screen.queryByTestId('plugins-category-more-all')).not.toBeInTheDocument()
      )
      expect(screen.getAllByTestId(/^plugin-marketplace-row-/).length).toBeGreaterThan(0)
      expect(screen.queryByTestId('plugins-category-browse-dialog')).not.toBeInTheDocument()
    } finally {
      geometry.forEach(mock => mock.mockRestore())
    }
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

  test('shows OpenAI loading while a fresh non-official cache is being completed', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    window.localStorage.setItem(
      'wework.plugins.codexCatalog.v1',
      JSON.stringify({
        version: 2,
        entries: {
          '|all|all-kinds': {
            paramsKey: '|all|all-kinds',
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
    mockKnownExecutorDevice('local-device')
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
      'wework.plugins.codexCatalog.v1',
      JSON.stringify({
        version: 1,
        entries: {
          '|all|all-kinds': {
            paramsKey: '|all|all-kinds',
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

    let resolveLocalList: ((value: unknown) => void) | null = null
    let unrestrictedPluginListStarted = false
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
        params?: { marketplaceKinds?: string[] }
      }
      if (request.method === 'plugin/list') {
        if (request.params?.marketplaceKinds == null) {
          unrestrictedPluginListStarted = true
          return new Promise(() => undefined)
        }
        return new Promise(resolve => {
          resolveLocalList = resolve
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
    // Stale durable rows remain visible while remote discovery is pending.
    // Opening the official tab requests the default remote catalog separately.
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-refresh-button')).toBeDisabled()
    await waitFor(() => expect(resolveLocalList).not.toBeNull())
    expect(unrestrictedPluginListStarted).toBe(true)

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
    expect(unrestrictedPluginListStarted).toBe(true)
  })

  test('replaces canonical inventory membership when live plugin/installed confirms absence', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    seedDurableOpenAiGithubPeek({ seedInventory: true })

    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'local_executor_ensure_started') {
        return Promise.resolve({ running: true, ready: true, deviceId: 'local-device' })
      }
      if (command === 'executor.plugins.links.list') {
        return Promise.resolve([])
      }
      if (command === 'executor.plugins.store.list')
        return Promise.resolve({ storePath: '', plugins: [] })
      if (command === 'executor.plugins.personal.list')
        return Promise.resolve({ marketplacePath: '', plugins: [] })
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
    await waitFor(() => {
      expect(
        screen.queryByTestId('plugins-installed-strip-item-github@openai-curated-remote')
      ).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('plugins-installed-strip-empty')).toBeInTheDocument()
    expect(
      screen.getByTestId('plugin-marketplace-install-github@openai-curated-remote')
    ).toBeInTheDocument()
  })

  test('removes stale OpenAI installed membership when live plugin/installed only returns bundled', async () => {
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
    seedDurableOpenAiGithubPeek({ seedInventory: true })

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
        screen.queryByTestId('plugins-installed-strip-item-github@openai-curated-remote')
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByTestId('plugin-marketplace-install-github@openai-curated-remote')
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
    mockKnownExecutorDevice('local-device')
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
      'wework.plugins.codexCatalog.v1',
      JSON.stringify({
        version: 1,
        entries: {
          '|all|all-kinds': {
            paramsKey: '|all|all-kinds',
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
    expect(screen.getByTestId('plugins-refresh-button')).toBeDisabled()
  })

  test('loads OpenAI independently of personal disk discovery and offers retry after a blocked request', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch()
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
    let remoteReads = 0
    vi.mocked(requestLocalExecutor).mockImplementation((command, args) => {
      if (command === 'executor.plugins.personal.list') return new Promise(() => {})
      const request = args as
        | { method?: string; params?: { marketplaceKinds?: string[] } }
        | undefined
      if (
        command === 'codex.app_server_request' &&
        request?.method === 'plugin/list' &&
        request.params?.marketplaceKinds == null
      ) {
        remoteReads += 1
        return remoteReads === 1
          ? Promise.reject(new Error('403 Forbidden <html>Cloudflare challenge-secret</html>'))
          : Promise.resolve({ marketplaces: [] })
      }
      return previousInvoke(command, args)
    })
    render(<PluginsWorkspace />)
    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    expect(await screen.findByTestId('plugins-openai-catalog-error')).toHaveTextContent('拦截')
    expect(screen.queryByText(/challenge-secret/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-openai-official-empty')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-openai-catalog-retry'))
    await waitFor(() =>
      expect(screen.queryByTestId('plugins-openai-catalog-error')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
    expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(remoteReads).toBe(2)
  })

  test.each([
    ['focus', 'unavailable', 'local'],
    ['focus', 'malformed', 'local'],
    ['focus', 'empty', 'local'],
    ['sync', 'unavailable', 'local'],
    ['sync', 'malformed', 'local'],
    ['sync', 'empty', 'local'],
    ['focus', 'unavailable', 'owned'],
    ['focus', 'malformed', 'owned'],
    ['focus', 'empty', 'owned'],
    ['sync', 'unavailable', 'owned'],
    ['sync', 'malformed', 'owned'],
    ['sync', 'empty', 'owned'],
    ['focus', 'recipient', 'owned'],
    ['focus', 'different-id', 'owned'],
    ['focus', 'legacy-case', 'owned'],
    ['sync', 'legacy-case', 'owned'],
  ] as const)(
    'refreshes cloud state independently of a %s personal disk read that is %s (%s source)',
    async (refreshKind, diskReadState, sourceKind) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      let finishSync!: () => void
      const syncGate = new Promise<void>(resolve => {
        finishSync = resolve
      })
      const marketplace = mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceDeviceState: refreshKind === 'sync' ? 'pending' : 'installed',
        marketplaceCount: 2,
        deviceAutoSyncSucceeds: true,
        deviceAutoSyncGate: syncGate,
        ...(sourceKind === 'owned'
          ? {
              marketplaceName: 'offline-notes',
              marketplaceDisplayName: 'Offline Notes',
              marketplaceVisibility: 'personal',
              marketplaceSourceProvider: 'user',
              marketplaceAccessRole: 'owner',
            }
          : {}),
      })
      const sourcePluginName = diskReadState === 'legacy-case' ? 'Offline-Notes' : 'offline-notes'
      const personal = mockPersonalRefreshInventory(sourcePluginName)
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let cloudChanged = false
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const response = await originalFetch(input, init)
        if (
          !cloudChanged ||
          new URL(String(input), 'http://localhost').pathname !== '/api/plugins/marketplace'
        ) {
          return response
        }
        const payload = (await response.json()) as { items: PluginMarketplaceItem[] }
        return Response.json({
          ...payload,
          items: payload.items.map(item => ({
            ...item,
            description: 'Cloud catalog refreshed',
            version: '2.0.0',
            ...(item.id === 101 && diskReadState === 'recipient'
              ? { accessRole: 'recipient' }
              : {}),
            ...(item.id === 101 && diskReadState === 'different-id' ? { id: 199 } : {}),
            ...(item.id === 102
              ? {
                  installed: true,
                  installedPluginId: 902,
                  currentDeviceInstallation: {
                    ...payload.items[0].currentDeviceInstallation!,
                    state: 'installed',
                  },
                }
              : {}),
          })),
        })
      })
      const warn = vi.spyOn(console, 'warn')
      const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
      writePluginInventory(cacheKey, 'current-device', { installedPlugins: [] })
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      let unsubscribe: () => void = () => undefined
      try {
        await waitFor(() => {
          expect(getPluginMarketplaceCache(cacheKey)?.deviceId).toBe('current-device')
          const source = getPluginMarketplaceCache(cacheKey)?.marketplaceItems.find(
            item => item.name === 'offline-notes'
          )
          expect(source).toBeDefined()
          if (sourceKind === 'owned') {
            expect(source?.localPersonalSource).toEqual({
              marketplacePath: '/tmp/wework-personal',
              pluginName: sourcePluginName,
            })
          }
        })
        const source = getPluginMarketplaceCache(cacheKey)!.marketplaceItems.find(
          item => item.name === 'offline-notes'
        )!
        const refreshedSources: PluginMarketplaceItem[] = []
        unsubscribe = subscribePluginMarketplaceCache(snapshot => {
          const refreshed = snapshot?.marketplaceItems.find(item => item.id === 101)
          if (
            snapshot?.cacheKey === cacheKey &&
            refreshed?.description === 'Cloud catalog refreshed'
          ) {
            refreshedSources.push(refreshed)
          }
        })
        if (refreshKind === 'sync') {
          await waitFor(() => expect(marketplace.getSyncDeviceCalls()).toBe(1))
        } else {
          await waitFor(() =>
            expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled()
          )
        }
        personal.setDiskReadState(
          diskReadState === 'recipient' ||
            diskReadState === 'different-id' ||
            diskReadState === 'legacy-case'
            ? 'unavailable'
            : diskReadState
        )
        cloudChanged = true
        if (refreshKind === 'sync') await act(async () => finishSync())
        else fireEvent.focus(window)

        await waitFor(() => {
          const inventory = getPluginMarketplaceCache(cacheKey)!
          const refreshedCloud = inventory.marketplaceItems.find(
            item => item.id === (diskReadState === 'different-id' ? 199 : 101)
          )
          expect(refreshedCloud?.description).toBe('Cloud catalog refreshed')
          expect(inventory.marketplaceItems.find(item => item.id === 102)).toEqual(
            expect.objectContaining({ installed: true, installedPluginId: 902 })
          )
          expect(inventory.installedPlugins.find(plugin => plugin.spec.pluginId === 101)).toEqual(
            expect.objectContaining({
              spec: expect.objectContaining({ installState: 'installed' }),
            })
          )
          if (sourceKind === 'owned') {
            if (
              diskReadState === 'empty' ||
              diskReadState === 'recipient' ||
              diskReadState === 'different-id'
            ) {
              expect(refreshedCloud?.localPersonalSource).toBeUndefined()
              expect(refreshedCloud?.version).toBe('2.0.0')
            } else {
              expect(refreshedCloud).toEqual(
                expect.objectContaining({
                  version: source.version,
                  sharedVersion: '2.0.0',
                  localPersonalSource: source.localPersonalSource,
                })
              )
            }
          } else {
            const personalSource = inventory.marketplaceItems.find(
              item => item.name === source.name
            )
            if (diskReadState === 'empty') expect(personalSource).toBeUndefined()
            else {
              expect(personalSource).toEqual(
                expect.objectContaining({
                  name: source.name,
                  version: source.version,
                  manifest: expect.objectContaining({
                    marketplaceId: 'wework-personal',
                    marketplacePath: '/tmp/wework-personal',
                  }),
                })
              )
            }
          }
        })
        if (diskReadState !== 'empty') {
          expect(warn).toHaveBeenCalledWith(
            '[Wework] personal marketplace refresh incomplete; retaining existing source rows',
            diskReadState === 'malformed'
              ? expect.objectContaining({ message: 'Invalid personal plugin source inventory' })
              : personal.diskError
          )
        }
        if (
          sourceKind === 'owned' &&
          diskReadState !== 'empty' &&
          diskReadState !== 'recipient' &&
          diskReadState !== 'different-id'
        ) {
          expect(refreshedSources.length).toBeGreaterThan(0)
          for (const refreshed of refreshedSources) {
            expect(refreshed).toEqual(
              expect.objectContaining({
                version: source.version,
                sharedVersion: '2.0.0',
                localPersonalSource: source.localPersonalSource,
              })
            )
          }
        }
      } finally {
        unsubscribe()
        finishSync()
        view.unmount()
        warn.mockRestore()
      }
    }
  )

  test.each([
    ['focus', false],
    ['focus', true],
    ['sync', false],
    ['sync', true],
  ] as const)(
    'discards a held %s cloud refresh after switching account (return to original=%s)',
    async (refreshKind, returnToOriginal) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      let finishSync!: () => void
      const syncGate = new Promise<void>(resolve => {
        finishSync = resolve
      })
      const marketplace = mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceDeviceState: refreshKind === 'sync' ? 'pending' : 'installed',
        deviceAutoSyncSucceeds: true,
        deviceAutoSyncGate: syncGate,
      })
      mockPersonalRefreshInventory()
      let accountLabel = 'initial-account'
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const requestAccount = accountLabel
        const response = await originalFetch(input, init)
        if (new URL(String(input), 'http://localhost').pathname !== '/api/plugins/marketplace') {
          return response
        }
        const payload = (await response.json()) as { items: PluginMarketplaceItem[] }
        return Response.json({
          ...payload,
          items: payload.items.map(item => ({ ...item, description: requestAccount })),
        })
      })
      const originalDiskRead = codexPlugins.listPersonalMarketplacePluginsFromDisk
      let finishDiskRead!: () => void
      const diskGate = new Promise<void>(resolve => {
        finishDiskRead = resolve
      })
      let diskReadHeld = false
      let holdNextDiskRead = false
      const diskError = new Error('Old account disk read failed')
      const diskRead = vi
        .spyOn(codexPlugins, 'listPersonalMarketplacePluginsFromDisk')
        .mockImplementation(async requireComplete => {
          if (requireComplete && holdNextDiskRead) {
            holdNextDiskRead = false
            diskReadHeld = true
            await diskGate
            throw diskError
          }
          return originalDiskRead(requireComplete)
        })
      const warn = vi.spyOn(console, 'warn')
      const oldCacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
      writePluginInventory(oldCacheKey, 'current-device', { installedPlugins: [] })
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      let unsubscribe: () => void = () => undefined
      try {
        await waitFor(() => {
          const inventory = getPluginMarketplaceCache(oldCacheKey)
          expect(inventory?.deviceId).toBe('current-device')
          expect(
            inventory?.marketplaceItems.find(item => item.name === 'offline-notes')
          ).toBeDefined()
        })
        if (refreshKind === 'sync') {
          await waitFor(() => expect(marketplace.getSyncDeviceCalls()).toBe(1))
        } else {
          await waitFor(() =>
            expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled()
          )
        }
        accountLabel = 'stale-account-refresh'
        holdNextDiskRead = true
        if (refreshKind === 'sync') await act(async () => finishSync())
        else fireEvent.focus(window)
        await waitFor(() => expect(diskReadHeld).toBe(true))

        accountLabel = 'new-account-refresh'
        view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
        await waitFor(() =>
          expect(
            getPluginMarketplaceCache(
              pluginMarketplaceCacheKey('/api', 'another-account')
            )?.marketplaceItems.find(item => item.id === 101)?.description
          ).toBe('new-account-refresh')
        )
        if (returnToOriginal) {
          accountLabel = 'returned-account-refresh'
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        }
        const currentCacheKey = returnToOriginal
          ? oldCacheKey
          : pluginMarketplaceCacheKey('/api', 'another-account')
        await waitFor(() =>
          expect(
            getPluginMarketplaceCache(currentCacheKey)?.marketplaceItems.find(
              item => item.id === 101
            )?.description
          ).toBe(accountLabel)
        )
        const observedDescriptions: Array<string | undefined> = []
        unsubscribe = subscribePluginMarketplaceCache(snapshot => {
          if (snapshot?.cacheKey === currentCacheKey) {
            observedDescriptions.push(
              snapshot.marketplaceItems.find(item => item.id === 101)?.description
            )
          }
        })
        await act(async () => finishDiskRead())
        await waitFor(() =>
          expect(warn).toHaveBeenCalledWith(
            '[Wework] personal marketplace refresh incomplete; retaining existing source rows',
            diskError
          )
        )
        expect(
          getPluginMarketplaceCache(currentCacheKey)?.marketplaceItems.find(item => item.id === 101)
            ?.description
        ).toBe(accountLabel)
        expect(observedDescriptions).not.toContain('stale-account-refresh')
      } finally {
        unsubscribe()
        finishSync()
        finishDiskRead()
        view.unmount()
        diskRead.mockRestore()
        warn.mockRestore()
      }
    }
  )

  test.each([
    ['reconciles', 'initially unknown'],
    ['reconciles', 'initially unknown (same batch)'],
    ['reconciles', 'already bound'],
    ['cancels', 'changed since request'],
  ] as const)(
    '%s a manual refresh when device membership settles: %s device',
    async (outcome, initialDeviceScope) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const deviceId =
        initialDeviceScope === 'changed since request'
          ? 'replacement-device'
          : 'first-refresh-device'
      const initialDeviceId =
        initialDeviceScope === 'already bound' || initialDeviceScope === 'changed since request'
          ? 'first-refresh-device'
          : ''
      const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
      const marketplace = mockSystemSkillsFetch({ deviceId, deviceAutoSyncSucceeds: true })
      mockCodexAppServerInvoke({ deviceId })
      localExecutorMocks.knownDeviceId = null
      setPluginMarketplaceCache({
        cacheKey,
        marketplaceItems: [],
        installedPlugins: [],
        marketplaces: [],
        selectedMarketplaceKey: '',
        deviceId: initialDeviceId,
        fetchedAt: Date.now(),
      })

      let finishMembership!: (value: { marketplaces: [] }) => void
      const membership = new Promise<{ marketplaces: [] }>(resolve => {
        finishMembership = resolve
      })
      const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation((command, args) => {
        if (command === 'executor.plugins.store.list') {
          return Promise.resolve({
            storePath: '/tmp/store',
            plugins: [],
            supportsPluginReconciliation: true,
          })
        }
        if (
          command === 'codex.app_server_request' &&
          (args as { method?: string }).method === 'plugin/installed'
        ) {
          return membership
        }
        return previousInvoke(command, args)
      })

      let finishCloudRefresh!: () => void
      const cloudRefresh = new Promise<void>(resolve => {
        finishCloudRefresh = resolve
      })
      const previousFetch = vi.mocked(fetch).getMockImplementation()!
      let holdNextRefresh = false
      let manualCloudRefreshStarted = false
      vi.mocked(fetch).mockImplementation((...args) => {
        if (holdNextRefresh && String(args[0]).split('?')[0].endsWith('/api/plugins/marketplace')) {
          holdNextRefresh = false
          manualCloudRefreshStarted = true
          return cloudRefresh.then(() => previousFetch(...args))
        }
        return previousFetch(...args)
      })

      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await screen.findByTestId('plugin-marketplace-install-101')
        const refresh = screen.getByTestId('plugins-refresh-button')
        await waitFor(() => expect(refresh).toBeEnabled())
        expect(getPluginMarketplaceCache(cacheKey)?.deviceId).toBe(initialDeviceId)
        expect(marketplace.getSyncDeviceCalls()).toBe(0)

        holdNextRefresh = true
        await userEvent.click(refresh)
        await waitFor(() => expect(manualCloudRefreshStarted).toBe(true))
        if (initialDeviceScope === 'initially unknown (same batch)') {
          await act(async () => {
            finishMembership({ marketplaces: [] })
            finishCloudRefresh()
            await Promise.all([membership, cloudRefresh])
          })
        } else {
          await act(async () => {
            finishMembership({ marketplaces: [] })
            await membership
          })
          if (outcome === 'cancels') {
            expect(marketplace.getSyncDeviceCalls()).toBe(0)
            expect(refresh).toHaveAttribute('data-reconciliation-revision', '0')
          } else {
            await waitFor(() => expect(marketplace.getSyncDeviceCalls()).toBe(1))
          }

          await act(async () => {
            finishCloudRefresh()
            await cloudRefresh
          })
        }
        if (outcome === 'cancels') {
          await waitFor(() => expect(refresh).toBeEnabled())
          await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
              `/api/plugins/marketplace?device_id=${deviceId}`,
              expect.objectContaining({ method: 'GET' })
            )
          )
          expect(marketplace.getSyncDeviceCalls()).toBe(0)
          expect(refresh).toHaveAttribute('data-reconciliation-revision', '0')
          expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
          return
        }
        await waitFor(() =>
          expect({
            deviceId: getPluginMarketplaceCache(cacheKey)?.deviceId,
            syncDeviceCalls: marketplace.getSyncDeviceCalls(),
            reconciliationRevision: refresh.getAttribute('data-reconciliation-revision'),
          }).toEqual({
            deviceId,
            syncDeviceCalls: 1,
            reconciliationRevision: '1',
          })
        )
        expect(refresh).toBeEnabled()
        expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent(
          '插件安装状态已核对并同步'
        )
      } finally {
        await act(async () => {
          finishMembership({ marketplaces: [] })
          finishCloudRefresh()
          await Promise.all([membership, cloudRefresh])
        })
      }
    }
  )

  test.each(['cloud catalog', 'personal catalog'] as const)(
    'reconciles before an unrelated %s read settles and rejects its stale publication',
    async heldCatalog => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch()
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      let finishCatalog!: () => void
      const catalogGate = new Promise<void>(resolve => {
        finishCatalog = resolve
      })
      let finishReconciliation!: () => void
      const reconciliationGate = new Promise<void>(resolve => {
        finishReconciliation = resolve
      })
      const reconcile = vi
        .spyOn(refreshReconciliation, 'reconcilePluginRefresh')
        .mockReturnValue(reconciliationGate)
      const originalDiskRead = codexPlugins.listPersonalMarketplacePluginsFromDisk
      let holdNextCatalog = false
      let heldReadStarted = false
      let catalogVersion = 'initial catalog'
      const diskRead = vi
        .spyOn(codexPlugins, 'listPersonalMarketplacePluginsFromDisk')
        .mockImplementation(async (...args) => {
          const result = await originalDiskRead(...args)
          if (heldCatalog === 'personal catalog' && holdNextCatalog) {
            holdNextCatalog = false
            heldReadStarted = true
            await catalogGate
          }
          return result
        })
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (...args) => {
        const response = await originalFetch(...args)
        if (String(args[0]).split('?')[0].endsWith('/api/plugins/marketplace')) {
          const payload = (await response.json()) as { items: PluginMarketplaceItem[] }
          const items = payload.items.map(item => ({ ...item, description: catalogVersion }))
          if (heldCatalog === 'cloud catalog' && holdNextCatalog) {
            holdNextCatalog = false
            heldReadStarted = true
            await catalogGate
          }
          return Response.json({ ...payload, items })
        }
        return response
      })
      const observedDescriptions: Array<string | undefined> = []
      let unsubscribe = () => {}
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await screen.findByTestId('plugin-marketplace-install-101')
        const refresh = screen.getByTestId('plugins-refresh-button')
        await waitFor(() => expect(refresh).toBeEnabled())
        catalogVersion = 'stale catalog'
        holdNextCatalog = true
        await userEvent.click(refresh)
        await waitFor(() => expect(heldReadStarted).toBe(true))
        await waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
        expect(refresh).toBeDisabled()
        expect(refresh).toHaveAttribute('data-reconciling', 'true')

        catalogVersion = 'confirmed catalog'
        await act(async () => {
          finishReconciliation()
          await reconciliationGate
        })
        const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
        await waitFor(() =>
          expect(
            getPluginMarketplaceCache(cacheKey)?.marketplaceItems.find(item => item.id === 101)
              ?.description
          ).toBe('confirmed catalog')
        )
        unsubscribe = subscribePluginMarketplaceCache(snapshot => {
          if (snapshot?.cacheKey === cacheKey) {
            observedDescriptions.push(
              snapshot.marketplaceItems.find(item => item.id === 101)?.description
            )
          }
        })
        await act(async () => {
          finishCatalog()
          await catalogGate
        })
        await waitFor(() => expect(refresh).toBeEnabled())
        expect(refresh).toHaveAttribute('data-reconciliation-revision', '1')
        expect(
          getPluginMarketplaceCache(cacheKey)?.marketplaceItems.find(item => item.id === 101)
            ?.description
        ).toBe('confirmed catalog')
        expect(observedDescriptions).not.toContain('stale catalog')
      } finally {
        unsubscribe()
        await act(async () => {
          finishCatalog()
          finishReconciliation()
          await Promise.all([catalogGate, reconciliationGate])
        })
        diskRead.mockRestore()
        reconcile.mockRestore()
      }
    }
  )

  test.each(['local membership', 'cloud installed inventory'] as const)(
    'does not reconcile while required %s is pending or after it fails',
    async heldInventory => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch()
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const reconcile = vi
        .spyOn(refreshReconciliation, 'reconcilePluginRefresh')
        .mockResolvedValue(undefined)
      let finishInventory!: () => void
      const inventoryGate = new Promise<void>(resolve => {
        finishInventory = resolve
      })
      let holdNextInventory = false
      let heldReadStarted = false
      const holdAndFailInventory = async () => {
        holdNextInventory = false
        heldReadStarted = true
        await inventoryGate
        throw new Error('Required installed inventory unavailable')
      }
      const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation(async (command, args) => {
        if (
          holdNextInventory &&
          heldInventory === 'local membership' &&
          command === 'codex.app_server_request' &&
          (args as { method?: string }).method === 'plugin/installed'
        ) {
          return holdAndFailInventory()
        }
        return originalInvoke(command, args)
      })
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (...args) => {
        if (
          holdNextInventory &&
          heldInventory === 'cloud installed inventory' &&
          String(args[0]).split('?')[0].endsWith('/api/plugins/installed')
        ) {
          return holdAndFailInventory()
        }
        return originalFetch(...args)
      })
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await screen.findByTestId('plugin-marketplace-install-101')
        const refresh = screen.getByTestId('plugins-refresh-button')
        await waitFor(() => expect(refresh).toBeEnabled())
        holdNextInventory = true
        await userEvent.click(refresh)
        await waitFor(() => expect(heldReadStarted).toBe(true))
        expect(reconcile).not.toHaveBeenCalled()
        expect(refresh).toBeDisabled()
        await act(async () => {
          finishInventory()
          await inventoryGate
        })
        await waitFor(() => expect(refresh).toBeEnabled())
        expect(reconcile).not.toHaveBeenCalled()
        expect(refresh).toHaveAttribute('data-reconciliation-revision', '0')
        expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
          'data-notice-kind',
          'error'
        )
      } finally {
        await act(async () => {
          finishInventory()
          await inventoryGate
        })
        reconcile.mockRestore()
      }
    }
  )

  test('disables an open install dialog until a pending reconciliation settles', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch()
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    let finishReconciliation!: () => void
    const pendingReconciliation = new Promise<void>(resolve => {
      finishReconciliation = resolve
    })
    const reconcile = vi
      .spyOn(refreshReconciliation, 'reconcilePluginRefresh')
      .mockImplementation(options => {
        options.onProgress?.('syncing')
        return pendingReconciliation
      })
    let finishRefresh: (() => void) | undefined
    try {
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await screen.findByTestId('plugin-marketplace-install-101')
      await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).toBeEnabled())
      const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      let holdNextRefresh = true
      vi.mocked(requestLocalExecutor).mockImplementation(async (command, args) => {
        if (
          holdNextRefresh &&
          command === 'codex.app_server_request' &&
          (args as { method?: string }).method === 'plugin/installed'
        ) {
          holdNextRefresh = false
          await new Promise<void>(resolve => {
            finishRefresh = resolve
          })
        }
        return originalInvoke(command, args)
      })

      await userEvent.click(screen.getByTestId('plugins-refresh-button'))
      await waitFor(() => expect(finishRefresh).toBeDefined())
      await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))
      const confirm = await screen.findByTestId('install-plugin-dialog-confirm')
      expect(confirm).toBeEnabled()

      await act(async () => finishRefresh!())
      await waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
      expect(screen.getByTestId('plugins-refresh-button')).toHaveAttribute(
        'data-reconciling',
        'true'
      )
      expect(confirm).toBeDisabled()
      expect(screen.getByTestId('plugins-reconciliation-status')).toHaveAttribute(
        'data-stage',
        'syncing'
      )
      await userEvent.click(confirm)
      expect(screen.getByTestId('install-plugin-dialog')).toBeInTheDocument()
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).includes('/plugins/marketplace/101/install'))
      ).toBe(false)

      await act(async () => {
        finishReconciliation()
        await pendingReconciliation
      })
      await waitFor(() => expect(confirm).toBeEnabled())
      expect(hasAttemptedPluginDeviceAutoSync('current-device')).toBe(true)
      expect(hasSettledPluginDeviceAutoSync('current-device')).toBe(true)
      await userEvent.click(confirm)
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          '/api/plugins/marketplace/101/install?device_id=current-device',
          expect.objectContaining({ method: 'POST' })
        )
      )
      await waitFor(() =>
        expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
      )
      await waitFor(() =>
        expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('已安装')
      )
    } finally {
      await act(async () => {
        finishRefresh?.()
        finishReconciliation()
        await pendingReconciliation
      })
      reconcile.mockRestore()
    }
  })

  test.each([
    'same account',
    'different account',
    'returned account',
    'changed inventory',
  ] as const)(
    'keeps a pending manual reconciliation within its account scope: %s',
    async accountScope => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({ marketplaceInstalled: accountScope === 'changed inventory' })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      writePluginInventory(pluginMarketplaceCacheKey('/api', 'cloud-token'), 'current-device', {
        installedPlugins: [],
      })
      const reconcile = vi
        .spyOn(refreshReconciliation, 'reconcilePluginRefresh')
        .mockResolvedValue(undefined)
      if (accountScope === 'changed inventory') {
        reconcile.mockRejectedValue(new Error('PLUGIN_RUNTIME_METADATA_FAILED'))
      }
      let confirmedInventoryIds: string[] = []
      let finishRefresh!: () => void
      const refreshGate = new Promise<void>(resolve => {
        finishRefresh = resolve
      })
      let finishAccountLoad!: () => void
      const accountGate = new Promise<void>(resolve => {
        finishAccountLoad = resolve
      })
      try {
        const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
        await waitFor(() =>
          expect(getPluginMarketplaceCache('/api|cloud-token')?.deviceId).toBe('current-device')
        )
        const originalFetch = vi.mocked(fetch).getMockImplementation()!
        let holdNext = true
        let refreshStarted = false
        let holdAccountLoad = false
        let accountLoadStarted = false
        vi.mocked(fetch).mockImplementation(async (...args) => {
          if (holdNext && String(args[0]).split('?')[0].endsWith('/api/plugins/installed')) {
            holdNext = false
            refreshStarted = true
            await refreshGate
          }
          if (String(args[0]).split('?')[0].endsWith('/api/plugins/marketplace')) {
            if (holdAccountLoad) {
              accountLoadStarted = true
              await accountGate
            }
          }
          return originalFetch(...args)
        })
        await userEvent.click(screen.getByTestId('plugins-refresh-button'))
        await waitFor(() => expect(refreshStarted).toBe(true))
        if (accountScope === 'changed inventory') {
          const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
          const installed = getPluginMarketplaceCache(cacheKey)!.installedPlugins
          expect(installed.length).toBeGreaterThan(0)
          confirmedInventoryIds = installed.map(inventoryIdentity)
          writePluginInventory(
            cacheKey,
            'current-device',
            {
              installedPlugins: installed.map(plugin => ({
                ...plugin,
                spec: { ...plugin.spec, enabled: false },
              })),
            },
            { mutation: true }
          )
        } else if (accountScope !== 'same account') {
          holdAccountLoad = true
          view.rerender(
            <PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="different-account-token" />
          )
          await waitFor(() => expect(accountLoadStarted).toBe(true))
          if (accountScope === 'returned account') {
            holdAccountLoad = false
            view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
          }
        }
        await act(async () => {
          finishRefresh()
          finishAccountLoad()
          await Promise.all([refreshGate, accountGate])
        })
        await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
        if (accountScope === 'changed inventory') {
          await waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
          expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent(
            'PLUGIN_RUNTIME_METADATA_FAILED'
          )
          const confirmed = getPluginMarketplaceCache(
            pluginMarketplaceCacheKey('/api', 'cloud-token')
          )!.installedPlugins
          expect(confirmed.map(inventoryIdentity)).toEqual(confirmedInventoryIds)
          expect(confirmed.every(plugin => !plugin.spec.enabled)).toBe(true)
        } else if (accountScope === 'same account') {
          await waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
          expect(screen.getByTestId('plugins-refresh-button')).toHaveAttribute(
            'data-reconciliation-revision',
            '1'
          )
          expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent(
            '插件安装状态已核对并同步'
          )
        } else {
          expect(reconcile).not.toHaveBeenCalled()
          expect(screen.getByTestId('plugins-refresh-button')).toHaveAttribute(
            'data-reconciliation-revision',
            '0'
          )
          expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
        }
      } finally {
        await act(async () => {
          finishRefresh()
          finishAccountLoad()
          await Promise.all([refreshGate, accountGate])
        })
        reconcile.mockRestore()
      }
    }
  )

  test('resets policy saves across accounts without letting an old completion clear a new save', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    const installed = getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))!
      .installedPlugins[0]!
    const finishSaves: Array<() => void> = []
    const saveGates = [0, 1].map(() => new Promise<void>(resolve => finishSaves.push(resolve)))
    const read = vi.mocked(fetch).getMockImplementation()!
    let saveCount = 0
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/plugins/installed/101') && init?.method === 'PUT') {
        const gate = saveGates[saveCount++]
        await gate
        return new Response(
          JSON.stringify({
            ...installed,
            spec: { ...installed.spec, updatePolicy: 'auto' },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      }
      return read(input, init)
    })
    try {
      await userEvent.click(await screen.findByTestId('plugin-auto-update-toggle-101'))
      await waitFor(() => expect(saveCount).toBe(1))

      view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
      await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
      const toggle = await screen.findByTestId('plugin-auto-update-toggle-101')
      await waitFor(() => expect(toggle).toBeEnabled())
      await userEvent.click(toggle)
      expect(toggle).toBeDisabled()

      await act(async () => finishSaves[0]!())
      await waitFor(() => expect(saveCount).toBe(2))
      expect(toggle).toBeDisabled()
      expect(toggle).toHaveAttribute('aria-checked', 'false')

      await act(async () => finishSaves[1]!())
      await waitFor(() => expect(toggle).toBeEnabled())
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    } finally {
      view.unmount()
      await act(async () => finishSaves.forEach(finish => finish()))
    }
  })

  test('automatically updates cloud plugins in bounded serial batches', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplace = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'auto',
      autoUpdateBatchSizes: [1, 1, 1, 1, 1, 1],
      deviceAutoSyncSucceeds: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await waitFor(() => expect(marketplace.getAutoUpdateBatchCalls()).toBe(6))
    await waitFor(() => expect(marketplace.getSyncDeviceCalls()).toBe(6))
    expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('已自动更新 6 个插件')
    expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
      'data-notice-kind',
      'success'
    )
  })

  test('continues isolated plugin updates and shows the real failed stage', async () => {
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

    await waitFor(() => expect(marketplace.getAutoUpdateBatchCalls()).toBe(2))
    expect(marketplace.getSyncDeviceCalls()).toBe(2)
    expect(await screen.findByText(/插件自动更新失败/)).toHaveTextContent(
      'plugin-101 (写入 Codex 配置): still broken'
    )
  })

  test('shows a failed upgrade receipt without aggregate device counts', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'failed',
      marketplaceActualReleaseId: 1000,
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Codex App Server rejected install'
    )
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('更新')
    expect(screen.queryByText(/\d+ 失败/)).not.toBeInTheDocument()
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

  test('refreshes the runtime record for a manual upgrade and retains the composer inventory identity', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const deviceId = 'electron-plugins'
    const marketplace = mockSystemSkillsFetch({
      deviceId,
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke({ deviceId, deviceRouteId: 'app-record-70' })
    writePluginInventory(pluginMarketplaceCacheKey('/api', 'cloud-token'), deviceId, {
      installedPlugins: [],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    const before = getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))
    expect(before?.installedPlugins[0]?.spec.releaseId).toBe(1001)
    expect(before?.deviceId).toBe(deviceId)
    expect(selectComposerPluginApps(before!).some(app => app.pluginKey === 'documents')).toBe(true)
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).includes('/plugins/installed/101') && args[1]?.method === 'PUT') {
        const updated = {
          ...before!.installedPlugins[0],
          spec: { ...before!.installedPlugins[0].spec, releaseId: 1002, version: '1.1.0' },
          status: {
            ...before!.installedPlugins[0].status,
            devices: before!.installedPlugins[0].status.devices?.map(device => ({
              ...device,
              deviceId: 'app-record-71',
              desiredReleaseId: 1002,
              actualReleaseId: 1002,
            })),
          },
        }
        return { ok: true, status: 200, json: async () => updated } as Response
      }
      return originalFetch(...args)
    })
    marketplace.publishMarketplaceUpdate()
    fireEvent.focus(window)
    await waitFor(() =>
      expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('更新')
    )
    localExecutorMocks.ensureAvailable.mockImplementation(async options => {
      if (options?.refresh) localExecutorMocks.deviceRouteId = 'app-record-71'
      return {
        running: true,
        ready: true,
        deviceId,
        deviceRouteId: localExecutorMocks.deviceRouteId,
      }
    })
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    await userEvent.click(await screen.findByTestId('plugin-update-confirm-button'))
    await waitFor(() =>
      expect(
        getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))
          ?.installedPlugins[0]?.spec.releaseId
      ).toBe(1002)
    )
    expect(
      getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))?.mutationRevision
    ).toBeGreaterThan(before?.mutationRevision ?? 0)
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101?device_id=app-record-71',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ releaseId: 1002 }) })
    )
    const inventory = getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))!
    expect(inventory.deviceId).toBe(deviceId)
    expect(
      inventory.marketplaceItems.find(item => item.id === 101)?.currentDeviceInstallation
    ).toEqual(expect.objectContaining({ deviceId, state: 'installed', actualReleaseId: 1002 }))
    expect(selectComposerPluginApps(inventory).some(app => app.pluginKey === 'documents')).toBe(
      true
    )
    expect(screen.getByTestId('plugin-detail-actions-101')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
  })

  test('recovers a failed manual update without leaving a stale catalog error', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke()
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    const before = getPluginMarketplaceCache('/api|cloud-token')!.installedPlugins[0]
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let updateRequests = 0
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).includes('/plugins/installed/101') && init?.method === 'PUT') {
        updateRequests += 1
        if (updateRequests === 1) return Promise.reject(null)
        const updated = {
          ...before,
          spec: { ...before.spec, releaseId: 1002, version: '1.1.0' },
          status: {
            ...before.status,
            devices: before.status.devices.map(device => ({
              ...device,
              desiredReleaseId: 1002,
              actualReleaseId: 1002,
            })),
          },
        }
        return Promise.resolve(
          new Response(JSON.stringify(updated), { headers: { 'Content-Type': 'application/json' } })
        )
      }
      return originalFetch(input, init)
    })
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    await userEvent.click(await screen.findByTestId('plugin-update-confirm-button'))
    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('Unknown error')
    await waitFor(() => expect(screen.getByTestId('plugin-detail-toggle-101')).not.toBeDisabled())
    expect(updateRequests).toBe(1)
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    await userEvent.click(await screen.findByTestId('plugin-update-confirm-button'))
    await waitFor(() =>
      expect(
        getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins[0]?.spec.releaseId
      ).toBe(1002)
    )
    expect(updateRequests).toBe(2)
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('立即对话')
    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    expect(await screen.findByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-error')).not.toBeInTheDocument()

    // A later successful empty snapshot from another inventory reader must not
    // expose an unrelated update failure after that operation has recovered.
    const current = getPluginMarketplaceCache('/api|cloud-token')!
    act(() => setPluginMarketplaceCache({ ...current, installedPlugins: [], marketplaceItems: [] }))
    expect(await screen.findByText('没有匹配的插件')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-error')).not.toBeInTheDocument()
    expect(screen.queryByText('Unknown error')).not.toBeInTheDocument()
  })

  test('ignores repeated update actions while the connection check is pending', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdateAvailable: true,
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke()
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    const confirm = await screen.findByTestId('plugin-update-confirm-button')
    const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
    let finishConnection!: (value: { configured: boolean; connected: boolean }) => void
    const pendingConnection = new Promise(resolve => {
      finishConnection = resolve
    })
    let connectionReads = 0
    vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
      if (method === 'executor.backend.status') {
        connectionReads += 1
        return pendingConnection
      }
      return originalInvoke(method, args)
    })
    await userEvent.click(confirm)
    await waitFor(() => expect(connectionReads).toBe(1))
    await userEvent.click(screen.getByTestId('plugin-detail-toggle-101'))
    expect(connectionReads).toBe(1)
    await act(async () => finishConnection({ configured: true, connected: true }))
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) =>
              String(input).includes('/plugins/installed/101') && init?.method === 'PUT'
          )
      ).toHaveLength(1)
    )
    expect(screen.queryByTestId('plugin-update-confirm-button')).not.toBeInTheDocument()
  })

  test('uses the current installation identity when membership arrives after catalog detail', async () => {
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceUpdatePolicy: 'manual',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await screen.findByTestId('plugin-auto-update-toggle-101')
    const snapshot = getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))!
    const marketplaceItems = snapshot.marketplaceItems.map(item => ({
      ...item,
      installedPluginId: 707,
      version: '1.1.0',
      latestReleaseId: 1002,
    }))
    // The catalog and account membership settle independently during refresh.
    await act(async () => {
      setPluginMarketplaceCache({ ...snapshot, marketplaceItems, installedPlugins: [] })
    })
    await act(async () => {
      setPluginMarketplaceCache({
        ...snapshot,
        marketplaceItems,
        installedPlugins: snapshot.installedPlugins.map(plugin => ({
          ...plugin,
          metadata: { ...plugin.metadata, labels: { ...plugin.metadata.labels, id: '707' } },
          spec: { ...plugin.spec, releaseId: 1002, version: '1.1.0' },
        })),
      })
    })
    expect(screen.getByTestId('plugin-detail-actions-707')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-auto-update-toggle-707')).toBeInTheDocument()
  })

  test('keeps same-version reinstall loading until the latest receipt after an old removal settles', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplace = mockSystemSkillsFetch({ marketplaceInstalled: true })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let reinstallAccepted = false
    let receiptReads = 0
    let finishReceipt!: () => void
    const receiptGate = new Promise<void>(resolve => {
      finishReceipt = resolve
    })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost')
      if (reinstallAccepted && url.pathname === '/api/plugins/installed') {
        receiptReads += 1
        await receiptGate
      }
      const response = await originalFetch(input, init)
      if (url.pathname === '/api/plugins/marketplace/101/install') {
        const body = await response.json()
        body.plugin.spec.installState = 'installed'
        body.plugin.status.devices[0].state = 'pending'
        body.plugin.status.devices[0].actualReleaseId = 1001
        reinstallAccepted = true
        return { ...response, json: async () => body } as Response
      }
      return response
    })
    const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    try {
      await userEvent.click(await screen.findByTestId('plugin-marketplace-actions-101'))
      await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
      await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
      await screen.findByTestId('plugin-marketplace-install-101')
      marketplace.setMarketplaceInstallation(false, 'uninstalling')
      await installPluginFromMarketCard('plugin-marketplace-install-101')
      await waitFor(() => expect(receiptReads).toBeGreaterThan(0))
      const row = screen.getByTestId('plugin-marketplace-row-101')
      expect(row).toHaveTextContent('正在安装')
      expect(row).not.toHaveTextContent('正在卸载')
      expect(screen.queryByTestId('plugin-operation-notice')).not.toHaveTextContent(
        'Documents 已安装'
      )
      expect(marketplace.getSyncDeviceCalls()).toBe(0)
      marketplace.setMarketplaceInstallation(true, 'installed')
      await act(async () => finishReceipt())
      await screen.findByTestId('plugin-marketplace-actions-101')
      expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('Documents 已安装')
      expect(row).not.toHaveTextContent('正在卸载')
      expect(row).not.toHaveTextContent('正在安装')
    } finally {
      view.unmount()
      finishReceipt()
    }
  })

  test.each(['recover', 'switch-account', 'unconfirmed'] as const)(
    'preserves a committed install when receipt polling fails (%s)',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const marketplace = mockSystemSkillsFetch({ marketplaceDeviceState: 'pending' })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let accepted = false
      let installRequests = 0
      let receiptReads = 0
      let finishReceipt!: () => void
      const gate = new Promise<void>(resolve => {
        finishReceipt = resolve
      })
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const path = new URL(String(input), 'http://localhost').pathname
        if (accepted && path === '/api/plugins/installed') {
          receiptReads += 1
          if (outcome === 'unconfirmed' || receiptReads === 1) {
            return Response.json(
              { detail: 'Receipt temporarily unavailable' },
              { status: outcome === 'unconfirmed' ? 401 : 503 }
            )
          }
          await gate
        }
        const response = await originalFetch(input, init)
        if (path === '/api/plugins/marketplace/101/install') {
          installRequests += 1
          const body = await response.json()
          body.plugin.spec.installState = 'installed'
          accepted = true
          return { ...response, json: async () => body } as Response
        }
        return response
      })
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      try {
        await screen.findByTestId('plugin-marketplace-install-101')
        await installPluginFromMarketCard('plugin-marketplace-install-101')
        await waitFor(() => expect(receiptReads).toBeGreaterThan(0))
        const row = screen.getByTestId('plugin-marketplace-row-101')
        const committed = getPluginMarketplaceCache('/api|cloud-token')!
        expect(committed.installedPlugins).toHaveLength(1)
        expect(committed.marketplaceItems.find(item => item.id === 101)?.installed).toBe(true)
        if (outcome === 'unconfirmed') {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
            'Documents 已保存，暂未确认当前设备安装状态'
          )
          // A device-sync retry may be offered after polling stops; account
          // membership must survive and this must not become a fresh install.
          expect(getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins).toHaveLength(1)
          expect(
            getPluginMarketplaceCache('/api|cloud-token')?.marketplaceItems.find(
              item => item.id === 101
            )?.installed
          ).toBe(true)
          expect(row.querySelector('button[aria-label="安装 Documents"]')).toBeNull()
        } else {
          expect(row).toHaveTextContent('正在安装')
          expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
          await waitFor(() => expect(receiptReads).toBe(2), { timeout: 3000 })
          expect(row).toHaveTextContent('正在安装')
          expect(marketplace.getSyncDeviceCalls()).toBe(0)
          if (outcome === 'switch-account') {
            mockSystemSkillsFetch({
              cloudToken: 'account-b',
              marketplaceDisplayName: 'Other Account Documents',
            })
            view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="account-b" />)
            await screen.findByText('Other Account Documents')
          }
          marketplace.setMarketplaceInstallation(true, 'installed')
          await act(async () => finishReceipt())
          if (outcome === 'recover') {
            await screen.findByTestId('plugin-marketplace-actions-101')
            expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent(
              'Documents 已安装'
            )
            expect(marketplace.getSyncDeviceCalls()).toBe(0)
          } else {
            expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
            expect(screen.queryByTestId('plugin-marketplace-actions-101')).not.toBeInTheDocument()
            expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
            expect(getPluginMarketplaceCache('/api|account-b')?.installedPlugins).toHaveLength(0)
            expect(receiptReads).toBe(2)
          }
        }
        // Read retries must never repeat the account installation transaction.
        expect(installRequests).toBe(1)
      } finally {
        view.unmount()
        finishReceipt()
      }
    }
  )

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
    expect(ensurePythonMock).not.toHaveBeenCalled()
    expect(telemetryMocks.track).toHaveBeenCalledWith('plugin_installed', {
      source: 'cloud',
      plugin_distribution: 'official',
      plugin_id: 'default/documents',
    })
  })

  test.each(['pending', 'failed'] as const)(
    'installs a marketplace package while Python preparation is %s',
    async pythonState => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      if (pythonState === 'pending') {
        ensurePythonMock.mockImplementation(() => new Promise(() => {}))
      } else {
        ensurePythonMock.mockRejectedValue(new Error('Python download failed'))
      }
      mockSystemSkillsFetch()
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

      await screen.findByTestId('plugin-marketplace-install-101')
      await installPluginFromMarketCard('plugin-marketplace-install-101')

      await waitFor(() =>
        expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('Documents 已安装')
      )
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/marketplace/101/install?device_id=current-device',
        expect.objectContaining({ method: 'POST' })
      )
      expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
        'data-notice-kind',
        'success'
      )
      expect(ensurePythonMock).not.toHaveBeenCalled()
    }
  )

  test.each([false, true])(
    'defers background device synchronization until a foreground install settles (auto-update=%s)',
    async autoUpdate => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const marketplace = mockSystemSkillsFetch({
        marketplaceDeviceState: 'pending',
        deviceAutoSyncSucceeds: true,
        marketplaceUpdateAvailable: autoUpdate,
        marketplaceUpdatePolicy: 'auto',
        autoUpdateBatchSizes: [1],
      })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      let finishInstall!: () => void
      const installGate = new Promise<void>(resolve => {
        finishInstall = resolve
      })
      const fetchImplementation = vi.mocked(fetch).getMockImplementation()!
      let installResponseReady = false
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const response = await fetchImplementation(input, init)
        if (String(input).includes('/plugins/marketplace/101/install') && init?.method === 'POST') {
          installResponseReady = true
          await installGate
        }
        return response
      })
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      try {
        await screen.findByTestId('plugin-marketplace-install-101')
        await installPluginFromMarketCard('plugin-marketplace-install-101')
        await waitFor(() =>
          expect(fetch).toHaveBeenCalledWith(
            '/api/plugins/marketplace/101/install?device_id=current-device',
            expect.objectContaining({ method: 'POST' })
          )
        )
        const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
        await waitFor(() => expect(installResponseReady).toBe(true))
        const installed = await (
          await fetch('/api/plugins/installed?device_id=current-device')
        ).json()
        const inventory = getPluginMarketplaceCache(cacheKey)!
        await act(async () => {
          writePluginInventory(cacheKey, 'current-device', {
            installedPlugins: installed.items,
            marketplaceItems: inventory.marketplaceItems.map(item =>
              item.id !== 101
                ? item
                : {
                    ...item,
                    installed: true,
                    installedLocally: false,
                    installedPluginId: 101,
                    currentDeviceInstallation: {
                      deviceId: 'current-device',
                      desiredReleaseId: 1001,
                      actualReleaseId: null,
                      state: 'pending',
                      errorCode: null,
                      errorMessage: null,
                      attemptCount: 0,
                      lastSyncAt: null,
                      updatedAt: new Date().toISOString(),
                    },
                  }
            ),
          })
        })
        expect(marketplace.getSyncDeviceCalls()).toBe(0)
        expect(marketplace.getAutoUpdateBatchCalls()).toBe(0)
        // The in-flight backend install publishes its latest receipt. A second
        // sync request is not needed to finish the foreground operation.
        marketplace.setMarketplaceInstallation(true, 'installed')
        await act(async () => finishInstall())
        await screen.findByTestId('plugin-marketplace-actions-101')
        if (autoUpdate)
          await waitFor(() => expect(marketplace.getAutoUpdateBatchCalls()).toBeGreaterThan(0))
        else expect(marketplace.getSyncDeviceCalls()).toBe(0)
      } finally {
        await act(async () => finishInstall())
        view.unmount()
      }
    }
  )

  test('installs an account-managed plugin without opening a second local login', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceName: 'dingtalk',
      marketplaceDisplayName: '钉钉',
      marketplaceConnectorSlug: 'dingtalk',
      marketplaceConnectorLocal: true,
      marketplaceConnectorAccountAuth: true,
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      localConnectorAuthHealth: () => Promise.resolve({ status: 'need_login' }),
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await screen.findByTestId('plugin-marketplace-install-101')
    await installPluginFromMarketCard('plugin-marketplace-install-101')
    await waitFor(() =>
      expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('钉钉 已安装')
    )
    expect(screen.queryByTestId('local-connector-auth-dialog')).not.toBeInTheDocument()
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.local_connector_auth.start',
      expect.anything()
    )
  })

  test.each(['install', 'manage'] as const)(
    'does not restart Python preparation through login after a %s failure',
    async action => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceName: 'wiki',
        marketplaceDisplayName: 'Wiki',
        marketplaceConnectorSlug: 'wiki',
        marketplaceConnectorLocal: true,
        marketplaceInstalled: action === 'manage',
      })
      mockCodexAppServerInvoke({
        deviceId: 'current-device',
        localConnectorAuthHealth: async () => {
          throw Object.assign(new Error('Managed Python preparation failed'), {
            code: 'python_runtime_unavailable',
          })
        },
      })
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      if (action === 'install') {
        await screen.findByTestId('plugin-marketplace-install-101')
        await installPluginFromMarketCard('plugin-marketplace-install-101')
        await waitFor(() =>
          expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('Wiki 已安装')
        )
      } else {
        await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
        await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:wiki'))
        expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
          '插件 Python 环境准备失败'
        )
      }
      expect(screen.queryByTestId('local-connector-auth-dialog')).not.toBeInTheDocument()
      expect(requestLocalExecutor).not.toHaveBeenCalledWith(
        'runtime.local_connector_auth.start',
        expect.anything()
      )
    }
  )

  test.each([
    { name: 'catalog omits account auth', catalogAccountAuth: false, installedAuth: 'account' },
    { name: 'catalog retains account auth', catalogAccountAuth: true, installedAuth: 'local' },
    {
      name: 'catalog retains a removed connector',
      catalogAccountAuth: false,
      installedAuth: 'none',
    },
  ] as const)('uses installed connector configuration when $name', async scenario => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceConnectorSlug: 'mail',
      marketplaceConnectorLocal: true,
      marketplaceConnectorAccountAuth: scenario.catalogAccountAuth,
      installedMarketplaceConnectors:
        scenario.installedAuth === 'none'
          ? []
          : [
              {
                slug: 'mail',
                authPolicy: 'on_install',
                localAuth: {
                  kind: 'browser_oauth',
                  health: ['scripts/local-auth.sh', 'health'],
                  start: ['scripts/local-auth.sh', 'login'],
                  poll: [],
                },
                ...(scenario.installedAuth === 'account'
                  ? {
                      accountAuth: {
                        protocolVersion: 1,
                        credentialType: 'oauth2',
                        adapter: 'scripts/account-auth.py',
                      },
                    }
                  : {}),
              },
            ],
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      localConnectorAuthHealth: () => Promise.resolve({ status: 'need_login' }),
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await screen.findByTestId('plugin-marketplace-install-101')
    await installPluginFromMarketCard('plugin-marketplace-install-101')

    if (scenario.installedAuth === 'local') {
      expect(await screen.findByTestId('local-connector-auth-dialog')).toBeInTheDocument()
      await waitFor(() =>
        expect(requestLocalExecutor).toHaveBeenCalledWith(
          'runtime.local_connector_auth.start',
          expect.objectContaining({ pluginKey: 'documents', connectorSlug: 'mail' })
        )
      )
    } else {
      await waitFor(() =>
        expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('Documents 已安装')
      )
      expect(screen.queryByTestId('local-connector-auth-dialog')).not.toBeInTheDocument()
      expect(requestLocalExecutor).not.toHaveBeenCalledWith(
        'runtime.local_connector_auth.start',
        expect.anything()
      )
    }
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
    seedDurableOpenAiGithubPeek({
      includeGithubConnector: true,
      includeGmailInstall: true,
      seedInventory: true,
    })
    mockCodexAppServerInvoke({
      deviceId: 'local-device',
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          displayName: 'OpenAI',
          plugins: [
            {
              id: 'github@openai-curated-remote',
              remotePluginId: 'plugin_connector_1p_github',
              name: 'github',
              displayName: 'GitHub',
              description: 'Connect GitHub',
              category: 'Developer Tools',
              connectors: [githubConnectorComponent()],
            },
            {
              id: 'gmail@openai-curated-remote',
              remotePluginId: 'plugin_connector_1p_gmail',
              name: 'gmail',
              displayName: 'Gmail',
              description: 'Connect Gmail',
              category: 'Communication',
            },
          ],
        },
      ],
      installedPluginNames: ['github', 'gmail'],
      localConnectorAuthHealth: async () => ({ status: 'need_login' }),
    })
    mockEmptyCloudPluginApis()
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

    expect(await screen.findByTestId('plugin-github-cli-auth-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('github-cli-login')).toBeInTheDocument()
    expectCodexAppServerRequestNotCalled('app/list')
    expect(authorizeWegentConnector).not.toHaveBeenCalled()
    expect(listWegentConnectorApps).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('connector-auth-cancel'))
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent('已取消授权')

    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-gmail@openai-curated-remote')
    )
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-row-github@openai-curated-remote'))
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent('已取消授权')
  })

  async function openGithubConnection(
    health: () => Promise<unknown>,
    logout?: () => Promise<unknown>,
    clickManage = true
  ) {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          plugins: [
            {
              id: 'github@openai-curated-remote',
              name: 'github',
              displayName: 'GitHub',
              connectors: [githubConnectorComponent()],
            },
          ],
        },
      ],
      installedPluginNames: ['github'],
      localConnectorAuthHealth: health,
      localConnectorAuthLogout: logout,
    })
    mockEmptyCloudPluginApis()
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-github@openai-curated-remote')
    )
    if (clickManage)
      await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:github'))
  }

  test('keeps an installed GitHub plugin installed when inventory refreshes during login consent', async () => {
    await openGithubConnection(async () => ({ status: 'need_login' }))
    expect(await screen.findByTestId('plugin-github-cli-auth-dialog')).toBeInTheDocument()
    await act(async () => {
      window.dispatchEvent(new Event(PLUGIN_AUTO_UPDATE_COMPLETED_EVENT))
    })
    await userEvent.click(screen.getByTestId('connector-auth-cancel'))
    await waitFor(() => {
      const manage = screen.getByTestId('plugin-connection-manage-connector:github')
      expect(manage).toHaveTextContent(/^登录$/)
      expect(manage).toBeEnabled()
    })
  })

  test('uses the shared logout row for an already connected GitHub CLI account', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const health = vi.fn().mockResolvedValue({ status: 'ok' })
    await openGithubConnection(health)

    const button = screen.getByTestId('plugin-connection-manage-connector:github')
    await waitFor(() => expect(button).toHaveTextContent('退出登录'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('终端中共享的 gh 账号'))
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.local_connector_auth.logout',
      expect.anything()
    )
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    expectCodexAppServerRequestNotCalled('app/list')
    expect(authorizeWegentConnector).not.toHaveBeenCalled()
    expect(listWegentConnectorApps).not.toHaveBeenCalled()
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.local_connector_auth.start',
      expect.anything()
    )

    await userEvent.click(screen.getByTestId('plugin-connection-manage-connector:github'))
    expect(health).toHaveBeenCalledOnce()
    health.mockResolvedValue({ status: 'error', errorCode: 'gh_health_failed' })
    await userEvent.click(screen.getByTestId('plugin-connection-manage-connector:github'))
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
    expect(health).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
  })

  test.each(['focus:error', 'focus:throw', 'auth:error', 'auth:throw'])(
    'preserves a connected GitHub account and offline logout after refresh failure: %s',
    async variant => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const health = vi.fn().mockResolvedValue({ status: 'ok' })
      const logout = vi.fn().mockResolvedValue({ status: 'ok', connected: false })
      await openGithubConnection(health, logout, false)
      const button = screen.getByTestId('plugin-connection-manage-connector:github')
      await waitFor(() => expect(button).toHaveTextContent(/^退出登录$/))
      if (variant.endsWith('throw')) health.mockRejectedValue(new Error('Network unavailable'))
      else health.mockResolvedValue({ status: 'error', errorCode: 'gh_health_failed' })
      act(() => {
        if (variant.startsWith('focus')) window.dispatchEvent(new Event('focus'))
        else clearLocalConnectorAuthHealthCache()
      })
      expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
        variant.endsWith('throw') ? 'Network unavailable' : '无法验证 GitHub CLI 登录状态'
      )
      expect(button).toHaveTextContent(/^退出登录$/)
      const probes = health.mock.calls.length
      logout.mockImplementation(async () => {
        expect(health).toHaveBeenCalledTimes(probes)
        return { status: 'ok', connected: false }
      })
      await userEvent.click(button)
      await waitFor(() => expect(button).toHaveTextContent(/^登录$/))
      expect(logout).toHaveBeenCalledOnce()
      expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    }
  )

  test('clears a refresh error after successful health recovery and discards state when the detail closes', async () => {
    const health = vi.fn().mockResolvedValue({ status: 'ok' })
    await openGithubConnection(health, undefined, false)
    const manage = 'plugin-connection-manage-connector:github'
    await waitFor(() => expect(screen.getByTestId(manage)).toHaveTextContent(/^退出登录$/))
    health.mockRejectedValue(new Error('Network unavailable'))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Network unavailable'
    )
    health.mockResolvedValue({ status: 'need_login' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(screen.getByTestId(manage)).toHaveTextContent(/^登录$/))
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
    health.mockResolvedValue({ status: 'ok' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(screen.getByTestId(manage)).toHaveTextContent(/^退出登录$/))
    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    health.mockRejectedValue(new Error('Network unavailable'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-github@openai-curated-remote')
    )
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Network unavailable'
    )
    expect(screen.getByTestId(manage)).toHaveTextContent(/^管理连接$/)
  })

  test('refreshes the GitHub CLI connection after returning from an external account change', async () => {
    const health = vi.fn().mockResolvedValue({ status: 'ok' })
    await openGithubConnection(health, undefined, false)
    const button = screen.getByTestId('plugin-connection-manage-connector:github')
    await waitFor(() => expect(button).toHaveTextContent('退出登录'))
    health.mockResolvedValue({ status: 'need_login' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(button).toHaveTextContent(/^登录$/))
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
  })

  test('logs out through the existing local connector flow and then offers login', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const health = vi.fn().mockResolvedValue({ status: 'ok' })
    const logout = vi.fn().mockImplementation(async () => {
      health.mockResolvedValue({ status: 'need_login' })
      return { status: 'ok', connected: false }
    })
    await openGithubConnection(health, logout, false)
    const button = screen.getByTestId('plugin-connection-manage-connector:github')
    await waitFor(() => expect(button).toHaveTextContent('退出登录'))
    health.mockRejectedValue(new Error('Network unavailable'))
    await userEvent.click(button)
    await waitFor(() => expect(button).toHaveTextContent(/^登录$/))
    expect(logout).toHaveBeenCalledOnce()
    expect(requestLocalExecutor).toHaveBeenCalledWith(
      'runtime.local_connector_auth.logout',
      expect.objectContaining({ pluginKey: 'github', connectorSlug: 'wework-github-cli' })
    )
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(await screen.findByTestId('plugin-github-cli-auth-dialog')).toBeInTheDocument()
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.local_connector_auth.start',
      expect.anything()
    )
  })

  test.each(['gh_logout_failed', 'gh_logout_env_token'])(
    'keeps GitHub logout failure %s retryable without clearing its connection',
    async errorCode => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const health = vi.fn().mockResolvedValue({ status: 'ok' })
      const logout = vi.fn().mockResolvedValue({ status: 'error', errorCode })
      await openGithubConnection(health, logout)
      expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
        errorCode === 'gh_logout_env_token' ? 'GH_TOKEN 或 GITHUB_TOKEN' : 'GitHub CLI 退出失败'
      )
      const button = screen.getByTestId('plugin-connection-manage-connector:github')
      expect(button).toHaveTextContent('退出登录')
      expect(button).toBeEnabled()
      logout.mockImplementation(async () => {
        health.mockResolvedValue({ status: 'need_login' })
        return { status: 'ok', connected: false }
      })
      await userEvent.click(button)
      await waitFor(() => expect(button).toHaveTextContent(/^登录$/))
      expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
    }
  )

  test('retains logout when gh activates another saved account after removing the active account', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openGithubConnection(
      async () => ({ status: 'ok' }),
      async () => ({ status: 'ok', connected: true })
    )
    await waitFor(() =>
      expect(screen.getByTestId('plugin-connection-manage-connector:github')).toHaveTextContent(
        '退出登录'
      )
    )
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
  })

  test('does not let a late initial health probe overwrite successful logout', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let resolveInitial!: (result: unknown) => void
    const health = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveInitial = resolve
          })
      )
      .mockResolvedValue({ status: 'ok' })
    const logout = async () => {
      health.mockResolvedValue({ status: 'need_login' })
      return { status: 'ok', connected: false }
    }
    await openGithubConnection(health, logout)
    const button = screen.getByTestId('plugin-connection-manage-connector:github')
    await waitFor(() => expect(button).toHaveTextContent(/^登录$/))
    await act(async () => resolveInitial({ status: 'ok' }))
    expect(button).toHaveTextContent(/^登录$/)
  })

  test.each([
    ['gh_health_failed', '无法验证 GitHub CLI 登录状态'],
    ['gh_health_timeout', 'GitHub 登录检查超时'],
    ['gh_missing', '执行设备未安装 GitHub CLI'],
    ['unknown_health_error', '无法验证 GitHub CLI 登录状态'],
  ])(
    'keeps GitHub CLI health error %s distinct from a missing login',
    async (errorCode, message) => {
      await openGithubConnection(async () => ({ status: 'error', errorCode }))

      expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(message)
      expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
      expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
      expect(screen.getByTestId('plugin-connection-manage-connector:github')).toBeEnabled()
    }
  )

  test('shows GitHub CLI connected after an explicitly confirmed login succeeds', async () => {
    const health = vi.fn().mockResolvedValue({ status: 'need_login' })
    await openGithubConnection(health)
    expect(await screen.findByTestId('plugin-github-cli-auth-dialog')).toBeInTheDocument()
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.local_connector_auth.start',
      expect.anything()
    )
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.local_connector_auth.start') {
        health.mockResolvedValue({ status: 'ok' })
        return Promise.resolve({ status: 'ok' })
      }
      return previousInvoke?.(method, params) as Promise<unknown>
    })
    await userEvent.click(screen.getByTestId('github-cli-login'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-connection-manage-connector:github')).toHaveTextContent(
        '退出登录'
      )
    )
    expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-connection-manage-connector:github')).toBeEnabled()
  })

  test('recovers a failed GitHub CLI health request on the next manage attempt', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const health = vi.fn().mockRejectedValue(new Error('Executor unavailable'))
    await openGithubConnection(health)

    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Executor unavailable'
    )
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    health.mockResolvedValue({ status: 'ok' })
    await userEvent.click(screen.getByTestId('plugin-connection-manage-connector:github'))
    await waitFor(() =>
      expect(screen.getByTestId('plugin-connection-manage-connector:github')).toHaveTextContent(
        '退出登录'
      )
    )
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
  })

  test.each(['ok', 'need_login', 'error'])(
    'ignores a late GitHub CLI %s health result after leaving its detail',
    async status => {
      let resolveHealth!: (result: unknown) => void
      const health = vi.fn(
        () =>
          new Promise(resolve => {
            resolveHealth = resolve
          })
      )
      await openGithubConnection(health)
      const button = screen.getByTestId('plugin-connection-manage-connector:github')
      expect(button).toBeDisabled()
      await userEvent.click(button)
      expect(health).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
      await act(async () => {
        resolveHealth({ status, errorCode: 'gh_health_failed' })
      })

      expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
      expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
      await userEvent.click(
        screen.getByTestId('plugin-marketplace-row-github@openai-curated-remote')
      )
      expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
      expect(screen.getByTestId('plugin-connection-manage-connector:github')).toBeEnabled()
    }
  )

  test.each(['Figma', 'Finances', 'Gmail'])(
    'opens the live %s authorization URL and verifies account access separately',
    async name => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const slug = name.toLowerCase()
      const id = `${slug}@openai-curated-remote`
      const app = {
        id: `connector_${slug}_account`,
        name,
        installUrl: `https://auth.example.test/${slug}?flow=connect`,
        isAccessible: false,
        isEnabled: true,
      }
      mockCodexAppServerInvoke({
        marketplaces: [
          {
            name: 'openai-curated-remote',
            path: 'openai-curated-remote',
            plugins: [
              {
                id,
                name: slug,
                displayName: name,
                description: `Connect ${name}`,
                connectors: [{ slug, authPolicy: 'on_use' }],
              },
            ],
          },
        ],
        installedPluginNames: [slug],
        apps: [
          app,
          { id: 'github', name: 'GitHub', installUrl: 'https://auth.example.test/github' },
        ],
      })
      mockEmptyCloudPluginApis()
      desktopHostMock.mockResolvedValue(undefined)
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
      await userEvent.click(await screen.findByTestId(`plugin-marketplace-row-${id}`))
      await userEvent.click(await screen.findByTestId(`plugin-connection-manage-connector:${slug}`))
      expect(await screen.findByTestId('plugin-connector-auth-dialog')).toHaveTextContent(
        `授权 ${name}`
      )
      expect(desktopHostMock).toHaveBeenCalledWith('shell.openExternal', { url: app.installUrl })
      expectCodexAppServerRequest('app/list', { forceRefetch: false })
      expect(authorizeWegentConnector).not.toHaveBeenCalled()
      expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('plugin-connector-auth-verify'))
      expectCodexAppServerRequest('app/list', { forceRefetch: true })
      expect(
        await screen.findByText(`尚未确认 ${name} 授权成功。请完成浏览器中的授权后再次验证。`)
      ).toBeInTheDocument()
      app.isAccessible = true
      await userEvent.click(screen.getByTestId('plugin-connector-auth-verify'))
      await waitFor(() =>
        expect(screen.queryByTestId('plugin-connector-auth-dialog')).not.toBeInTheDocument()
      )
    }
  )

  test.each([
    'missing-url',
    'ambiguous-app',
    'directory-error',
    'browser-error',
    'leave-detail',
    'timeout',
  ])('keeps Codex authorization safe and retryable for %s', async failure => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const app = {
      id: 'figma-account',
      name: 'Figma',
      installUrl: failure === 'missing-url' ? null : 'https://auth.example.test/figma',
      isAccessible: false,
      isEnabled: true,
    }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          plugins: [
            {
              id: 'figma@openai-curated-remote',
              name: 'figma',
              displayName: 'Figma',
              connectors: [{ slug: 'figma', authPolicy: 'on_use' }],
            },
          ],
        },
      ],
      installedPluginNames: ['figma'],
      apps: failure === 'ambiguous-app' ? [app, { ...app, id: 'other-figma' }] : [app],
    })
    const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
    let completeDirectory: (() => void) | undefined
    vi.mocked(requestLocalExecutor).mockImplementation((command, args) => {
      if (
        command === 'codex.app_server_request' &&
        (args as { method?: string }).method === 'app/list'
      ) {
        if (failure === 'directory-error')
          return Promise.reject(new Error('App directory unavailable'))
        if (failure === 'timeout') return Promise.reject(new CodexAuthorizationTimeoutError())
        if (failure === 'leave-detail')
          return new Promise(resolve => {
            completeDirectory = () => resolve({ data: [app], nextCursor: null })
          })
      }
      return original(command, args)
    })
    mockEmptyCloudPluginApis()
    desktopHostMock.mockImplementation(command =>
      command === 'shell.openExternal' && failure === 'browser-error'
        ? Promise.reject(new Error('Browser unavailable'))
        : Promise.resolve(undefined)
    )
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-figma@openai-curated-remote')
    )
    await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:figma'))
    if (failure === 'leave-detail') {
      expect(screen.getByTestId('plugin-connection-manage-connector:figma')).toBeDisabled()
      fireEvent.click(screen.getByTestId('plugin-connection-manage-connector:figma'))
      const appRequests = requestLocalExecutor.mock.calls.filter(
        ([command, args]) =>
          command === 'codex.app_server_request' &&
          (args as { method?: string }).method === 'app/list'
      )
      expect(appRequests).toHaveLength(1)
      await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
      await act(async () => completeDirectory!())
    } else {
      const error = await screen.findByTestId('plugin-detail-action-error')
      expect(error).not.toHaveTextContent('授权 GitHub')
      expect(error).toHaveTextContent(
        failure === 'timeout'
          ? '查询应用授权入口超时'
          : failure === 'directory-error'
            ? '查询应用授权状态失败'
            : failure === 'browser-error'
              ? '无法打开 Figma 授权页面'
              : '授权入口'
      )
      expect(screen.getByTestId('plugin-connection-manage-connector:figma')).not.toBeDisabled()
    }
    expect(screen.queryByTestId('plugin-connector-auth-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-github-cli-auth-dialog')).not.toBeInTheDocument()
    if (failure !== 'browser-error')
      expect(desktopHostMock).not.toHaveBeenCalledWith('shell.openExternal', expect.anything())
  })

  test.each(
    (['open', 'verify'] as const).flatMap(phase =>
      [
        { error: '403 Forbidden', expected: '请求被拒绝（403 或安全验证）' },
        { error: '401 Unauthorized', expected: '需要有效的 OpenAI 账户登录' },
        { error: 'Request timed out', expected: '查询应用授权入口超时' },
        { error: 'Unknown error', expected: '查询应用授权状态失败' },
      ].map(failure => ({ phase, ...failure }))
    )
  )('sanitizes $error during Gmail authorization $phase and permits retry', async failure => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const app = {
      id: 'gmail-account',
      name: 'Gmail',
      installUrl: 'https://auth.example.test/gmail',
      isAccessible: false,
      isEnabled: true,
    }
    mockCodexAppServerInvoke({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          plugins: [
            {
              id: 'gmail@openai-curated-remote',
              name: 'gmail',
              displayName: 'Gmail',
              connectors: [{ slug: 'gmail', authPolicy: 'on_use' }],
            },
          ],
        },
      ],
      installedPluginNames: ['gmail'],
      apps: [app],
    })
    mockEmptyCloudPluginApis()
    desktopHostMock.mockResolvedValue(undefined)
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugins-distribution-tab-official'))
    await userEvent.click(
      await screen.findByTestId('plugin-marketplace-row-gmail@openai-curated-remote')
    )
    const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
    let rejectRead = failure.phase === 'open'
    const rawBody = `<html><svg><path d="${'M31.0064C5.51397'.repeat(2000)}"/></svg>private-response</html>`
    vi.mocked(requestLocalExecutor).mockImplementation((command, args) => {
      if (
        rejectRead &&
        command === 'codex.app_server_request' &&
        (args as { method?: string }).method === 'app/list'
      ) {
        return Promise.reject(new Error(`${failure.error}: ${rawBody}`))
      }
      return original(command, args)
    })
    const manage = screen.getByTestId('plugin-connection-manage-connector:gmail')
    await userEvent.click(manage)
    if (failure.phase === 'verify') {
      await screen.findByTestId('plugin-connector-auth-dialog')
      rejectRead = true
      await userEvent.click(screen.getByTestId('plugin-connector-auth-verify'))
    }
    const errorSurface = await screen.findByTestId(
      failure.phase === 'open' ? 'plugin-detail-action-error' : 'plugin-connector-auth-dialog'
    )
    await waitFor(() => expect(errorSurface).toHaveTextContent(failure.expected))
    expect(errorSurface).toHaveTextContent('未确认')
    expect(document.body).not.toHaveTextContent('private-response')
    expect(document.body).not.toHaveTextContent('M31.0064C5.51397')
    expect(errorSurface.textContent!.length).toBeLessThan(300)
    expect(manage).toBeEnabled()
    if (failure.phase === 'verify') {
      expect(screen.getByTestId('plugin-connector-auth-cancel')).toBeEnabled()
      expect(screen.getByTestId('plugin-connector-auth-verify')).toBeEnabled()
    } else {
      expect(screen.queryByTestId('plugin-connector-auth-dialog')).not.toBeInTheDocument()
    }
    rejectRead = false
    app.isAccessible = true
    if (failure.phase === 'open') {
      await userEvent.click(manage)
      await screen.findByTestId('plugin-connector-auth-dialog')
    }
    await userEvent.click(screen.getByTestId('plugin-connector-auth-verify'))
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-connector-auth-dialog')).not.toBeInTheDocument()
    )
    expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
  })

  test.each([false, true])(
    'keeps failed local logout retryable when accountRevoked=%s',
    async accountRevoked => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceDeviceState: 'installed',
        marketplaceName: 'weibo-api-wiki',
        marketplaceConnectorSlug: 'weibo-wiki',
        marketplaceConnectorLocal: true,
        marketplaceConnectorAccountAuth: true,
      })
      let attempts = 0
      mockCodexAppServerInvoke({
        localConnectorAuthLogout: () =>
          Promise.resolve(
            ++attempts === 1 ? { status: 'error', accountRevoked } : { status: 'ok' }
          ),
      })
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
        const button = await screen.findByTestId('plugin-connection-manage-connector:weibo-wiki')
        await waitFor(() => expect(button).toHaveTextContent('退出登录'))
        await userEvent.click(button)
        expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
          accountRevoked ? '账户授权已撤销，但本机登录凭据清理失败' : '退出登录失败'
        )
        expect(button).toHaveTextContent('退出登录')
        await userEvent.click(button)
        await waitFor(() => expect(button).toHaveTextContent('登录'))
        expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
        expect(attempts).toBe(2)
      } finally {
        confirm.mockRestore()
      }
    }
  )

  test('does not route accountAuth-only connectors to the cloud OAuth catalog', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceConnectorSlug: 'tianhe',
      marketplaceConnectorAccountAuth: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:tianhe'))
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      '此连接尚未提供页面登录入口'
    )
    expect(listWegentConnectorApps).not.toHaveBeenCalled()
    expect(authorizeWegentConnector).not.toHaveBeenCalled()
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

  test('falls back to OAuth consent when an expired connector refresh fails', async () => {
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
          status: 'expired',
          external_account_name: 'octocat',
          granted_scopes: ['repo'],
          expires_at: '2026-01-01T00:00:00Z',
        },
      },
    ])
    vi.mocked(refreshWegentConnector).mockRejectedValue(new Error('refresh rejected'))

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(await screen.findByTestId('plugin-connection-manage-connector:github'))

    await waitFor(() =>
      expect(refreshWegentConnector).toHaveBeenCalledWith('/api', 'cloud-token', 'github')
    )
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
    window.localStorage.setItem('auth_token', 'account-token')
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

    expect(screen.queryByText('0/1 已安装 · 1 失败')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-toggle-101')).toHaveTextContent('重试安装')
    expect(screen.getByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Codex App Server rejected install'
    )
    expect(screen.getByTestId('plugin-detail-actions-101')).toBeInTheDocument()
    expectFetchRequest('/api/plugins/marketplace?device_id=current-device')
  })

  test('does not dispatch background synchronization while a foreground install is pending', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplace = mockSystemSkillsFetch({ deviceAutoSyncSucceeds: true })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/marketplace/101/install')) await pending
      return originalFetch(input, init)
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-install-101'))
    await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
    await waitFor(() =>
      expectFetchRequest('/api/plugins/marketplace/101/install?device_id=current-device', 'POST')
    )
    const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
    const cached = getPluginMarketplaceCache(key)!
    await act(async () => {
      setPluginMarketplaceCache({
        ...cached,
        marketplaceItems: cached.marketplaceItems.map(item => ({
          ...item,
          installed: false,
          installedLocally: false,
          installedPluginId: 101,
          currentDeviceInstallation: {
            deviceId: 'current-device',
            desiredReleaseId: 1001,
            actualReleaseId: null,
            state: 'pending',
            errorCode: null,
            errorMessage: null,
            attemptCount: 0,
            lastSyncAt: null,
            updatedAt: new Date().toISOString(),
          },
        })),
      })
    })
    try {
      expect(marketplace.getSyncDeviceCalls()).toBe(0)
    } finally {
      await act(async () => release())
    }
    await screen.findByTestId('plugin-marketplace-actions-101')
    expect(marketplace.getSyncDeviceCalls()).toBe(0)
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
      wegentStorePlugins: [
        {
          name: 'documents',
          packageId: '101-wegent-documents-1.0.0',
          installedPluginId: 101,
          marketplace: 'wegent',
          version: '1.0.0',
          enabled: true,
          pluginPath: '/Users/test/.wework/capabilities/store/plugins/101-wegent-documents-1.0.0',
        },
      ],
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

  test('does not refresh device inventory after an unmounted status report completes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let finishReport!: () => void
    const reportDeviceGate = new Promise<void>(resolve => {
      finishReport = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      reportDeviceGate,
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
    const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await waitFor(() => expect(marketplaceMock.getReportDeviceCalls()).toBe(1))
    view.unmount()

    // A late response must not use the next page/test's transport and republish old local state.
    mockSystemSkillsFetch({ marketplaceInstalled: false })
    await act(async () => {
      finishReport()
      await reportDeviceGate
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test('does not refresh device inventory after an unmounted sync completes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let finishSync!: () => void
    const deviceAutoSyncGate = new Promise<void>(resolve => {
      finishSync = resolve
    })
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: true,
      deviceAutoSyncGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await waitFor(() => expect(marketplaceMock.getSyncDeviceCalls()).toBe(1))
    view.unmount()

    mockSystemSkillsFetch({ marketplaceInstalled: false })
    await act(async () => {
      finishSync()
      await deviceAutoSyncGate
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
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

  test('keeps a late request from the previous account outside the current sync fixture', async () => {
    let releaseSync!: () => void
    const gate = new Promise<void>(resolve => {
      releaseSync = resolve
    })
    const currentFixture = mockSystemSkillsFetch({
      cloudToken: 'catalog-sync-account',
      marketplaceInstalled: true,
      marketplaceDeviceState: 'pending',
      deviceAutoSyncSucceeds: true,
      deviceAutoSyncGate: gate,
    })
    const latePreviousRequest = fetch(
      '/api/plugins/installed/sync-device?device_id=current-device',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer cloud-token' },
      }
    )

    try {
      expect(currentFixture.getSyncDeviceCalls()).toBe(0)
    } finally {
      releaseSync()
      await latePreviousRequest
    }
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
    let localPluginListStarted = false
    let unrestrictedPluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { marketplaceKinds?: string[] }
        }
        if (request.method === 'plugin/installed') {
          return pendingInstalled
        }
        if (request.method === 'plugin/list') {
          if (request.params?.marketplaceKinds?.includes('local')) {
            localPluginListStarted = true
          } else {
            unrestrictedPluginListStarted = true
          }
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(localPluginListStarted).toBe(false)
    expect(unrestrictedPluginListStarted).toBe(false)
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

    await waitFor(() => expect(localPluginListStarted).toBe(true))
    expect(unrestrictedPluginListStarted).toBe(false)
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)
  })

  test('does not start plugin/list from a warm OpenAI catalog until the user refreshes', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const marketplaceMock = mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'local-device' })
    seedDurableOpenAiGithubPeek({
      seedInventory: true,
      remoteFetchedAt: Date.now(),
      cacheKey: '/api|cloud-token',
    })

    // A directory is reusable only after this runtime validates its account scope.
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: 'openai-curated-remote',
          plugins: [
            {
              id: 'github@openai-curated-remote',
              name: 'github',
              installed: false,
              enabled: false,
              interface: { displayName: 'GitHub' },
            },
          ],
        },
      ],
    })
    await createLocalCodexPluginApi().readRemoteCatalog({
      accountScope: pluginMarketplaceCacheKey('/api', 'cloud-token'),
    })

    let resolveInstalled: ((value: unknown) => void) | null = null
    const pendingInstalled = new Promise(resolve => {
      resolveInstalled = resolve
    })
    let localPluginListStarted = false
    let unrestrictedPluginListStarted = false
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as {
          method?: string
          params?: { marketplaceKinds?: string[] }
        }
        if (request.method === 'plugin/installed') {
          return pendingInstalled
        }
        if (request.method === 'plugin/list') {
          if (request.params?.marketplaceKinds?.includes('local')) {
            localPluginListStarted = true
          } else {
            unrestrictedPluginListStarted = true
          }
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(localPluginListStarted).toBe(false)
    expect(unrestrictedPluginListStarted).toBe(false)

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
    await waitFor(() => expect(localPluginListStarted).toBe(true))
    expect(unrestrictedPluginListStarted).toBe(false)
    expect(marketplaceMock.getSyncDeviceCalls()).toBe(0)

    await userEvent.click(screen.getByTestId('plugins-refresh-button'))
    await waitFor(() => expect(unrestrictedPluginListStarted).toBe(true))
  })

  test('refreshing a non-official marketplace never reads the official directory', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ deviceAutoSyncSucceeds: true })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const originalInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
    vi.mocked(requestLocalExecutor).mockImplementation(async (method, args) => {
      const result = await originalInvoke(method, args)
      return method === 'executor.plugins.store.list'
        ? { ...(result as Record<string, unknown>), supportsPluginReconciliation: true }
        : result
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await screen.findByTestId('plugin-marketplace-install-101')
    const refresh = screen.getByTestId('plugins-refresh-button')
    await waitFor(() => expect(refresh).toBeEnabled())
    const before = refresh.getAttribute('data-reconciliation-revision')
    await userEvent.click(refresh)
    await waitFor(() =>
      expect(refresh.getAttribute('data-reconciliation-revision')).not.toBe(before)
    )
    await waitFor(() => expect(refresh).toBeEnabled())
    const catalogs = vi
      .mocked(requestLocalExecutor)
      .mock.calls.filter(
        ([method, payload]) =>
          method === 'codex.app_server_request' &&
          (payload as { method?: string })?.method === 'plugin/list'
      )
    expect(catalogs.length).toBeGreaterThan(0)
    expect(
      catalogs.every(
        ([, payload]) =>
          (
            payload as { params?: { marketplaceKinds?: string[] } }
          ).params?.marketplaceKinds?.join() === 'local'
      )
    ).toBe(true)
  })

  test('explicit refresh supersedes a pending plugin/installed request', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
    })
    mockCodexAppServerInvoke({ deviceId: 'local-device' })
    seedDurableOpenAiGithubPeek({
      seedInventory: true,
      remoteFetchedAt: Date.now(),
      cacheKey: '/api|cloud-token',
    })

    let installedRequestCount = 0
    let resolveFirstInstalled: ((value: unknown) => void) | null = null
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'codex.app_server_request') {
        const request = args as { method?: string }
        if (request.method === 'plugin/installed') {
          installedRequestCount += 1
          if (installedRequestCount === 1) {
            return new Promise(resolve => {
              resolveFirstInstalled = resolve
            })
          }
        }
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })

    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    await waitFor(() => expect(installedRequestCount).toBe(1))
    await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())

    await userEvent.click(screen.getByTestId('plugins-refresh-button'))

    await waitFor(() => expect(installedRequestCount).toBe(2))
    resolveFirstInstalled?.({ marketplaces: [] })
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

  test.each([
    'current',
    'delayed-inventory',
    'absent',
    'unavailable',
    'account-change',
    'return-account',
  ] as const)(
    'uninstalls a failed cloud account row without a local installed summary: %s',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceDeviceState: 'failed',
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'owner',
      })
      mockCodexAppServerInvoke({ deviceId: 'current-device', installedPluginNames: [] })
      if (outcome === 'delayed-inventory') localExecutorMocks.knownDeviceId = null
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let armPreflight = false
      let preflightReads = 0
      let accountTemplate: InstalledPluginListResponse['items'][number] | undefined
      const otherAccountPlugin = (
        plugin: InstalledPluginListResponse['items'][number]
      ): InstalledPluginListResponse['items'][number] => ({
        ...plugin,
        metadata: { ...plugin.metadata, name: 'other-plugin', labels: { id: 76 } },
        spec: {
          ...plugin.spec,
          pluginId: 75,
          displayName: 'Other Plugin',
          installState: 'installed',
          source: { ...plugin.spec.source, pluginKey: 'other-plugin' },
        },
        status: {
          ...plugin.status,
          state: 'installed',
          devices: plugin.status.devices?.map(device => ({
            ...device,
            state: 'installed',
            actualReleaseId: 1001,
          })),
        },
      })
      let finishPreflight!: () => void
      const preflightGate = new Promise<void>(resolve => {
        finishPreflight = resolve
      })
      let finishInitialInventory!: () => void
      const initialInventoryGate = new Promise<void>(resolve => {
        finishInitialInventory = resolve
      })
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const path = new URL(String(input), 'http://localhost')
        if (
          outcome === 'delayed-inventory' &&
          path.pathname === '/api/plugins/installed' &&
          path.searchParams.has('device_id')
        ) {
          await initialInventoryGate
        }
        if (armPreflight && path.pathname === '/api/plugins/installed' && !path.search) {
          armPreflight = false
          preflightReads += 1
          if (outcome === 'unavailable') throw new TypeError('Failed to fetch')
          const response = await originalFetch(input, init)
          const inventory = (await response.json()) as InstalledPluginListResponse
          if (outcome === 'account-change' || outcome === 'return-account') await preflightGate
          return Response.json({
            items: [
              ...(outcome === 'absent'
                ? []
                : inventory.items.map(plugin => ({
                    ...plugin,
                    metadata: { ...plugin.metadata, labels: { id: 208 } },
                  }))),
              otherAccountPlugin(inventory.items[0]),
            ],
          })
        }
        if (path.pathname === '/api/plugins/installed/208' && init?.method === 'DELETE') {
          return originalFetch('/api/plugins/installed/101', init)
        }
        const response = await originalFetch(input, init)
        if (path.pathname === '/api/plugins/marketplace') {
          const payload = (await response.json()) as { items: PluginMarketplaceItem[] }
          return Response.json({
            ...payload,
            items: [
              ...payload.items.map(item => ({
                ...item,
                installedPluginId: item.installedPluginId == null ? null : 75,
              })),
              {
                ...payload.items[0],
                id: 75,
                name: 'other-plugin',
                displayName: 'Other Plugin',
                installed: true,
                installedPluginId: 76,
                currentDeviceInstallation: {
                  ...payload.items[0].currentDeviceInstallation,
                  state: 'installed',
                  actualReleaseId: 1001,
                },
              },
            ],
          })
        }
        if (path.pathname === '/api/plugins/installed') {
          const payload = (await response.json()) as InstalledPluginListResponse
          accountTemplate = payload.items[0] ?? accountTemplate
          return Response.json({
            ...payload,
            items: [
              ...payload.items.map(plugin => ({
                ...plugin,
                metadata: { ...plugin.metadata, labels: { id: 75 } },
              })),
              ...(accountTemplate ? [otherAccountPlugin(accountTemplate)] : []),
            ],
          })
        }
        return response
      })
      const logout = vi
        .spyOn(connectorCleanup, 'logoutLocalConnectorsForPlugin')
        .mockResolvedValue(undefined)
      const uninstallAccount = vi.spyOn(pluginUninstall, 'uninstallAccountPlugin')
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      try {
        await waitFor(() =>
          expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('重试安装')
        )
        if (outcome === 'delayed-inventory') {
          // The retry action can paint before the device-scoped inventory is applied.
          expect(getPluginMarketplaceCache('/api|cloud-token')?.deviceId).toBe('')
          expect(
            getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins.find(
              plugin => plugin.spec.pluginId === 101
            )
          ).toEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ labels: { id: 75 } }) })
          )
          expect(screen.getByTestId('plugins-installed-strip-item-75')).toBeInTheDocument()
          await act(async () => finishInitialInventory())
        }
        await waitFor(() => {
          const inventory = getPluginMarketplaceCache('/api|cloud-token')
          expect(inventory?.deviceId).toBe('current-device')
          expect(inventory?.installedPlugins.some(plugin => plugin.spec.pluginId === 101)).toBe(
            false
          )
          expect(inventory?.installedPlugins.find(plugin => plugin.spec.pluginId === 75)).toEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ labels: { id: 76 } }) })
          )
          expect(inventory?.marketplaceItems.find(item => item.id === 75)).toEqual(
            expect.objectContaining({ installed: true, installedPluginId: 76 })
          )
          expect(screen.queryByTestId('plugins-installed-strip-item-75')).not.toBeInTheDocument()
          expect(screen.getByTestId('plugins-installed-strip-item-76')).toBeInTheDocument()
        })
        await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
        await userEvent.click(await screen.findByTestId('plugin-detail-actions-101'))
        await userEvent.click(screen.getByTestId('plugin-detail-uninstall-101'))
        armPreflight = true
        await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
        await waitFor(() => expect(preflightReads).toBe(1))
        expect(uninstallAccount).toHaveBeenCalledOnce()
        const pendingUninstall = uninstallAccount.mock.results[0].value

        if (outcome === 'account-change' || outcome === 'return-account') {
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
          if (outcome === 'return-account') {
            view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
          }
          await act(async () => {
            finishPreflight()
            await expect(pendingUninstall).rejects.toThrow(
              'Plugin uninstall cancelled after account scope changed'
            )
          })
          expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
        } else if (outcome === 'unavailable') {
          await expect(pendingUninstall).rejects.toThrow('PLUGIN_UNINSTALL_PREFLIGHT_FAILED')
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
            '暂时无法确认当前账号的插件安装状态'
          )
          expect(screen.getByTestId('plugin-detail-actions-101')).toBeEnabled()
        } else {
          await act(async () => {
            await expect(pendingUninstall).resolves.toBeUndefined()
          })
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('已卸载')
          expect(
            getPluginMarketplaceCache('/api|cloud-token')?.marketplaceItems.find(
              item => item.id === 75
            )
          ).toEqual(expect.objectContaining({ installed: true, installedPluginId: 76 }))
          expect(
            getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins.find(
              plugin => plugin.spec.pluginId === 75
            )
          ).toEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ labels: { id: 76 } }) })
          )
        }
        const deletes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')
        expect(deletes).toEqual(
          outcome === 'current' || outcome === 'delayed-inventory'
            ? [['/api/plugins/installed/208', expect.objectContaining({ method: 'DELETE' })]]
            : []
        )
        expect(logout).not.toHaveBeenCalled()
        expect(requestLocalExecutor).not.toHaveBeenCalledWith(
          'runtime.codex.plugin.uninstall_local',
          expect.anything()
        )
        expect(requestLocalExecutor).not.toHaveBeenCalledWith(
          'executor.plugins.links.unlink',
          expect.anything()
        )
        expectCodexAppServerRequestNotCalled('plugin/uninstall')
      } finally {
        finishInitialInventory()
        finishPreflight()
        view.unmount()
        logout.mockRestore()
        uninstallAccount.mockRestore()
      }
    }
  )

  test('confirms account absence without local uninstall for a cloud catalog row missing its summary', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({ marketplaceInstalled: true, marketplaceDeviceState: 'installed' })
    mockCodexAppServerInvoke({ deviceId: 'current-device', marketplaces: [] })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/plugins/installed') {
        return Promise.resolve(Response.json({ items: [] }))
      }
      return originalFetch(input, init)
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-actions-101'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('已卸载')
    expectCodexAppServerRequestNotCalled('plugin/uninstall')
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.codex.plugin.uninstall_local',
      expect.anything()
    )
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  test('uninstalls a manifest-backed Wegent package through its cloud account record', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceVisibility: 'workspace',
      marketplaceSourceProvider: 'wegent',
      marketplaceName: 'weibo-miniapp-h5-develop-agent',
      marketplaceDisplayName: '微博小程序H5开发助手',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [],
      wegentStorePlugins: [
        {
          name: 'weibo-miniapp-h5-develop-agent',
          packageId: '101-wegent-weibo-miniapp-h5-develop-agent-2.1.0',
          installedPluginId: 101,
          marketplace: 'wegent',
          version: '2.1.0',
          enabled: true,
          displayName: '微博小程序H5开发助手',
          pluginPath:
            '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins/101-wegent-weibo-miniapp-h5-develop-agent-2.1.0',
        },
      ],
    })
    const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      const cloudUninstallCompleted = vi
        .mocked(fetch)
        .mock.calls.some(
          ([input, init]) =>
            String(input).includes('/api/plugins/installed/101') && init?.method === 'DELETE'
        )
      if (command === 'executor.plugins.store.list' && cloudUninstallCompleted) {
        return Promise.resolve({
          storePath: '/Users/test/.wework/apps/com.weibo.wework/capabilities/store/plugins',
          plugins: [],
        })
      }
      return previousInvoke?.(command, args) as Promise<unknown>
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    expect(await screen.findByText('微博小程序H5开发助手')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('plugin-marketplace-actions-101'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/installed/101',
        expect.objectContaining({ method: 'DELETE' })
      )
    )
    expectCodexAppServerRequestNotCalled('plugin/uninstall')
    expect(await screen.findByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
  })

  test('loads grouped connectors when opening a personal installed summary', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockEmptyCloudPluginApis()
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [{ id: 'documents-local-id', name: 'documents', displayName: 'Documents' }],
        },
      ],
      installedPluginNames: ['documents'],
    })
    const previous = vi.mocked(requestLocalExecutor).getMockImplementation()
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (command === 'executor.plugins.manifest.read')
        return Promise.resolve({
          connectors: [
            {
              slug: 'site-a',
              displayName: 'example.test',
              authorizationGroup: { id: 'sites', displayName: 'Example account' },
              authPolicy: 'optional',
            },
          ],
        })
      return previous?.(command, args) as Promise<unknown>
    })
    render(<PluginsWorkspace />)
    await userEvent.click(
      await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
    )
    expect(await screen.findByTestId('plugin-connection-manage-group:sites')).toBeInTheDocument()
    expectCodexAppServerRequest('plugin/read', { pluginName: 'documents' })
  })

  test('clears a personal detail read error after reopening successfully without remounting', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockEmptyCloudPluginApis()
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [{ id: 'documents-local-id', name: 'documents', displayName: 'Documents' }],
        },
      ],
      installedPluginNames: ['documents'],
    })
    const previous = vi.mocked(requestLocalExecutor).getMockImplementation()
    let readFailed = false
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (
        command === 'codex.app_server_request' &&
        (args as { method?: string }).method === 'plugin/read' &&
        !readFailed
      ) {
        readFailed = true
        return Promise.reject(new Error('Personal detail source unavailable'))
      }
      return previous?.(command, args) as Promise<unknown>
    })
    render(<PluginsWorkspace />)
    await userEvent.click(
      await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
    )
    expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
      'Personal detail source unavailable'
    )
    await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
    await userEvent.click(
      await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
    )
    expect(await screen.findByText('Documents App')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
    )
  })

  test('does not offer sharing for a bundled plugin in the personal marketplace', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockEmptyCloudPluginApis()
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [{ id: 'documents-local-id', name: 'documents', displayName: 'Documents' }],
        },
      ],
      installedPluginNames: ['documents'],
    })
    const bundled = vi
      .spyOn(localExecutor, 'getInitializedBundledPluginMarketplace')
      .mockReturnValue({
        id: 'wework-personal',
        path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
        pluginCount: 1,
        contentHash: 'bundled-hash',
        defaultPluginNames: ['documents'],
      })
    try {
      render(<PluginsWorkspace />)
      await userEvent.click(
        await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
      )
      expect(await screen.findByTestId('plugin-detail-toggle-documents-local-id')).toBeEnabled()
      expect(screen.queryByTestId(/^plugin-detail-share-/)).not.toBeInTheDocument()
    } finally {
      bundled.mockRestore()
    }
  })

  test('keeps a plugin operation error when its pending detail read succeeds', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockEmptyCloudPluginApis()
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
          plugins: [{ id: 'documents-local-id', name: 'documents', displayName: 'Documents' }],
        },
      ],
      installedPluginNames: ['documents'],
    })
    const previous = vi.mocked(requestLocalExecutor).getMockImplementation()
    let resolveRead!: (value: unknown) => void
    vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
      if (
        command === 'codex.app_server_request' &&
        (args as { method?: string }).method === 'plugin/read'
      ) {
        return new Promise(resolve => {
          resolveRead = resolve
        })
      }
      return previous?.(command, args) as Promise<unknown>
    })
    const trial = vi.spyOn(marketplaceWorkspaceHelpers, 'tryPluginInChat').mockReturnValue(false)
    try {
      render(<PluginsWorkspace />)
      await userEvent.click(
        await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
      )
      await waitFor(() => expect(resolveRead).toBeTypeOf('function'))
      await userEvent.click(screen.getByTestId('plugin-detail-toggle-documents-local-id'))
      expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
        '这个插件没有可试用的技能'
      )
      await act(async () =>
        resolveRead({
          plugin: codexPluginDetail('wework-personal', {
            id: 'documents-local-id',
            name: 'documents',
            displayName: 'Documents',
          }),
        })
      )
      expect(await screen.findByText('Documents App')).toBeInTheDocument()
      expect(screen.getByTestId('plugin-detail-action-error')).toHaveTextContent(
        '这个插件没有可试用的技能'
      )
    } finally {
      trial.mockRestore()
    }
  })

  test.each([
    'owner',
    'offline-owner',
    'offline-denied',
    'denied',
    'switched',
    'fresh-local-auth',
    'removed-auth',
    'fresh-oauth-denied',
  ] as const)(
    'reinstalls an uninstalled author source locally after fresh owner validation: %s',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const ownerDenied = outcome === 'denied' || outcome === 'offline-denied'
      const bundledMarketplace = vi
        .spyOn(localExecutor, 'getInitializedBundledPluginMarketplace')
        .mockReturnValue({
          id: 'wework-personal',
          path: '/tmp/wework-personal',
          defaultPluginNames: [],
        })
      const authScenario = ['fresh-local-auth', 'removed-auth', 'fresh-oauth-denied'].includes(
        outcome
      )
      const freshConnector = {
        slug: 'fresh-source',
        authPolicy: 'on_install',
        ...(outcome === 'fresh-local-auth'
          ? {
              localAuth: {
                kind: 'browser_oauth',
                health: ['scripts/new-auth.sh', 'health'],
                start: ['scripts/new-auth.sh', 'login'],
                poll: [],
              },
            }
          : {}),
      }
      mockSystemSkillsFetch({
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'owner',
        marketplaceUpdateAvailable: true,
        ...(authScenario
          ? {
              marketplaceConnectorSlug: 'old-published',
              marketplaceConnectorAuthPolicy: 'optional',
              marketplaceConnectorLocal: true,
            }
          : {}),
      })
      mockCodexAppServerInvoke({
        backendConnected: !outcome.startsWith('offline-'),
        installedPluginNames: [],
        marketplaces: [
          {
            name: 'wework-personal',
            path: '/tmp/wework-personal',
            plugins: [
              { id: 'documents@wework-personal', name: 'documents', localVersion: '1.1.1' },
            ],
          },
        ],
        cloudLinks: [{ localPluginName: 'documents', cloudPluginId: 101, cloudReleaseId: 1002 }],
        localPluginImport: {
          archivePath: '/tmp/documents.zip',
          pluginName: 'documents',
          displayName: 'Documents',
          version: '1.1.1',
        },
      })
      const invoke = vi.mocked(requestLocalExecutor).getMockImplementation()
      vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
        if (method === 'executor.plugins.manifest.read' && authScenario) {
          return Promise.resolve({
            connectors: outcome === 'removed-auth' ? [] : [freshConnector],
          })
        }
        if (method === 'executor.plugins.personal.list') {
          return Promise.resolve({
            marketplaceId: 'wework-personal',
            marketplacePath: '/tmp/wework-personal',
            plugins: [
              {
                name: 'documents',
                version: '1.1.1',
                pluginPath: '/tmp/wework-personal/plugins/documents',
              },
            ],
          })
        }
        return invoke?.(method, args) as Promise<unknown>
      })
      let finishOwner!: () => void
      const ownerGate = new Promise<void>(resolve => {
        finishOwner = resolve
      })
      const fetcher = vi.mocked(fetch).getMockImplementation()
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).endsWith('/plugins/marketplace/101/owner')) {
          await ownerGate
          return Response.json(ownerDenied ? { detail: 'Not found' } : { pluginId: 101 }, {
            status: ownerDenied ? 404 : 200,
          })
        }
        return fetcher?.(input, init) as Promise<Response>
      })
      const api = createLocalCodexPluginApi()
      if (outcome === 'fresh-oauth-denied') {
        vi.mocked(listWegentConnectorApps).mockRejectedValue(new Error('OAuth unavailable'))
      }
      const installSource = vi.fn(api.installPersonalPluginSource)
      const factory = vi.spyOn(codexPlugins, 'createLocalCodexPluginApi').mockReturnValue({
        ...api,
        installPersonalPluginSource: installSource,
      })
      try {
        const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        const row = await screen.findByTestId('plugin-marketplace-row-101')
        await waitFor(() => expect(row).toHaveTextContent('1.1.1'))
        const beforeFocusReads = vi
          .mocked(requestLocalExecutor)
          .mock.calls.filter(([method]) => method === 'executor.plugins.personal.list').length
        fireEvent.focus(window)
        await waitFor(() =>
          expect(
            vi
              .mocked(requestLocalExecutor)
              .mock.calls.filter(([method]) => method === 'executor.plugins.personal.list').length
          ).toBeGreaterThan(beforeFocusReads)
        )
        await waitFor(() =>
          expect(getPluginMarketplaceCache('/api|cloud-token')?.marketplaceItems).toEqual([
            expect.objectContaining({
              id: 101,
              version: '1.1.1',
              sharedVersion: '1.1.0',
              localPersonalSource: {
                marketplacePath: '/tmp/wework-personal',
                pluginName: 'documents',
              },
            }),
          ])
        )
        expect(screen.getByTestId('plugin-marketplace-row-101')).toHaveTextContent('1.1.1')
        expect(
          screen.queryByTestId('plugins-installed-strip-item-documents@wework-personal')
        ).not.toBeInTheDocument()
        await installPluginFromMarketCard('plugin-marketplace-install-101')
        await waitFor(() => expectFetchRequest('/api/plugins/marketplace/101/owner'))
        expect(installSource).not.toHaveBeenCalled()
        expect(requestLocalExecutor).not.toHaveBeenCalledWith(
          'runtime.codex.plugin.install_local_first',
          expect.anything()
        )
        if (outcome === 'switched') {
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        }
        await act(async () => finishOwner())
        if (outcome === 'owner' || outcome === 'offline-owner' || authScenario) {
          await waitFor(() =>
            expect(installSource).toHaveBeenCalledWith(
              expect.objectContaining({
                id: 101,
                localPersonalSource: {
                  marketplacePath: '/tmp/wework-personal',
                  pluginName: 'documents',
                },
              }),
              expect.any(Function)
            )
          )
          expect(requestLocalExecutor).toHaveBeenCalledWith(
            'runtime.codex.plugin.install_local_first',
            {
              marketplacePath: '/tmp/wework-personal/.agents/plugins/marketplace.json',
              pluginName: 'documents',
            }
          )
          const notice = await screen.findByTestId('plugin-operation-notice')
          if (outcome === 'fresh-oauth-denied') {
            expect(notice).toHaveAttribute('data-notice-kind', 'error')
            expect(listWegentConnectorApps).toHaveBeenCalled()
            expect(requestLocalExecutor).toHaveBeenCalledWith(
              'runtime.codex.plugin.uninstall_local',
              expect.objectContaining({ pluginName: 'documents' })
            )
          } else {
            expect(notice).toHaveTextContent('已安装')
          }
          const healthCalls = vi
            .mocked(requestLocalExecutor)
            .mock.calls.filter(([method]) => method === 'runtime.local_connector_auth.health')
          if (outcome === 'fresh-local-auth') {
            expect(healthCalls).toEqual([
              [
                'runtime.local_connector_auth.health',
                expect.objectContaining({
                  connectorSlug: 'fresh-source',
                  pluginKey: 'documents',
                }),
              ],
            ])
            expect(
              getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins.find(
                plugin => plugin.spec.source.pluginKey === 'documents'
              )?.spec.components.connectors
            ).toEqual([expect.objectContaining(freshConnector)])
          } else if (authScenario) {
            expect(healthCalls).toEqual([])
          }
        } else if (ownerDenied) {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveAttribute(
            'data-notice-kind',
            'error'
          )
        } else {
          expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
          expect(await screen.findByTestId('plugin-marketplace-install-101')).toBeEnabled()
        }
        if (ownerDenied || outcome === 'switched') {
          expect(installSource).not.toHaveBeenCalled()
        }
        expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
          false
        )
        expect(
          vi
            .mocked(fetch)
            .mock.calls.some(
              ([input, init]) =>
                String(input).includes('/plugins/marketplace/101/install') &&
                init?.method === 'POST'
            )
        ).toBe(false)
      } finally {
        factory.mockRestore()
        bundledMarketplace.mockRestore()
      }
    }
  )

  test.each([true, false])(
    'keeps a recipient with stale personal-source metadata on the cloud install path (connected=%s)',
    async backendConnected => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'recipient',
      })
      mockCodexAppServerInvoke({ installedPluginNames: [], backendConnected })
      const fetcher = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const response = await fetcher(input, init)
        if (new URL(String(input), 'http://localhost').pathname !== '/api/plugins/marketplace') {
          return response
        }
        const catalog = await response.json()
        return Response.json({
          ...catalog,
          items: catalog.items.map((item: PluginMarketplaceItem) => ({
            ...item,
            localPersonalSource: {
              marketplacePath: '/tmp/wework-personal',
              pluginName: 'documents',
            },
          })),
        })
      })
      const api = createLocalCodexPluginApi()
      const installSource = vi.fn(api.installPersonalPluginSource)
      const factory = vi.spyOn(codexPlugins, 'createLocalCodexPluginApi').mockReturnValue({
        ...api,
        installPersonalPluginSource: installSource,
      })
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await screen.findByTestId('plugin-marketplace-install-101')
        await userEvent.click(screen.getByTestId('plugin-marketplace-install-101'))
        if (backendConnected) {
          await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('已安装')
          expectFetchRequest(
            '/api/plugins/marketplace/101/install?device_id=current-device',
            'POST'
          )
        } else {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
            '当前设备未连接到云端'
          )
          expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
          expect(
            vi
              .mocked(fetch)
              .mock.calls.some(([input]) =>
                String(input).includes('/plugins/marketplace/101/install')
              )
          ).toBe(false)
        }
        expect(installSource).not.toHaveBeenCalled()
        expect(
          vi
            .mocked(fetch)
            .mock.calls.some(([input]) => String(input).includes('/plugins/marketplace/101/owner'))
        ).toBe(false)
        expect(requestLocalExecutor).not.toHaveBeenCalledWith(
          'runtime.codex.plugin.install_local_first',
          expect.anything()
        )
      } finally {
        factory.mockRestore()
      }
    }
  )

  test('keeps cloud updates gated for an installed author with local source while disconnected', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceInstalled: true,
      marketplaceUpdateAvailable: true,
    })
    mockCodexAppServerInvoke({ installedPluginNames: [], backendConnected: false })
    const fetcher = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const response = await fetcher(input, init)
      if (new URL(String(input), 'http://localhost').pathname !== '/api/plugins/marketplace') {
        return response
      }
      const catalog = await response.json()
      return Response.json({
        ...catalog,
        items: catalog.items.map((item: PluginMarketplaceItem) => ({
          ...item,
          localPersonalSource: {
            marketplacePath: '/tmp/wework-personal',
            pluginName: 'documents',
          },
        })),
      })
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    const action = await screen.findByTestId('plugin-detail-toggle-101')
    await waitFor(() => expect(action).toHaveTextContent('更新'))
    await userEvent.click(action)

    expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
      '当前设备未连接到云端'
    )
    expect(screen.queryByTestId('plugin-update-confirm-button')).not.toBeInTheDocument()
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([input, init]) =>
            String(input).includes('/plugins/installed/101') && init?.method === 'PUT'
        )
    ).toBe(false)
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      'runtime.codex.plugin.install_local_first',
      expect.anything()
    )
  })

  test.each([false, true])(
    'strictly confirms an apparently unlinked local source before uninstall (links unavailable=%s)',
    async linksUnavailable => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const bundledMarketplace = vi
        .spyOn(localExecutor, 'getInitializedBundledPluginMarketplace')
        .mockReturnValue({
          id: 'wework-personal',
          path: '/tmp/wework-personal',
          defaultPluginNames: [],
        })
      mockSystemSkillsFetch({
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'owner',
        marketplaceName: 'dev-tools',
        marketplaceDisplayName: 'Dev Tools',
        marketplaceInstalled: linksUnavailable,
      })
      mockCodexAppServerInvoke({
        deviceId: 'current-device',
        installedPluginNames: ['dev-tools'],
        marketplaces: [
          {
            name: 'wework-personal',
            path: '/tmp/wework-personal',
            plugins: [{ id: 'dev-tools-local', name: 'dev-tools', displayName: 'Dev Tools' }],
          },
        ],
      })
      let linkReads = 0
      const invoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
        if (method === 'executor.plugins.links.list') {
          linkReads += 1
          return linksUnavailable
            ? Promise.reject(new Error('Invalid plugin cloud link registry'))
            : Promise.resolve([])
        }
        return invoke(method, args)
      })
      const logout = vi
        .spyOn(connectorCleanup, 'logoutLocalConnectorsForPlugin')
        .mockResolvedValue(undefined)
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

      try {
        if (linksUnavailable) {
          await waitFor(() =>
            expect(
              getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins.some(
                plugin => plugin.spec.pluginId === 101
              )
            ).toBe(true)
          )
        }
        await userEvent.click(
          await screen.findByTestId('plugins-installed-strip-item-dev-tools-local')
        )
        await userEvent.click(screen.getByTestId('plugin-detail-actions-dev-tools-local'))
        await userEvent.click(screen.getByTestId('plugin-detail-uninstall-dev-tools-local'))
        const readsBeforeUninstall = linkReads
        if (linksUnavailable) {
          expect(readsBeforeUninstall).toBeGreaterThan(0)
        }
        await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

        if (linksUnavailable) {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
            '暂时无法确认当前账号的插件安装状态'
          )
          expect(logout).not.toHaveBeenCalled()
          expect(requestLocalExecutor).not.toHaveBeenCalledWith(
            'runtime.codex.plugin.uninstall_local',
            expect.anything()
          )
          expect(
            getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins.some(
              plugin => plugin.spec.source.pluginKey === 'dev-tools'
            )
          ).toBe(true)
        } else {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent('已卸载')
          expect(logout).toHaveBeenCalledOnce()
          expect(requestLocalExecutor).toHaveBeenCalledWith(
            'runtime.codex.plugin.uninstall_local',
            { pluginName: 'dev-tools' }
          )
        }
        expect(linkReads).toBeGreaterThan(readsBeforeUninstall)
        expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
          false
        )
        expectCodexAppServerRequestNotCalled('plugin/uninstall')
      } finally {
        view.unmount()
        logout.mockRestore()
        bundledMarketplace.mockRestore()
      }
    }
  )

  test.each(['none', 'current', 'unavailable', 'account-change', 'unmount'])(
    'preflights source uninstall before connector or runtime cleanup (%s)',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const bundledMarketplace = vi
        .spyOn(localExecutor, 'getInitializedBundledPluginMarketplace')
        .mockReturnValue({
          id: 'wework-personal',
          path: '/tmp/wework-personal',
          defaultPluginNames: [],
        })
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
            path: '/tmp/wework-personal',
            plugins: [{ id: 'dev-tools-local', name: 'dev-tools', displayName: 'Dev Tools' }],
          },
        ],
        cloudLinks: [{ localPluginName: 'dev-tools', cloudPluginId: 101, cloudReleaseId: 1001 }],
      })
      const localApi = createLocalCodexPluginApi()
      const uninstallLocal = vi
        .spyOn(localApi, 'uninstallInstalledPlugin')
        .mockResolvedValue(undefined)
      const createApi = vi
        .spyOn(codexPlugins, 'createLocalCodexPluginApi')
        .mockReturnValue(localApi)
      const logout = vi
        .spyOn(connectorCleanup, 'logoutLocalConnectorsForPlugin')
        .mockResolvedValue(undefined)
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      let finish!: (response: Response) => void
      const pending = new Promise<Response>(resolve => {
        finish = resolve
      })
      try {
        await userEvent.click(
          await screen.findByTestId('plugins-installed-strip-item-dev-tools-local')
        )
        await userEvent.click(screen.getByRole('button', { name: '插件操作' }))
        await userEvent.click(screen.getByTestId('plugin-detail-uninstall-dev-tools-local'))
        expect(screen.getByTestId('uninstall-plugin-dialog')).toHaveTextContent(
          '源码、已分享版本和分享范围会保留'
        )
        const source = getPluginMarketplaceCache('/api|cloud-token')!.installedPlugins.find(
          plugin => plugin.spec.source.pluginKey === 'dev-tools'
        )!
        const originalFetch = vi.mocked(fetch).getMockImplementation()!
        let preflightReads = 0
        vi.mocked(fetch).mockImplementation((input, init) => {
          if (String(input).endsWith('/plugins/installed') && preflightReads === 0) {
            preflightReads += 1
            return pending
          }
          if (String(input).includes('/plugins/installed/208') && init?.method === 'DELETE') {
            return Promise.resolve(new Response(null, { status: 204 }))
          }
          return originalFetch(input, init)
        })
        await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
        await waitFor(() => expect(preflightReads).toBe(1))
        expect(logout).not.toHaveBeenCalled()
        expect(uninstallLocal).not.toHaveBeenCalled()
        if (outcome === 'account-change') {
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account" />)
        } else if (outcome === 'unmount') view.unmount()
        const cloud = {
          ...source,
          metadata: { ...source.metadata, labels: { id: 208 } },
          spec: { ...source.spec, pluginId: 101, releaseId: 1001 },
        }
        await act(async () =>
          finish(
            outcome === 'unavailable'
              ? Response.json({ detail: 'Unavailable' }, { status: 503 })
              : Response.json({ items: outcome === 'current' ? [cloud] : [] })
          )
        )
        if (outcome === 'none' || outcome === 'current') {
          await waitFor(() => expect(uninstallLocal).toHaveBeenCalledWith('dev-tools-local'))
          expect(logout).toHaveBeenCalledOnce()
        } else {
          if (outcome === 'unavailable') {
            expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
              '暂时无法确认当前账号的插件安装状态'
            )
          }
          expect(logout).not.toHaveBeenCalled()
          expect(uninstallLocal).not.toHaveBeenCalled()
        }
        const deletes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')
        expect(deletes).toHaveLength(outcome === 'current' ? 1 : 0)
        if (outcome === 'current') expect(String(deletes[0][0])).toBe('/api/plugins/installed/208')
      } finally {
        finish(Response.json({ items: [] }))
        view.unmount()
        uninstallLocal.mockRestore()
        createApi.mockRestore()
        logout.mockRestore()
        bundledMarketplace.mockRestore()
      }
    }
  )

  test.each([false, true])(
    'uninstalls a local Codex plugin omitted from the installed list (links unavailable=%s)',
    async linksUnavailable => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const bundledMarketplace = vi
        .spyOn(localExecutor, 'getInitializedBundledPluginMarketplace')
        .mockReturnValue({
          id: 'wework-personal',
          path: '/tmp/wework-personal',
          defaultPluginNames: [],
        })
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
      const invoke = vi.mocked(requestLocalExecutor).getMockImplementation()!
      vi.mocked(requestLocalExecutor).mockImplementation((method, args) => {
        if (method === 'executor.plugins.links.list' && linksUnavailable) {
          return Promise.reject(new Error('Invalid plugin cloud link registry'))
        }
        return invoke(method, args)
      })
      const logout = vi
        .spyOn(connectorCleanup, 'logoutLocalConnectorsForPlugin')
        .mockResolvedValue(undefined)
      // Complete the immediate inventory fixture before asserting catalog rows.
      let view!: ReturnType<typeof render>
      await act(async () => {
        view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      })
      try {
        expect(await screen.findByText('Superpowers')).toBeInTheDocument()
        await waitFor(() =>
          expect(
            getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins.length
          ).toBeGreaterThan(0)
        )
        await userEvent.click(screen.getByTestId('plugin-marketplace-actions-superpowers-local-id'))
        await userEvent.click(
          screen.getByTestId('plugin-marketplace-uninstall-superpowers-local-id')
        )
        expect(screen.getByTestId('plugin-uninstall-confirm-button')).toBeInTheDocument()
        const snapshot = getPluginMarketplaceCache('/api|cloud-token')!
        // Keep the real catalog row while a canonical inventory update omits
        // its summary. The mutation must re-read native identity before cleanup.
        await act(async () => {
          setPluginMarketplaceCache({
            ...snapshot,
            installedPlugins: snapshot.installedPlugins.filter(
              plugin =>
                (plugin.metadata.labels as Record<string, unknown> | undefined)?.id !==
                'superpowers-local-id'
            ),
          })
        })
        await waitFor(() =>
          expect(
            screen.queryByTestId('plugins-installed-strip-item-superpowers-local-id')
          ).not.toBeInTheDocument()
        )
        await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

        if (linksUnavailable) {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
            '暂时无法确认当前账号的插件安装状态'
          )
          expect(logout).not.toHaveBeenCalled()
          expectCodexAppServerRequestNotCalled('plugin/uninstall')
        } else {
          await waitFor(() =>
            expectCodexAppServerRequest('plugin/uninstall', { pluginId: 'superpowers-local-id' })
          )
          expect(
            await screen.findByTestId('plugin-marketplace-install-superpowers-local-id')
          ).toHaveTextContent('安装')
          expect(
            screen.queryByTestId('plugin-marketplace-actions-superpowers-local-id')
          ).not.toBeInTheDocument()
        }
        expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
          false
        )
        expect(requestLocalExecutor).not.toHaveBeenCalledWith(
          'runtime.codex.plugin.uninstall_local',
          expect.anything()
        )
      } finally {
        view.unmount()
        logout.mockRestore()
        bundledMarketplace.mockRestore()
      }
    }
  )

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

  test('refreshes the Runtime route for component changes while retaining stable inventory identity', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const deviceId = 'electron-plugins'
    mockSystemSkillsFetch({
      deviceId,
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceHasSkill: true,
    })
    mockCodexAppServerInvoke({ deviceId, deviceRouteId: 'app-record-70' })
    const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
    writePluginInventory(cacheKey, deviceId, { installedPlugins: [] })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
    const toggle = await screen.findByTestId('plugin-component-toggle-skill:documents')
    await waitFor(() => expect(getPluginMarketplaceCache(cacheKey)?.deviceId).toBe(deviceId))
    const installed = getPluginMarketplaceCache(cacheKey)!.installedPlugins.find(
      plugin => String(plugin.metadata.labels?.id) === '101'
    )!
    expect(installed).toBeDefined()
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).includes('/plugins/installed/101') && args[1]?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            ...installed,
            spec: { ...installed.spec, componentStates: { 'skill:documents': false } },
            status: {
              ...installed.status,
              devices: [{ deviceId: 'app-record-71', state: 'installed' }],
            },
          })
        )
      }
      return originalFetch(...args)
    })
    localExecutorMocks.ensureAvailable.mockResolvedValue({
      running: true,
      ready: true,
      deviceId,
      deviceRouteId: 'app-record-71',
    })

    await userEvent.click(toggle)

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/installed/101?device_id=app-record-71',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ componentStates: { 'skill:documents': false } }),
        })
      )
    )
    await waitFor(() =>
      expect(getPluginMarketplaceCache(cacheKey)?.installedPlugins[0].spec.componentStates).toEqual(
        { 'skill:documents': false }
      )
    )
    expect(getPluginMarketplaceCache(cacheKey)?.deviceId).toBe(deviceId)
    expect(
      getPluginMarketplaceCache(cacheKey)?.installedPlugins[0].status.devices?.[0].deviceId
    ).toBe(deviceId)
    expect(localExecutorMocks.deviceRouteId).toBe('app-record-70')
  })

  test('keeps a plugin component disabled and enabled after saving in the same detail page', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceInstalled: true,
      marketplaceDeviceState: 'installed',
      marketplaceHasSkill: true,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    const inventory = await originalFetch('/api/plugins/installed')
    const { items } = (await inventory.json()) as InstalledPluginListResponse
    const installed = items[0]!
    let finishUpdate: (() => void) | undefined
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).startsWith('/api/plugins/installed/101?') && args[1]?.method === 'PUT') {
        const body = JSON.parse(String(args[1].body)) as {
          componentStates: Record<string, boolean>
        }
        await new Promise<void>(resolve => {
          finishUpdate = resolve
        })
        return new Response(
          JSON.stringify({
            ...installed,
            spec: { ...installed.spec, componentStates: body.componentStates },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return originalFetch(...args)
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

    await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
    const toggle = await screen.findByTestId('plugin-component-toggle-skill:documents')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    for (const enabled of [false, true]) {
      finishUpdate = undefined
      await userEvent.click(toggle)

      expect(toggle).toHaveAttribute('aria-checked', String(enabled))
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/installed/101?device_id=current-device',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ componentStates: { 'skill:documents': enabled } }),
        })
      )
      await act(async () => finishUpdate!())
      await waitFor(() =>
        expect(telemetryMocks.track).toHaveBeenCalledWith(
          'plugin_enabled_changed',
          expect.objectContaining({ enabled, scope: 'component' })
        )
      )
      expect(toggle).toHaveAttribute('aria-checked', String(enabled))
    }
  })

  test.each(['success', 'failure', 'account switch', 'device switch', 'page navigation'] as const)(
    'keeps component settings current after %s',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceDeviceState: 'installed',
        marketplaceHasSkill: true,
      })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      const response = await originalFetch('/api/plugins/installed')
      const { items } = (await response.json()) as InstalledPluginListResponse
      const installed = items[0]!
      let releaseOld!: (response: Response) => void
      const oldResponse = new Promise<Response>(resolve => {
        releaseOld = resolve
      })
      vi.mocked(fetch).mockImplementation(async (...args) => {
        if (
          String(args[0]).startsWith('/api/plugins/installed/101?') &&
          args[1]?.method === 'PUT'
        ) {
          const request = JSON.parse(String(args[1].body)) as {
            componentStates: Record<string, boolean>
          }
          if (!request.componentStates['skill:documents']) return oldResponse
          return Response.json({
            ...installed,
            spec: { ...installed.spec, componentStates: request.componentStates },
          })
        }
        return originalFetch(...args)
      })
      const { rerender, unmount } = render(
        <PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />
      )
      await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
      const toggle = await screen.findByTestId('plugin-component-toggle-skill:documents')
      await userEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      if (outcome === 'page navigation') {
        unmount()
        await act(async () =>
          releaseOld(
            Response.json({
              ...installed,
              spec: { ...installed.spec, componentStates: { 'skill:documents': false } },
            })
          )
        )
        expect(
          getPluginMarketplaceCache(pluginMarketplaceCacheKey('/api', 'cloud-token'))
            ?.installedPlugins[0].spec.componentStates['skill:documents']
        ).toBe(false)
        return
      }
      const token = outcome === 'account switch' ? 'other-account' : 'cloud-token'
      const deviceId = outcome === 'device switch' ? 'other-device' : 'current-device'
      if (outcome === 'account switch' || outcome === 'device switch') {
        mockKnownExecutorDevice(deviceId)
        rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken={token} />)
      } else await userEvent.click(toggle)
      const key = pluginMarketplaceCacheKey('/api', token)
      await waitFor(() => expect(getPluginMarketplaceCache(key)?.deviceId).toBe(deviceId))
      if (outcome === 'account switch' || outcome === 'device switch')
        await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-101'))
      const activeToggle = await screen.findByTestId('plugin-component-toggle-skill:documents')
      await waitFor(() => expect(activeToggle).toHaveAttribute('aria-checked', 'true'))
      if (outcome === 'success' || outcome === 'failure')
        await waitFor(() =>
          expect(
            getPluginMarketplaceCache(key)?.installedPlugins[0].spec.componentStates[
              'skill:documents'
            ]
          ).toBe(true)
        )
      const before = getPluginMarketplaceCache(key)

      await act(async () =>
        releaseOld(
          outcome === 'failure'
            ? Response.json({ detail: 'Old save failed' }, { status: 500 })
            : Response.json({
                ...installed,
                spec: { ...installed.spec, componentStates: { 'skill:documents': false } },
              })
        )
      )

      expect(activeToggle).toHaveAttribute('aria-checked', 'true')
      expect(getPluginMarketplaceCache(key)).toBe(before)
      expect(telemetryMocks.track).not.toHaveBeenCalledWith('operation_failed', {
        operation: 'plugin_toggle',
      })
    }
  )

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
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const marketplaceRequestsBefore = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes('/api/plugins/marketplace')).length

    await userEvent.click(toggle)
    await waitFor(() =>
      expect(telemetryMocks.track).toHaveBeenCalledWith('operation_failed', {
        operation: 'plugin_toggle',
      })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101?device_id=current-device',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ componentStates: { 'skill:documents': false } }),
      })
    )
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes('/api/plugins/marketplace'))
    ).toHaveLength(marketplaceRequestsBefore)
  })

  test.each([false, true])(
    'installed local GitHub detail ignores stale catalog routing and offers recoverable login (failure=%s)',
    async failFirst => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      seedDurableOpenAiGithubPeek({ seedInventory: true })
      const staleCatalog = JSON.parse(
        window.localStorage.getItem('wework.plugins.codexCatalog.v1')!
      )
      for (const entry of Object.values(staleCatalog.entries) as Array<{
        state: { marketplaceItems: unknown[]; installedPlugins: unknown[] }
      }>) {
        entry.state.marketplaceItems = []
        entry.state.installedPlugins = []
      }
      window.localStorage.setItem('wework.plugins.codexCatalog.v1', JSON.stringify(staleCatalog))
      const snapshot = getPluginMarketplaceCache('|anon')!
      const source = { id: 'openai-official', path: '/tmp/github-marketplace', name: 'OpenAI' }
      setPluginMarketplaceCache(
        {
          ...snapshot,
          marketplaces: [{ ...source, key: 'local:openai-official', kind: 'local' }],
          installedPlugins: snapshot.installedPlugins.map(plugin => ({
            ...plugin,
            metadata: {
              ...plugin.metadata,
              namespace: source.id,
              labels: { id: `github@${source.id}` },
            },
            spec: {
              ...plugin.spec,
              source: { ...plugin.spec.source, providerKey: source.id, marketplace: source.id },
              sourcePayload: {
                marketplaceName: source.id,
                marketplacePath: source.path,
                pluginName: 'github',
              },
            },
          })),
          marketplaceItems: snapshot.marketplaceItems.map(item => ({
            ...item,
            id: `github@${source.id}`,
            installedPluginId: `github@${source.id}`,
            manifest: { marketplaceId: source.id },
          })),
        },
        { remoteCatalog: true }
      )
      mockCodexAppServerInvoke({
        deviceId: 'local-device',
        marketplaces: [
          {
            name: source.id,
            path: source.path,
            plugins: [{ id: `github@${source.id}`, name: 'github', displayName: 'GitHub' }],
          },
        ],
        installedPluginNames: ['github'],
        localConnectorAuthHealth: async () => ({ status: 'need_login' }),
      })
      const previousInvoke = vi.mocked(requestLocalExecutor).getMockImplementation()
      let rejected = false
      let releaseDetail: (() => void) | undefined
      vi.mocked(requestLocalExecutor).mockImplementation((command: string, args?: unknown) => {
        if (command === 'executor.plugins.manifest.read') {
          expect(args).toEqual({ marketplacePath: source.path, pluginName: 'github' })
          return Promise.resolve({ connectors: [{ slug: 'github', authPolicy: 'on_use' }] })
        }
        if (command === 'codex.app_server_request') {
          const request = args as { method?: string; params?: Record<string, unknown> }
          if (request.method === 'plugin/list') return new Promise(() => undefined)
          if (request.method === 'plugin/read') {
            expect(request.params).toMatchObject({
              marketplacePath: `${source.path}/.agents/plugins/marketplace.json`,
              remoteMarketplaceName: null,
              pluginName: 'github',
            })
            if (failFirst && !rejected) {
              rejected = true
              return Promise.reject(new Error('403 <html><svg>upstream response</svg></html>'))
            }
            return new Promise(resolve => {
              releaseDetail = () => {
                void Promise.resolve(previousInvoke?.(command, args)).then(resolve)
              }
            })
          }
        }
        return previousInvoke?.(command, args) as Promise<unknown>
      })

      render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)
      await userEvent.click(await screen.findByTestId(`plugin-marketplace-row-github@${source.id}`))
      if (failFirst) {
        expect(await screen.findByTestId('plugin-detail-action-error')).toHaveTextContent(
          '插件详情加载失败，请重试。'
        )
        expect(screen.queryByText(/upstream response/)).not.toBeInTheDocument()
        await userEvent.click(screen.getByTestId('plugin-detail-load-retry'))
      }
      await waitFor(() => expect(releaseDetail).toBeTypeOf('function'))
      expect(screen.getByTestId('plugin-detail-loading')).toBeInTheDocument()
      expect(
        screen.queryByTestId('plugin-connection-manage-connector:github')
      ).not.toBeInTheDocument()
      await act(async () => releaseDetail!())
      await waitFor(() =>
        expect(screen.getByTestId('plugin-connection-manage-connector:github')).toHaveTextContent(
          '登录'
        )
      )
      expect(screen.queryByTestId('plugin-detail-loading')).not.toBeInTheDocument()
      expect(screen.queryByTestId('plugin-detail-action-error')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('plugin-connection-manage-connector:github'))
      expect(await screen.findByTestId('plugin-github-cli-auth-dialog')).toBeInTheDocument()
    }
  )

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

    // Flush the deferred local catalog's transition before exercising the detail UI.
    await act(async () => {
      render(<PluginsWorkspace cloudMarketplaceAvailable={false} />)
    })

    expect(screen.getByText('Code Review')).toBeInTheDocument()
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

  test.each([
    ['catalog', false],
    ['catalog', true],
    ['installed', false],
    ['installed', true],
  ] as const)(
    'blocks uninstalling examples and stale callbacks, then restores use (entry=%s, local=%s)',
    async (entry, local) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const marketplace = mockSystemSkillsFetch({
        marketplaceInstalled: entry === 'installed' || local,
        marketplaceDeviceState: 'installed',
        localVersionEvidence: local ? '1.0.0' : undefined,
        marketplaceVisibility: 'workspace',
        marketplaceSourceProvider: 'wegent',
      })
      if (entry === 'installed') {
        const originalFetch = vi.mocked(fetch).getMockImplementation()!
        vi.mocked(fetch).mockImplementation((url, init) => {
          if (
            new URL(String(url), window.location.origin).pathname === '/api/plugins/marketplace'
          ) {
            return Promise.resolve(
              new Response(JSON.stringify({ items: [], total: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            )
          }
          return originalFetch(url, init)
        })
      }
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const originalDetail = pluginDetailView.PluginDetailView
      let detailProps!: Parameters<typeof originalDetail>[0]
      const detailSpy = vi.spyOn(pluginDetailView, 'PluginDetailView').mockImplementation(props => {
        detailProps = props
        return originalDetail(props)
      })
      const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
      const installationPosts = () =>
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([url, init]) =>
              String(url).includes('/plugins/marketplace/101/install') && init?.method === 'POST'
          )
      const publishInstallation = async (
        installed: boolean,
        state: 'installed' | 'uninstalling'
      ) => {
        marketplace.setMarketplaceInstallation(installed, state)
        const [catalog, inventory] = await Promise.all([
          fetch('/api/plugins/marketplace?device_id=current-device').then(response =>
            response.json()
          ),
          fetch('/api/plugins/installed?device_id=current-device').then(response =>
            response.json()
          ),
        ])
        const cached = getPluginMarketplaceCache('/api|cloud-token')!
        act(() =>
          setPluginMarketplaceCache({
            ...cached,
            marketplaceItems: mergeMarketplaceCatalog(catalog.items, [], inventory.items),
            installedPlugins: inventory.items,
            fetchedAt: Date.now(),
          })
        )
      }
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await userEvent.click(
          await screen.findByTestId(
            entry === 'catalog' ? 'plugin-marketplace-row-101' : 'plugins-installed-strip-item-101'
          )
        )
        await waitFor(() => expect(screen.getByTestId('plugin-prompt-0')).not.toBeDisabled())
        const stalePrompt = detailProps.onPromptSelect!
        const staleToggle = detailProps.onToggle
        const needsInstall = entry === 'catalog' && !local
        if (needsInstall) {
          const originalEnsure = localExecutorMocks.ensureAvailable.getMockImplementation()!
          let finishPreflight!: () => void
          let preflightHeld = false
          const gate = new Promise<void>(resolve => {
            finishPreflight = resolve
          })
          localExecutorMocks.ensureAvailable.mockImplementation(async options => {
            if (options?.refresh) {
              preflightHeld = true
              await gate
            }
            return originalEnsure(options)
          })
          act(() => stalePrompt('Review this change'))
          await waitFor(() => expect(preflightHeld).toBe(true))
          await publishInstallation(true, 'uninstalling')
          await act(async () => finishPreflight())
        } else {
          await publishInstallation(true, 'uninstalling')
        }
        await waitFor(() => expect(screen.getByTestId('plugin-detail-toggle-101')).toBeDisabled())
        const example = screen.getByTestId('plugin-prompt-0')
        expect(example).toBeDisabled()
        sessionStorage.removeItem('wework:pending-plugin-trial')
        navigate.mockClear()
        await userEvent.click(example)
        await act(async () => {
          detailProps.onPromptSelect!('Review this change')
          detailProps.onToggle()
          stalePrompt('Review this change')
          staleToggle()
        })
        expect(installationPosts()).toHaveLength(0)
        expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
        expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
        expect(navigate).not.toHaveBeenCalled()
        expect(marketplace.getSyncDeviceCalls()).toBe(0)
        await publishInstallation(!needsInstall, 'installed')
        await waitFor(() => expect(screen.getByTestId('plugin-prompt-0')).not.toBeDisabled())
        await userEvent.click(screen.getByTestId('plugin-prompt-0'))
        if (needsInstall) {
          await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
          await waitFor(() => expect(installationPosts()).toHaveLength(1))
        }
        await waitFor(() =>
          expect(sessionStorage.getItem('wework:pending-plugin-trial')).not.toBeNull()
        )
        expect(navigate).toHaveBeenCalledWith('/')
        expect(installationPosts()).toHaveLength(needsInstall ? 1 : 0)
      } finally {
        detailSpy.mockRestore()
        navigate.mockRestore()
      }
    }
  )

  test('blocks installed local detail callbacks until a failed uninstall settles', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockEmptyCloudPluginApis()
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      marketplaces: [
        {
          name: 'wework-personal',
          path: '/tmp/wework-personal',
          plugins: [{ id: 'documents-local-id', name: 'documents', displayName: 'Documents' }],
        },
      ],
      installedPluginNames: ['documents'],
    })
    let failUninstall!: (error: Error) => void
    const uninstall = vi.spyOn(pluginUninstall, 'uninstallPluginIdentities').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failUninstall = reject
        })
    )
    const originalDetail = pluginDetailView.PluginDetailView
    let detailProps!: Parameters<typeof originalDetail>[0]
    const detailSpy = vi.spyOn(pluginDetailView, 'PluginDetailView').mockImplementation(props => {
      detailProps = props
      return originalDetail(props)
    })
    const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
    try {
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await userEvent.click(
        await screen.findByTestId('plugins-installed-strip-item-documents-local-id')
      )
      const stalePrompt = detailProps.onPromptSelect!
      const staleToggle = detailProps.onToggle
      await userEvent.click(screen.getByTestId('plugin-detail-actions-documents-local-id'))
      await userEvent.click(screen.getByTestId('plugin-detail-uninstall-documents-local-id'))
      await userEvent.click(await screen.findByTestId('plugin-uninstall-confirm-button'))
      expect(uninstall).toHaveBeenCalledOnce()
      expect(screen.getByTestId('plugin-detail-toggle-documents-local-id')).toBeDisabled()
      expect(screen.getByTestId('plugin-prompt-0')).toBeDisabled()
      sessionStorage.removeItem('wework:pending-plugin-trial')
      navigate.mockClear()
      await act(async () => {
        detailProps.onPromptSelect!('Review this change')
        detailProps.onToggle()
        stalePrompt('Review this change')
        staleToggle()
      })
      expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
      expect(navigate).not.toHaveBeenCalled()
      await act(async () => failUninstall(new Error('Local cleanup is unavailable')))
      await waitFor(() => expect(screen.getByTestId('plugin-prompt-0')).not.toBeDisabled())
      await userEvent.click(screen.getByTestId('plugin-prompt-0'))
      expect(sessionStorage.getItem('wework:pending-plugin-trial')).not.toBeNull()
      expect(navigate).toHaveBeenCalledWith('/')
    } finally {
      uninstall.mockRestore()
      detailSpy.mockRestore()
      navigate.mockRestore()
    }
  })

  test.each([
    ['install', 'workspace', 'wegent'],
    ['trial', 'workspace', 'wegent'],
    ['install', 'public', 'user'],
    ['trial', 'public', 'user'],
  ] as const)(
    'requires unofficial plugin confirmation before %s for %s from %s and preserves cancellation',
    async (action, visibility, sourceProvider) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceVisibility: visibility,
        marketplaceSourceProvider: sourceProvider,
      })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      sessionStorage.clear()
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)

      await screen.findByTestId('plugin-marketplace-row-101')
      if (action === 'trial') {
        await userEvent.click(screen.getByTestId('plugin-marketplace-row-101'))
      }
      const trigger = action === 'trial' ? 'plugin-prompt-0' : 'plugin-marketplace-install-101'
      await userEvent.click(screen.getByTestId(trigger))
      expect(await screen.findByTestId('plugin-install-unofficial-warning')).toBeInTheDocument()
      const installed = () =>
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, init]) =>
              String(url).includes('/plugins/marketplace/101/install') && init?.method === 'POST'
          )
      expect(installed()).toBe(false)
      await userEvent.click(screen.getByTestId('install-plugin-dialog-cancel'))
      expect(screen.queryByTestId('install-plugin-dialog')).not.toBeInTheDocument()
      expect(installed()).toBe(false)
      expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()

      await userEvent.click(screen.getByTestId(trigger))
      await userEvent.click(await screen.findByTestId('install-plugin-dialog-confirm'))
      await waitFor(() => expect(installed()).toBe(true))
      if (action === 'install') {
        await screen.findByTestId('plugin-marketplace-actions-101')
      }
      if (action === 'trial') {
        await waitFor(() =>
          expect(
            JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')
          ).toMatchObject({
            input: expect.stringContaining('Draft a document outline from this chat'),
            openInNewChat: true,
          })
        )
      }
    }
  )

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

  test.each(['marketplace', 'installed'])(
    'keeps a received personal plugin read only from the %s entry',
    async entry => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'recipient',
        marketplaceName: 'dev-tools',
        marketplaceDisplayName: 'Dev Tools',
      })
      mockCodexAppServerInvoke({
        deviceId: 'current-device',
        installedPluginNames: ['dev-tools'],
        marketplaces: [
          {
            name: 'wework-personal',
            path: '/tmp/recipient/wework-personal',
            plugins: [{ id: 'shared-local', name: 'dev-tools', displayName: 'Dev Tools' }],
          },
        ],
      })
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      const entryId =
        entry === 'marketplace' ? 'plugin-marketplace-row-101' : 'plugins-installed-strip-item-101'
      await userEvent.click(await screen.findByTestId(entryId))
      expect(screen.queryByTestId(/^plugin-detail-share-/)).not.toBeInTheDocument()
      expect(screen.queryByTestId('plugin-detail-manage-access')).not.toBeInTheDocument()
      expect(screen.queryByTestId('plugin-version-submit-open')).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: '插件操作' }))
      expect(screen.queryByTestId(/^plugin-detail-edit-/)).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^plugin-detail-delete-/)).not.toBeInTheDocument()
      expect(screen.getByTestId(/^plugin-detail-uninstall-/)).toBeInTheDocument()
    }
  )

  test('does not treat a display name equal to another owners plugin key as ownership', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'target-b',
      marketplaceDisplayName: 'Target B',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      installedPluginNames: ['source-a'],
      marketplaces: [
        {
          name: 'wework-personal',
          path: '/tmp/owner/wework-personal',
          plugins: [{ id: 'source-a-local', name: 'source-a', displayName: 'target-b' }],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugins-installed-strip-item-source-a-local'))
    expect(screen.queryByTestId('plugin-detail-manage-access')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId(/^plugin-detail-share-/))
    expect(await screen.findByTestId('plugin-share-intent-dialog')).toBeInTheDocument()
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('/marketplace/101/access'))
    ).toBe(false)
  })

  test('ignores sharing readiness arriving after an account switch', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    let releaseAccess!: () => void
    const pluginAccessGate = new Promise<void>(resolve => {
      releaseAccess = resolve
    })
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
      marketplaceName: 'dev-tools',
      marketplaceDisplayName: 'Dev Tools',
      pluginAccessGate,
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
    await userEvent.click(screen.getByTestId(/^plugin-detail-share-/))
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).includes('/marketplace/101/access'))
      ).toBe(true)
    )
    view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="another-account-token" />)
    await act(async () => {
      releaseAccess()
    })
    expect(screen.queryByTestId('plugin-share-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-share-intent-dialog')).not.toBeInTheDocument()
  })

  const personalVersionScenarios = [
    'success',
    'stale-catalog',
    'normalized-name',
    'normalized-name-reference',
    'scan-failure',
    'superseded',
    'account-change',
  ]

  test.each(personalVersionScenarios)(
    'submits a new personal version explicitly and preserves scope (%s)',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const normalizedName = outcome.startsWith('normalized-name')
      const pluginKey = normalizedName ? 'gitlab-engineering' : 'dev-tools'
      const pluginName = normalizedName ? 'GitLab Engineering' : 'dev-tools'
      mockSystemSkillsFetch({
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'owner',
        marketplaceName: pluginName,
        marketplaceDisplayName: 'Dev Tools',
      })
      mockCodexAppServerInvoke({
        deviceId: 'current-device',
        installedPluginNames: [pluginKey],
        marketplaces: [
          {
            name: 'wework-personal',
            displayName: 'Personal',
            path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
            plugins: [
              {
                id: 'dev-tools-local',
                name: pluginKey,
                localVersion: '2.0.0',
                displayName: normalizedName ? 'New Engineering Tools' : 'Dev Tools',
                description: 'Updated developer tools',
              },
            ],
          },
        ],
      })
      const initialCatalog = await (await fetch('/api/plugins/marketplace')).json()
      const publishedPlugin = {
        ...initialCatalog.items[0],
        version: outcome === 'superseded' ? '3.0.0' : '2.0.0',
        latestReleaseId: outcome === 'superseded' ? 1003 : 1002,
      }
      const previousFetch = vi.mocked(fetch).getMockImplementation()!
      let submittedMetadata: Record<string, unknown> | undefined
      vi.mocked(fetch).mockImplementation((input, init) => {
        const path = new URL(String(input), 'http://localhost').pathname
        if (path === '/api/plugins/submissions/init') {
          submittedMetadata = JSON.parse(String(init?.body))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              submissionId: 91,
              pluginId: 101,
              releaseId: 1002,
              uploadUrl: '/plugin-upload',
              expiresAt: '',
            }),
          } as Response)
        }
        if (path === '/plugin-upload' || path === '/api/plugins/submissions/91/cancel') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
        }
        if (path === '/api/plugins/submissions/91/complete') {
          return Promise.resolve(
            outcome === 'scan-failure'
              ? ({
                  ok: false,
                  status: 422,
                  text: async () => JSON.stringify({ detail: 'Package scan failed' }),
                } as Response)
              : ({
                  ok: true,
                  status: 200,
                  json: async () => ({
                    submission: {
                      id: 91,
                      pluginId: 101,
                      releaseId: 1002,
                      status: 'approved',
                      reviewNote: '',
                    },
                    plugin: publishedPlugin,
                  }),
                } as Response)
          )
        }
        return previousFetch(input, init)
      })
      const localApi = createLocalCodexPluginApi()
      let releaseStaleCatalog: (() => void) | undefined
      const staleRead =
        outcome === 'stale-catalog'
          ? vi.spyOn(localApi, 'readState').mockImplementationOnce(async () => {
              const snapshot = await createLocalCodexPluginApi().readState({
                mergeAllMarketplaces: true,
              })
              await new Promise<void>(resolve => {
                releaseStaleCatalog = resolve
              })
              return { ...snapshot, installedPlugins: [] }
            })
          : undefined
      const packagePlugin = vi
        .spyOn(localApi, 'packageCreatedPlugin')
        .mockResolvedValue(new File(['new package'], 'dev-tools.zip'))
      const hash = vi.spyOn(fileHash, 'sha256Hex').mockResolvedValue('a'.repeat(64))
      const createApi = vi
        .spyOn(codexPlugins, 'createLocalCodexPluginApi')
        .mockReturnValue(localApi)
      const view = render(
        <PluginsWorkspace
          cloudApiBaseUrl="/api"
          cloudToken="cloud-token"
          pluginReference={
            outcome === 'normalized-name-reference'
              ? { pluginName, marketplaceName: 'wework-personal' }
              : undefined
          }
        />
      )
      try {
        if (outcome === 'normalized-name-reference') {
          await userEvent.click(await screen.findByTestId('plugin-detail-share-101'))
          expect(await screen.findByTestId('plugin-share-intent-dialog')).toHaveTextContent(
            'New Engineering Tools'
          )
          await userEvent.click(screen.getByTestId('plugin-publish-close'))
        } else {
          await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
        }
        expect(await screen.findByTestId('plugin-version-submit-notice')).toHaveTextContent(
          '本地 v2.0.0 · 已分享 v1.0.0'
        )
        if (outcome === 'stale-catalog') {
          await waitFor(() => expect(releaseStaleCatalog).toBeTypeOf('function'))
          const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
          const current = getPluginMarketplaceCache(cacheKey)!
          await act(async () => {
            writePluginInventory(cacheKey, current.deviceId, {
              installedPlugins: current.installedPlugins.map(plugin => ({
                ...plugin,
                spec: { ...plugin.spec, version: '2.1.0' },
              })),
              installedPluginsFetchedAt: Date.now(),
            })
          })
          expect(screen.getByTestId('plugin-version-submit-notice')).toHaveTextContent(
            '本地 v2.1.0 · 已分享 v1.0.0'
          )
          await act(async () => releaseStaleCatalog!())
          expect(screen.getByTestId('plugin-version-submit-notice')).toHaveTextContent(
            '本地 v2.1.0 · 已分享 v1.0.0'
          )
          return
        }
        await userEvent.click(screen.getByTestId('plugin-version-submit-open'))
        expect(await screen.findByTestId('plugin-version-submit-current')).toHaveTextContent(
          'v1.0.0'
        )
        expect(screen.getByTestId('plugin-version-submit-next')).toHaveTextContent('v2.0.0')
        await userEvent.type(
          screen.getByTestId('plugin-version-submit-notes'),
          '  Add scheduling queries  '
        )
        if (outcome === 'account-change') {
          view.rerender(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="other-cloud-token" />)
          await waitFor(() =>
            expect(screen.queryByTestId('plugin-version-submit-drawer')).not.toBeInTheDocument()
          )
          expect(packagePlugin).not.toHaveBeenCalled()
          expect(submittedMetadata).toBeUndefined()
          return
        }
        const cacheKey = pluginMarketplaceCacheKey('/api', 'cloud-token')
        const beforeSubmission = getPluginMarketplaceCache(cacheKey)
        await userEvent.click(screen.getByTestId('plugin-version-submit-confirm'))
        if (outcome !== 'success' && !normalizedName) {
          expect(await screen.findByRole('alert')).toHaveTextContent(
            outcome === 'superseded' ? '共享版本已被更新' : 'Package scan failed'
          )
          expect(screen.getByTestId('plugin-version-submit-notes')).toHaveValue(
            '  Add scheduling queries  '
          )
          expect(screen.getByTestId('plugin-version-submit-current')).toHaveTextContent('v1.0.0')
          expect(screen.getByTestId('plugin-version-submit-open')).toBeEnabled()
        } else {
          expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
            '新版本 v2.0.0 已分享'
          )
          expect(screen.queryByTestId('plugin-version-submit-drawer')).not.toBeInTheDocument()
          expect(screen.queryByTestId('plugin-version-submit-notice')).not.toBeInTheDocument()
          const afterSubmission = getPluginMarketplaceCache(cacheKey)
          expect(afterSubmission?.mutationRevision).toBeGreaterThan(
            beforeSubmission?.mutationRevision ?? 0
          )
          expect(afterSubmission?.marketplaceItems.find(item => item.id === 101)).toMatchObject({
            version: '2.0.0',
            latestReleaseId: 1002,
          })
          expect(pluginInventoryReadIsCurrent(cacheKey, beforeSubmission)).toBe(false)
        }
        expect(submittedMetadata).toMatchObject({
          slug: pluginKey,
          version: '2.0.0',
          purpose: 'restricted_share',
          releaseNotes: 'Add scheduling queries',
        })
        expect(submittedMetadata).not.toHaveProperty('targets')
        expect(submittedMetadata).not.toHaveProperty('allowCopy')
        expect(
          vi
            .mocked(fetch)
            .mock.calls.some(
              ([input, init]) => String(input).includes('/access') && init?.method === 'PUT'
            )
        ).toBe(false)
        expect(packagePlugin).toHaveBeenCalledOnce()
      } finally {
        view.unmount()
        packagePlugin.mockRestore()
        hash.mockRestore()
        createApi.mockRestore()
        releaseStaleCatalog?.()
        staleRead?.mockRestore()
      }
    }
  )

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

  test('uninstalling a cloud GitHub leaves the same-name OpenAI installation in shared inventory', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceName: 'github',
      marketplaceDisplayName: 'GitHub',
      marketplaceInstalled: true,
      marketplaceVisibility: 'workspace',
    })
    mockCodexAppServerInvoke({
      deviceId: 'current-device',
      installedPluginNames: ['github'],
      marketplaces: [
        {
          name: 'openai-curated-remote',
          path: null,
          plugins: [
            {
              id: 'github@openai-curated-remote',
              name: 'github',
              installed: true,
              enabled: true,
              source: { type: 'remote' },
              interface: { displayName: 'GitHub' },
            },
          ],
        },
      ],
    })
    render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
    await waitFor(() =>
      expect(getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins).toHaveLength(2)
    )
    await userEvent.click(await screen.findByTestId('plugin-marketplace-actions-101'))
    await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
    await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))

    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-101')).toHaveTextContent('安装')
    )
    const inventory = getPluginMarketplaceCache('/api|cloud-token')!
    expect(inventory.installedPlugins.map(plugin => plugin.metadata.labels?.id)).toContain(
      'github@openai-curated-remote'
    )
    expect(
      inventory.installedPlugins.map(plugin => String(plugin.metadata.labels?.id))
    ).not.toContain('101')
  })

  test.each(['success', 'failure'] as const)(
    'shows the local uninstall immediately and settles its numeric ID after %s',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({ marketplaceInstalled: true })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let finish!: () => void
      let deleteStarted = false
      const gate = new Promise<void>(resolve => {
        finish = resolve
      })
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (
          new URL(String(input), 'http://localhost').pathname === '/api/plugins/installed/101' &&
          init?.method === 'DELETE'
        ) {
          deleteStarted = true
          await gate
          if (outcome === 'failure')
            return Response.json({ detail: 'Uninstall rejected' }, { status: 503 })
        }
        return originalFetch(input, init)
      })
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      try {
        await userEvent.click(await screen.findByTestId('plugin-marketplace-actions-101'))
        await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
        await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
        await waitFor(() => expect(deleteStarted).toBe(true))
        expect(screen.getByRole('status', { name: '正在卸载 Documents' })).toBeInTheDocument()
        expect(screen.queryByTestId('plugin-marketplace-actions-101')).not.toBeInTheDocument()
        await act(async () => finish())
        await waitFor(() =>
          expect(
            screen.queryByRole('status', { name: '正在卸载 Documents' })
          ).not.toBeInTheDocument()
        )
        if (outcome === 'success') await screen.findByTestId('plugin-marketplace-install-101')
        else {
          await screen.findByTestId('plugin-marketplace-actions-101')
          expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
            'data-notice-kind',
            'error'
          )
        }
      } finally {
        view.unmount()
        finish()
      }
    }
  )

  test.each(['partial', 'reject', 'expired'] as const)(
    'preserves a confirmed uninstall after an older local catalog read returns %s',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceInstalled: true,
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'owner',
      })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const {
        requests: [held],
        restore,
      } = holdLocalCatalogReads([outcome])
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await userEvent.click(screen.getByTestId('plugins-distribution-tab-personal'))
        await waitFor(() => expect(held.ready).toHaveBeenCalledOnce())
        await userEvent.click(await screen.findByTestId('plugin-marketplace-row-101'))
        await userEvent.click(screen.getByTestId('plugin-detail-actions-101'))
        await userEvent.click(screen.getByTestId('plugin-detail-uninstall-101'))
        await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
        const notice = await screen.findByTestId('plugin-operation-notice')
        await waitFor(() => expect(notice).toHaveTextContent('已卸载'))
        expect(notice).toHaveAttribute('data-notice-kind', 'success')
        expectFetchRequest('/api/plugins/installed/101', 'DELETE')
        const key = pluginMarketplaceCacheKey('/api', 'cloud-token')
        expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([])
        await act(async () => held.release())
        await waitFor(() => expect(held.returned).toHaveBeenCalledOnce())

        expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('已卸载')
        expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
          'data-notice-kind',
          'success'
        )
        expect(getPluginMarketplaceCache(key)?.installedPlugins).toEqual([])
        await userEvent.click(screen.getByTestId('plugin-detail-back-button'))
        await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
      } finally {
        held.release()
        restore()
      }
    }
  )

  test.each(['partial', 'reject'] as const)(
    'shows a current local catalog %s failure and recovers on refresh',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({
        marketplaceVisibility: 'personal',
        marketplaceAccessRole: 'owner',
      })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      const {
        requests: [held],
        restore,
      } = holdLocalCatalogReads([outcome])
      try {
        render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
        await userEvent.click(screen.getByTestId('plugins-distribution-tab-personal'))
        await waitFor(() => expect(held.ready).toHaveBeenCalledOnce())
        expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()

        await act(async () => held.release())
        await waitFor(() => expect(held.returned).toHaveBeenCalledOnce())
        expect(await screen.findByTestId('plugin-operation-notice')).toHaveTextContent(
          '加载插件失败'
        )
        expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
          'data-notice-kind',
          'error'
        )
        const refresh = screen.getByTestId('plugins-refresh-button')
        await waitFor(() => expect(refresh).not.toBeDisabled())
        await userEvent.click(refresh)

        await waitFor(() => expect(refresh).not.toBeDisabled())
        await waitFor(() =>
          expect(screen.queryByTestId('plugin-operation-notice')?.textContent ?? '').not.toContain(
            '加载插件失败'
          )
        )
        expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
      } finally {
        held.release()
        restore()
      }
    }
  )

  test('keeps a newer local catalog refresh loading when an older request settles', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    mockSystemSkillsFetch({
      marketplaceVisibility: 'personal',
      marketplaceAccessRole: 'owner',
    })
    mockCodexAppServerInvoke({ deviceId: 'current-device' })
    const {
      requests: [older],
      restore,
    } = holdLocalCatalogReads(['expired'])
    let newer: ReturnType<typeof holdNextCloudPluginRead> | undefined
    try {
      render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      await userEvent.click(screen.getByTestId('plugins-distribution-tab-personal'))
      await waitFor(() => expect(older.ready).toHaveBeenCalledOnce())

      newer = holdNextCloudPluginRead('installed')
      const currentRefresh = newer
      act(() => window.dispatchEvent(new Event(PLUGIN_AUTO_UPDATE_COMPLETED_EVENT)))
      await waitFor(() => expect(currentRefresh.ready).toHaveBeenCalledOnce())
      expect(screen.getByTestId('plugins-refresh-button')).toBeDisabled()

      await act(async () => older.release())
      expect(older.returned).toHaveBeenCalledOnce()
      expect(screen.getByTestId('plugins-refresh-button')).toBeDisabled()
      expect(screen.queryByTestId('plugin-operation-notice')?.textContent ?? '').not.toContain(
        '加载插件失败'
      )

      await act(async () => currentRefresh.release())
      await waitFor(() => expect(screen.getByTestId('plugins-refresh-button')).not.toBeDisabled())
    } finally {
      older.release()
      newer?.release()
      restore()
    }
  })

  test.each(['mutation', 'expired', 'current'] as const)(
    'only reports a current deferred catalog failure: %s',
    async outcome => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      mockSystemSkillsFetch({ marketplaceInstalled: true, marketplaceDeviceState: 'installed' })
      mockCodexAppServerInvoke({ deviceId: 'current-device' })
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const localApi = createLocalCodexPluginApi()
      const readState = localApi.readState
      let started = false
      let finished = false
      localApi.readState = async params => {
        await readState(params)
        started = true
        await gate
        finished = true
        throw outcome === 'expired'
          ? new ExpiredPluginInventoryRequest()
          : new Error('Deferred catalog unavailable')
      }
      const factory = vi.spyOn(codexPlugins, 'createLocalCodexPluginApi').mockReturnValue(localApi)
      const view = render(<PluginsWorkspace cloudApiBaseUrl="/api" cloudToken="cloud-token" />)
      try {
        await waitFor(() => expect(started).toBe(true))
        if (outcome === 'mutation') {
          await userEvent.click(screen.getByTestId('plugin-marketplace-actions-101'))
          await userEvent.click(screen.getByTestId('plugin-marketplace-uninstall-101'))
          await userEvent.click(screen.getByTestId('plugin-uninstall-confirm-button'))
          await waitFor(() =>
            expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('已卸载')
          )
        }
        await act(async () => {
          release()
          await gate
        })
        await waitFor(() => expect(finished).toBe(true))
        if (outcome === 'mutation') {
          expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('已卸载')
          expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
            'data-notice-kind',
            'success'
          )
          expect(getPluginMarketplaceCache('/api|cloud-token')?.installedPlugins).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ spec: expect.objectContaining({ pluginId: 101 }) }),
            ])
          )
        } else if (outcome === 'expired') {
          expect(screen.queryByTestId('plugin-operation-notice')).not.toBeInTheDocument()
        } else {
          expect(screen.getByTestId('plugin-operation-notice')).toHaveAttribute(
            'data-notice-kind',
            'error'
          )
          expect(screen.getByTestId('plugin-operation-notice')).toHaveTextContent('加载插件失败')
        }
      } finally {
        release()
        view.unmount()
        factory.mockRestore()
      }
    }
  )

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
      '/api/plugins/installed/101',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(screen.queryByTestId('plugin-detail-actions-101')).not.toBeInTheDocument()
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
      'wework.plugins.codexCatalog.v1',
      JSON.stringify({
        version: 2,
        entries: {
          '|all|all-kinds': {
            paramsKey: '|all|all-kinds',
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

    const state = await localPluginApi.readState({ refresh: true })
    const item = state.marketplaceItems.find(item => item.id === 'local-openai:5715908889684902000')
    expect(item).toBeDefined()
    await localPluginApi.installAvailablePlugin(item!)

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

    const state = await localPluginApi.readState({ refresh: true })
    const item = state.marketplaceItems.find(item => item.id === 'local-openai:5715908889684902000')
    expect(item).toBeDefined()
    await localPluginApi.installAvailablePlugin(item!)

    expectCodexAppServerRequest('plugin/install', {
      marketplacePath: '/Users/test/.codex/plugins/marketplaces/openai',
      pluginName: 'documents',
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
})
