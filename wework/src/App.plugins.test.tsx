import { composerSchema } from '@/components/chat/composer/composerProseMirrorModel'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { importDshUiModule } from '@/features/dsh-runtime/dshUiModules'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { LOCAL_USER } from '@/api/local/localSession'
import {
  NotificationTaskContext,
  type TaskSource,
} from '@/features/notifications/NotificationTaskSourceContext'
import { useRuntimeInteractions } from '@/features/notifications/RuntimeInteractionsContext'
import { defaultNotificationPreferences } from '@/features/notifications/notificationPreferences'
import {
  interactionTask,
  interactionTranscript,
} from '@/features/notifications/runtimeInteractions.fixtures'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'
import type { WorkbenchContextValue } from '@/features/workbench/WorkbenchProvider'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import type { InstalledPlugin, User } from '@/types/api'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { useContext, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ApplicationsRoute from '../dsh/ui-applications/src/route'
import CoreAppSurface from '../dsh/ui-core-apps/src/app-surface'
import PluginCatalogRoute from '../dsh/ui-plugin-center/src/catalog-route'
import PluginCreateRoute from '../dsh/ui-plugin-center/src/create-route'
import PluginManagementRoute from '../dsh/ui-plugin-center/src/management-route'
import App from './App'
import './i18n'
import { telemetryFeatureForLocation } from './telemetry/routes'

function TestIsolatedExtensionRoute() {
  return <div data-testid="test-isolated-extension-route" />
}

const appOwnerFixture = vi.hoisted(() => ({
  user: null as User | null,
  connection: null as CloudConnectionContextValue | null,
  source: null as TaskSource | null,
}))

function TestAppOwnerRoute() {
  const cloudConnection = useCloudConnection()
  const notificationSource = useContext(NotificationTaskContext)
  const registerTaskSource = notificationSource?.registerTaskSource
  const source = appOwnerFixture.source
  const interactions = useRuntimeInteractions()
  const [mountState, setMountState] = useState(0)
  useEffect(() => {
    registerTaskSource?.('app-owner-fixture', source, true)
    return () => registerTaskSource?.('app-owner-fixture', null, true)
  }, [registerTaskSource, source])
  return (
    <>
      <output data-testid="app-owner-account">{cloudConnection.user?.id}</output>
      <output data-testid="app-owner-backend">{cloudConnection.apiBaseUrl}</output>
      <output data-testid="app-owner-pending-count">{interactions?.pending.length ?? 0}</output>
      <output data-testid="app-owner-drafts">
        {Object.values(interactions?.drafts ?? {}).join('|')}
      </output>
      <output data-testid="app-owner-mount-state">{mountState}</output>
      <button
        data-testid="app-owner-edit-draft"
        onClick={() => {
          const pending = interactions?.pending[0]
          if (pending) interactions?.setDraft(pending.id, 'Owner A private reply')
          setMountState(value => value + 1)
        }}
      >
        Edit owner reply
      </button>
    </>
  )
}

const telemetryMocks = vi.hoisted(() => ({ track: vi.fn(), trackEvent: vi.fn() }))

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
})

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({ sha256: 'test-account' }),
}))

vi.mock('@/telemetry/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@/telemetry/client')>()),
  track: telemetryMocks.track,
  trackEvent: telemetryMocks.trackEvent,
  useTelemetryEnabled: () => true,
}))

vi.mock('@extensions/device-surface', () => ({
  deviceSurfaceExtension: {
    available: false,
    DeviceAction: () => null,
    WorkspaceAction: () => null,
    RoutePage: () => null,
    isInternalPageUrl: () => false,
    isIsolatedSurface: (path: string, search: string) =>
      path === '/test-isolated-surface' && search === '?isolated=1',
    workspaceMenuItem: () => null,
    supportsDevice: () => false,
  },
}))

const TEST_DSH_ROUTES = [
  {
    id: 'test-app-owner.root',
    module: 'plugins/wework-ui-test-app-owner.js',
    path: '/test-app-owner',
    restorePolicy: 'session',
    title: 'App owner',
  },
  {
    id: 'test-isolated-surface.root',
    icon: 'monitor',
    module: 'plugins/wework-ui-test-isolated-surface.js',
    path: '/test-isolated-surface',
    restorePolicy: 'none',
    telemetryFeature: 'cloud_work',
    title: 'Isolated extension',
  },
  {
    id: 'plugin-center.catalog',
    icon: 'plug',
    module: 'plugins/wework-ui-plugin-center-catalog.js',
    path: '/plugins',
    restorePolicy: 'session',
    telemetryFeature: 'plugins',
    title: '插件',
  },
  {
    id: 'plugin-center.create',
    icon: 'plug',
    module: 'plugins/wework-ui-plugin-center-create.js',
    path: '/plugins/create',
    restorePolicy: 'session',
    telemetryFeature: 'plugin_create',
    title: '插件',
  },
  {
    id: 'plugin-center.management',
    icon: 'plug',
    module: 'plugins/wework-ui-plugin-center-management.js',
    path: '/plugins/manage',
    restorePolicy: 'session',
    telemetryFeature: 'plugin_management',
    title: '插件',
  },
  {
    id: 'applications.sites',
    icon: 'applications',
    module: 'plugins/wework-ui-applications.js',
    path: '/sites',
    restorePolicy: 'session',
    telemetryFeature: 'sites',
    title: '应用',
  },
]

const TEST_DSH_APPS = [
  {
    id: 'wework',
    label: '任务',
    mode: 'native',
    module: 'plugins/wework-ui-core-apps.js',
    path: '/',
    requiresAuth: true,
    workspaceKinds: ['task'],
  },
  {
    id: 'todo',
    hidden: true,
    label: '项目空间',
    mode: 'native',
    module: 'plugins/wework-ui-core-apps.js',
    path: '/todo',
    requiresAuth: true,
    workspaceKinds: ['board'],
  },
]

const TEST_DSH_NAVIGATION = [
  {
    id: 'plugin-center.navigation',
    activeItem: 'plugins',
    icon: 'plug',
    label: '插件',
    order: 20,
    path: '/plugins',
    testId: 'plugins-button',
  },
  {
    id: 'applications.navigation',
    activeItem: 'sites',
    icon: 'applications',
    label: '应用',
    order: 30,
    path: '/sites',
    testId: 'sites-button',
  },
]

function installTestDshUiPlugins() {
  window.__WEWORK_DSH_UI__ = {
    getEntries: slotName => {
      if (slotName === 'wework.app') return TEST_DSH_APPS
      if (slotName === 'wework.route') return TEST_DSH_ROUTES
      if (slotName === 'wework.sidebar.navigation') return TEST_DSH_NAVIGATION
      return []
    },
    subscribe: () => () => {},
    attach: () => ({
      dispose: () => {},
      update: () => {},
    }),
  }
  window.__WEWORK_DSH_UI_MODULES__ = {
    'plugins/wework-ui-test-app-owner.js': { default: TestAppOwnerRoute },
    'plugins/wework-ui-test-isolated-surface.js': { default: TestIsolatedExtensionRoute },
    'plugins/wework-ui-applications.js': { default: ApplicationsRoute },
    'plugins/wework-ui-core-apps.js': { default: CoreAppSurface },
    'plugins/wework-ui-plugin-center-catalog.js': { default: PluginCatalogRoute },
    'plugins/wework-ui-plugin-center-create.js': { default: PluginCreateRoute },
    'plugins/wework-ui-plugin-center-management.js': { default: PluginManagementRoute },
  }
}

const desktopHostMocks = vi.hoisted(() => {
  const preferences: Record<string, unknown> = {}
  return {
    preferences,
    invoke: vi.fn(
      async (capability: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        if (capability === 'preferences.get') return { ...preferences }
        if (capability === 'preferences.update') {
          Object.assign(preferences, params.patch)
          return { ...preferences }
        }
        if (capability === 'smartApps.list') return []
        if (capability === 'executor.plugins.personal.list') return { items: [] }
        if (capability === 'runtime.listCoreDshPlugins') return []
        if (capability === 'navigation.pendingSchemes') return []
        if (capability === 'notification.pendingReplies') return []
        if (capability === 'systemDrag.takePending') return []
        return {}
      }
    ),
  }
})

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
  subscribeDesktopHostEvents: vi.fn(() => () => {}),
}))

const localCodexPluginMocks = vi.hoisted(() => ({
  listInstalledPlugins: vi.fn(),
  listSkills: vi.fn(),
}))
const workbenchProviderMocks = vi.hoisted(() => ({
  autoReady: true,
  mounts: vi.fn(),
}))
const idleTaskCoordinatorMocks = vi.hoisted(() => ({
  active: vi.fn(),
}))

const localPathMocks = vi.hoisted(() => ({
  exists: vi.fn(),
}))

vi.mock('@/lib/local-terminal', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/local-terminal')>()
  return {
    ...actual,
    localPathExists: localPathMocks.exists,
    listLocalHarnesses: vi.fn().mockResolvedValue([]),
    listLocalHarnessSessions: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('@/desktop/localExecutor', () => ({
  getLocalExecutorStatus: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  ensureLocalExecutorAvailable: vi.fn().mockResolvedValue({
    running: true,
    ready: true,
    deviceId: 'local-device',
    deviceRouteId: 'local-device',
  }),
  ensureLocalExecutorStarted: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  getInitializedBundledPluginMarketplace: vi.fn().mockReturnValue(null),
  getKnownLocalExecutorDeviceId: vi.fn().mockReturnValue('local-device'),
  requestLocalExecutor: vi.fn(async (capability: string) => {
    if (capability === 'executor.plugins.device_route') {
      return { device_id: 'local-device', device_route_id: 'local-device' }
    }
    if (capability === 'executor.plugins.personal.list') {
      return { marketplacePath: '', plugins: [] }
    }
    if (capability === 'executor.plugins.store.list') {
      return { storePath: '', plugins: [] }
    }
    return {}
  }),
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(vi.fn()),
  connectLocalExecutorToBackend: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  disconnectLocalExecutorFromBackend: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
}))

vi.mock('@/features/local-runtime/LocalRuntimeInitializer', () => ({
  LocalRuntimeInitializer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/local-runtime/CodexHomeInitializer', () => ({
  CodexHomeInitializer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/idle-tasks/IdleTaskCoordinator', () => ({
  IdleTaskCoordinator: ({ active }: { active: boolean }) => {
    idleTaskCoordinatorMocks.active(active)
    return null
  },
}))

vi.mock('@/features/idle-tasks/WeworkIdleTasks', () => ({
  WeworkIdleTasks: () => null,
}))

vi.mock('@/api/local/codexPlugins', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/codexPlugins')>()
  return {
    ...actual,
    createLocalCodexPluginApi: () => ({
      ...actual.createLocalCodexPluginApi(),
      codexHomeMigrationStatus: vi.fn().mockResolvedValue({
        weworkCodexHome: '/Users/test/.wework/codex',
        nativeCodexHome: '/Users/test/.codex',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: true,
        shouldPromptMigration: false,
      }),
      listInstalledPlugins: localCodexPluginMocks.listInstalledPlugins,
      listSkills: localCodexPluginMocks.listSkills,
    }),
  }
})

const mockViewport = vi.hoisted(() => ({
  isMobile: false,
}))

const workbenchValue: WorkbenchContextValue = {
  services: {},
  state: {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
    devices: [],
    runtimeWork: null,
    runtimeWorkLoad: { phase: 'loading', error: null },
    currentProject: null,
    currentRuntimeTask: null,
    standaloneDeviceId: null,
    input: '',
    isBootstrapping: false,
    isSending: false,
    error: null,
  },
  isStartupReady: true,
  messages: [],
  queuedMessages: [],
  guidanceMessages: [],
  codeCommentContexts: [],
  workspaceFileApi: {
    listWorkspaceEntries: vi.fn().mockResolvedValue({ path: '/', entries: [] }),
    readWorkspaceTextFile: vi.fn(),
  },
  isAwaitingAssistantStart: false,
  isRuntimeTranscriptLoading: false,
  runtimeTranscriptHasMoreBefore: false,
  isRuntimeTranscriptLoadingMore: false,
  upgradingDevices: {},
  projectExecutionMode: 'current_workspace',
  setProjectExecutionMode: vi.fn(),
  projectWorktreeBranch: null,
  setProjectWorktreeBranch: vi.fn(),
  projectChat: {
    scopeKey: 'blank:0',
    inputByScope: { 'blank:0': '' },
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    selectedSkills: [],
    attachmentStateByScope: {},
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    isAttachmentReadyToSend: true,
    setSelectedModel: vi.fn(),
    setSelectedModelOption: vi.fn(),
    setInput: vi.fn(),
    setInputForScope: vi.fn(),
    getInputRevisionForScope: vi.fn().mockReturnValue(0),
    setSelectedSkills: vi.fn(),
    toggleSkill: vi.fn(),
    handleFileSelect: vi.fn(),
    handleFileSelectForScope: vi.fn(),
    addExistingAttachment: vi.fn(),
    addExistingAttachmentForScope: vi.fn(),
    removeAttachment: vi.fn(),
    removeAttachmentForScope: vi.fn(),
    resetAttachments: vi.fn(),
    resetAttachmentsForScope: vi.fn(),
    listLocalSkills: vi.fn().mockResolvedValue([]),
  },
  selectProject: vi.fn(),
  selectProjectWorkspace: vi.fn(),
  selectStandaloneDevice: vi.fn(),
  openStandaloneWorkspace: vi.fn(),
  startNewChat: vi.fn(),
  startNewSkillChat: vi.fn(),
  startStandaloneChat: vi.fn(),
  startNewProjectChat: vi.fn(),
  openRuntimeTask: vi.fn(),
  searchRuntimeWork: vi.fn(),
  loadOlderRuntimeTranscript: vi.fn(),
  renameRuntimeTask: vi.fn(),
  archiveRuntimeTask: vi.fn(),
  archiveProjectConversations: vi.fn(),
  archiveProjectsConversations: vi.fn(),
  archiveChatConversations: vi.fn(),
  forkCurrentRuntimeTask: vi.fn(),
  markRuntimeTaskStarted: vi.fn(),
  markRuntimeTaskSettled: vi.fn(),
  listImPrivateSessions: vi.fn(),
  getImNotificationSettings: vi.fn().mockResolvedValue({
    global: { enabled: false, sessionKey: null, session: null },
    runtimeTaskSubscriptions: [],
  }),
  updateGlobalImNotification: vi.fn(),
  subscribeRuntimeTaskNotifications: vi.fn(),
  unsubscribeRuntimeTaskNotifications: vi.fn(),
  refreshWorkLists: vi.fn(),
  refreshDevices: vi.fn(),
  upgradeDevice: vi.fn(),
  createProject: vi.fn(),
  createGitWorkspaceProject: vi.fn(),
  prepareDeviceWorkspace: vi.fn(),
  deleteDeviceWorkspace: vi.fn(),
  listGitRepositories: vi.fn(),
  listGitBranches: vi.fn(),
  updateProjectName: vi.fn(),
  removeProject: vi.fn(),
  getDeviceHomeDirectory: vi.fn(),
  getProjectWorkspaceRoot: vi.fn(),
  listDeviceDirectories: vi.fn(),
  createDeviceDirectory: vi.fn(),
  loadEnvironmentInfo: vi.fn(),
  loadEnvironmentDiff: vi.fn(),
  commitEnvironmentChanges: vi.fn(),
  commitAndPushEnvironmentChanges: vi.fn(),
  pushEnvironmentChanges: vi.fn(),
  listEnvironmentBranches: vi.fn(),
  checkoutEnvironmentBranch: vi.fn(),
  createEnvironmentBranch: vi.fn(),
  setInput: vi.fn(),
  addCodeCommentContext: vi.fn(),
  removeCodeCommentContext: vi.fn(),
  clearCodeCommentContexts: vi.fn(),
  sendCurrentInput: vi.fn(),
  retryFailedMessage: vi.fn(),
  pauseCurrentResponse: vi.fn(),
  isResponseStreaming: false,
  cancelQueuedMessage: vi.fn(),
  sendQueuedAsGuidance: vi.fn(),
  editQueuedMessage: vi.fn(),
  cancelGuidanceMessage: vi.fn(),
  loadTurnFileChangesDiff: vi.fn(),
  revertTurnFileChanges: vi.fn(),
}

function installedCodexSitesPlugin(): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'wegent-sites',
      namespace: 'default',
      labels: { id: '101' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-marketplace',
        pluginKey: 'wegent-sites',
        catalogItemId: '100',
        marketplace: 'wegent',
      },
      displayName: '快速建站',
      description: 'Build and deploy websites with Wegent Sites',
      version: '0.1.0',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: { name: 'wegent-sites' },
      components: {
        skills: [],
        commands: [],
        templates: [],
        apps: [],
        agents: [],
        mcps: [],
        hooks: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface: {
        displayName: '快速建站',
        defaultPrompt: ['Build an internal website and validate it locally'],
      },
      packageRef: null,
      sourcePayload: {
        filename: 'wegent-sites.zip',
      },
    },
    status: { state: 'enabled' },
  }
}

function installedGithubPlugin(enabled = true): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'github',
      namespace: 'wegent',
      labels: { id: '59' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'github',
      },
      origin: 'market',
      pluginId: 4,
      releaseId: 6,
      displayName: 'GitHub',
      description: '检查仓库、处理拉取请求和 Issue。',
      installState: 'installed',
      enabled,
      manifest: { name: 'github' },
      components: {
        skills: [],
        commands: [],
        apps: [{ name: 'GitHub', path: 'github' }],
        agents: [],
        mcps: [],
        hooks: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface: { composerIcon: '/plugins/github/icon.png' },
    },
    status: { state: enabled ? 'enabled' : 'disabled' },
  }
}

function installedCodexMiniProgramPlugin(): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'weibo-miniapp-h5-develop-agent',
      namespace: 'default',
      labels: { id: '102' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-marketplace',
        pluginKey: 'weibo-miniapp-h5-develop-agent',
        catalogItemId: '102',
        marketplace: 'wegent',
      },
      displayName: '微博小程序H5开发助手',
      description: 'Build and publish mini programs',
      version: '0.1.0',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: { name: 'weibo-miniapp-h5-develop-agent' },
      components: {
        skills: [],
        commands: [],
        templates: [],
        apps: [],
        agents: [],
        mcps: [],
        hooks: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface: {
        displayName: '微博小程序H5开发助手',
        defaultPrompt: ['创建并发布一个小程序'],
      },
      packageRef: null,
      sourcePayload: {
        filename: 'weibo-miniapp-h5-develop-agent.zip',
      },
    },
    status: { state: 'enabled' },
  }
}

function successfulSitesDeviceSync() {
  return {
    success: true,
    device_id: 'local-device',
    mode: 'replace',
    skills: [],
    plugins: [{ id: 101, name: 'wegent-sites', status: 'synced' }],
    mcps: [],
    errors: [],
    synced: 1,
    failed: 0,
    skipped: 0,
    results: [
      {
        device_id: 'local-device',
        success: true,
        error: null,
        skills: [],
        plugins: [{ id: 101, name: 'wegent-sites', status: 'synced' }],
        mcps: [],
        errors: [],
      },
    ],
  }
}

function sitesSyncWithUnrelatedDeviceFailure() {
  const sync = successfulSitesDeviceSync()
  sync.success = false
  sync.failed = 1
  sync.results.push({
    device_id: 'remote-device',
    success: false,
    error: 'device rejected historical plugin',
    skills: [],
    plugins: [{ id: 202, name: 'historical-plugin', status: 'failed' }],
    mcps: [],
    errors: [{ error: 'device rejected historical plugin' }],
  })
  return sync
}

function successfulMiniProgramDeviceSync() {
  return {
    success: true,
    device_id: 'local-device',
    mode: 'replace',
    skills: [],
    plugins: [{ id: 102, name: 'weibo-miniapp-h5-develop-agent', status: 'synced' }],
    mcps: [],
    errors: [],
    synced: 1,
    failed: 0,
    skipped: 0,
    results: [
      {
        device_id: 'local-device',
        success: true,
        error: null,
        skills: [],
        plugins: [{ id: 102, name: 'weibo-miniapp-h5-develop-agent', status: 'synced' }],
        mcps: [],
        errors: [],
      },
    ],
  }
}

function installedOnLocalDevice(plugin: InstalledPlugin): InstalledPlugin {
  const releaseId = plugin.spec.releaseId ?? 1
  return {
    ...plugin,
    status: {
      ...plugin.status,
      devices: [
        {
          deviceId: 'local-device',
          desiredReleaseId: releaseId,
          actualReleaseId: releaseId,
          state: 'installed',
          attemptCount: 1,
          lastSyncAt: '2026-08-07T05:41:42Z',
          updatedAt: '2026-08-07T05:41:42Z',
        },
      ],
    },
  }
}

function applicationTypesResponse() {
  return {
    items: [
      {
        app_type: 'web',
        enabled: true,
        order: 10,
        capabilities: ['create', 'publish', 'edit', 'delete'],
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
  }
}

vi.mock('@/features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: appOwnerFixture.user ?? { id: 1, user_name: 'alice', email: 'alice@example.com' },
    isLoading: false,
    adminPasswordSetupRequired: false,
    adminUsername: 'admin',
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    loginWithOidcToken: vi.fn(),
    setupAdminPassword: vi.fn(),
  }),
}))

vi.mock('@/features/cloud-connection/CloudConnectionProvider', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/cloud-connection/CloudConnectionProvider')>()
  return {
    ...actual,
    CloudConnectionProvider: ({ children }: { children: React.ReactNode }) =>
      appOwnerFixture.connection ? (
        <CloudConnectionContext.Provider value={appOwnerFixture.connection}>
          {children}
        </CloudConnectionContext.Provider>
      ) : (
        <actual.CloudConnectionProvider>{children}</actual.CloudConnectionProvider>
      ),
  }
})

vi.mock('@/features/workbench/WorkbenchProvider', () => ({
  WorkbenchProvider: ({
    children,
    onStartupReadyChange,
  }: {
    children: React.ReactNode
    onStartupReadyChange?: (ready: boolean) => void
  }) => {
    useEffect(() => {
      workbenchProviderMocks.mounts()
    }, [])
    if (workbenchProviderMocks.autoReady) {
      queueMicrotask(() => onStartupReadyChange?.(true))
    }
    return <>{children}</>
  },
}))

vi.mock('@/features/workbench/useWorkbench', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/workbench/useWorkbench')>()
  return {
    ...actual,
    useWorkbench: () => workbenchValue,
    useWorkbenchPaneContext: () => workbenchValue,
  }
})

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockViewport.isMobile,
}))

async function renderApp() {
  const lifecycleStore = new RuntimeTaskLifecycleStore('app-plugins-test')
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <App />
      </RuntimeTaskLifecycleProvider>
    )
  })
  return {
    ...view,
    rerenderApp: () =>
      view.rerender(
        <RuntimeTaskLifecycleProvider store={lifecycleStore}>
          <App />
        </RuntimeTaskLifecycleProvider>
      ),
  }
}

function connectedAppOwner(
  userId = 7,
  apiBaseUrl = 'https://cloud-a.example.com/api',
  token = 'owner-token'
): CloudConnectionContextValue {
  return {
    ...DISCONNECTED_STATE,
    status: 'connected',
    user: { id: userId, user_name: `owner-${userId}`, email: `owner-${userId}@example.com` },
    isConnected: true,
    apiBaseUrl,
    token,
    serviceKey: `${apiBaseUrl}:${userId}:${token}`,
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }
}

function appOwnerTaskSource(pending: boolean): TaskSource {
  return {
    userId: appOwnerFixture.connection?.user?.id,
    items: pending ? [interactionTask] : [],
    unreadTaskKeys: new Set(),
    markRuntimeTaskRead: vi.fn(),
    services: {
      runtimeWorkApi: {
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [],
          chats: pending ? [{ ...interactionTask.workspace, tasks: [interactionTask.task] }] : [],
          totalTasks: pending ? 1 : 0,
        }),
        getRuntimeTranscript: pending
          ? vi.fn().mockResolvedValue(interactionTranscript())
          : vi.fn().mockRejectedValue(new Error('Task belongs to another account')),
      },
    } as WorkbenchContextValue['services'],
  }
}

function pendingInteractionStorageKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter(
      (key): key is string =>
        key !== null && key.startsWith('wework.interactions:') && key.endsWith(':pending')
    )
    .sort()
}

async function createSiteFromMenu() {
  await userEvent.click(await screen.findByTestId('sites-create-button'))
  await userEvent.click(await screen.findByTestId('sites-create-site-menu-item'))
}

function mockSystemSkillsFetch() {
  const skillsResponse = {
    total: 1,
    page: 1,
    pageSize: 20,
    items: [
      {
        id: '@weibo/wehot',
        providerKey: 'weibo',
        providerName: 'Weibo Skill Market',
        name: 'wehot',
        displayName: 'wehot',
        description: 'Weibo hot search skill',
        iconUrl: null,
        tags: ['system'],
        version: '1.0.0',
        author: 'Weibo',
        category: 'system',
        capabilities: [],
        detailUrl: null,
        installState: 'not_installed',
        enabled: false,
        requiresPermission: false,
        permissionUrl: null,
        updatedAt: null,
      },
    ],
    providerErrors: [],
  }
  const installedSkillsResponse = {
    items: [
      {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'InstalledSkill',
        metadata: {
          name: 'weibo-wehot',
          namespace: 'default',
          labels: { id: '42' },
        },
        spec: {
          source: {
            type: 'system',
            providerKey: 'weibo',
            skillKey: 'wehot',
            catalogItemId: '@weibo/wehot',
          },
          skillRef: null,
          displayName: 'wehot',
          description: 'Weibo hot search skill',
          version: '1.0.0',
          installState: 'installed',
          enabled: true,
          sourcePayload: null,
        },
        status: { state: 'Available' },
      },
      {
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
      },
    ],
  }
  const installedUploadedPersonalSkill = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledSkill',
    metadata: {
      name: 'personal-zip-helper',
      namespace: 'default',
      labels: { id: '89' },
    },
    spec: {
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
      version: '1.0.0',
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
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
          enabled: true,
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
      enabled: true,
      displayName: 'zip-helper',
      version: '1.0.0',
      author: 'Alice',
      tags: ['personal'],
      prompt: 'Uploaded prompt',
    },
  }
  const installedMcpsResponse = {
    items: [
      {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'InstalledMCP',
        metadata: {
          name: 'custom-docs',
          namespace: 'default',
          labels: { id: '7' },
        },
        spec: {
          source: {
            type: 'custom',
            serverKey: 'custom-docs',
          },
          displayName: 'Custom Docs MCP',
          description: 'Search custom docs',
          server: {
            type: 'streamable-http',
            url: 'https://mcp.example.com/docs',
          },
          installState: 'installed',
          enabled: true,
          sourcePayload: null,
        },
        status: { state: 'Available' },
      },
    ],
  }
  const providerServersResponse = {
    success: true,
    message: 'ok',
    servers: [
      {
        id: '@weibo/hot-search',
        name: 'Hot Search MCP',
        description: 'Read hot search data',
        type: 'streamable-http',
        base_url: 'https://mcp.example.com/hot-search',
        command: null,
        args: null,
        env: null,
        headers: null,
        is_active: true,
        provider: 'Weibo MCP Market',
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
      name: 'weibo-hot-search',
      namespace: 'default',
      labels: { id: '9' },
    },
    spec: {
      source: {
        type: 'provider',
        providerKey: 'mcp_router',
        serverKey: 'hot-search',
        catalogItemId: '@weibo/hot-search',
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
      labels: { id: '8' },
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

  const providersResponse = {
    providers: [
      {
        key: 'mcp_router',
        name: '',
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

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      let payload: unknown
      if (url.includes('/v1/wework-notifications/preferences')) {
        payload = defaultNotificationPreferences
      } else if (url.includes('/v1/wework-notifications')) {
        payload = { items: [], total: 0, unread_count: 0 }
      } else if (url.endsWith('/runtime-work/im-notifications')) {
        payload = { global: { enabled: false, sessionKey: null }, tasks: [] }
      } else if (url.includes('/mcp-providers/mcp_router/servers')) {
        payload = providerServersResponse
      } else if (url.includes('/mcp-providers/keys')) {
        payload = { success: true, message: 'ok' }
      } else if (url.includes('/mcps/installed')) {
        payload = init?.method === 'PUT' ? installedMcpsResponse.items[0] : installedMcpsResponse
      } else if (url.includes('/mcps/install')) {
        payload = installedProviderMcp
      } else if (url.includes('/mcps/custom')) {
        payload = customMcpResponse
      } else if (url.includes('/v1/kinds/skills/upload')) {
        payload = uploadedPersonalSkill
      } else if (url.includes('/v1/kinds/skills')) {
        payload = personalSkillsResponse
      } else if (url.includes('/system-skills/install/personal')) {
        payload = installedUploadedPersonalSkill
      } else if (url.includes('/system-skills/installed')) {
        payload =
          init?.method === 'PUT' ? installedSkillsResponse.items[0] : installedSkillsResponse
      } else if (url.includes('/system-skills/providers')) {
        payload = providersResponse
      } else if (url.includes('/mcp-providers')) {
        payload = providersResponse
      } else if (url.includes('/plugins/marketplace')) {
        payload = { items: [] }
      } else if (url.includes('/plugins/installed')) {
        payload = { items: [] }
      } else if (url.includes('/sites/app-types')) {
        payload = applicationTypesResponse()
      } else {
        payload = skillsResponse
      }

      return Promise.resolve({
        ok: true,
        status: init?.method === 'DELETE' ? 204 : 200,
        json: () => Promise.resolve(payload),
      })
    })
  )
}

describe('App plugins route', () => {
  beforeEach(async () => {
    appOwnerFixture.user = null
    appOwnerFixture.connection = null
    appOwnerFixture.source = null
    installTestDshUiPlugins()
    await Promise.all(
      Object.keys(window.__WEWORK_DSH_UI_MODULES__ ?? {}).map(module => importDshUiModule(module))
    )
    for (const key of Object.keys(desktopHostMocks.preferences)) {
      delete desktopHostMocks.preferences[key]
    }
    localStorage.clear()
    sessionStorage.clear()
    delete window.weworkElectronCloudCredentials
    vi.stubEnv('DEV', false)
    mockViewport.isMobile = false
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
      runtimeMode: 'backend',
    }
    desktopHostMocks.invoke.mockClear()
    telemetryMocks.track.mockReset()
    telemetryMocks.trackEvent.mockReset()
    workbenchValue.state.runtimeWork = null
    workbenchValue.state.currentRuntimeTask = null
    workbenchValue.state.devices = [
      {
        id: 1,
        device_id: 'local-device',
        name: 'Local device',
        status: 'online',
        is_default: true,
        device_type: 'local',
        bind_shell: 'claudecode',
        executor_version: '1.8.5',
      },
    ]
    workbenchValue.state.standaloneDeviceId = 'local-device'
    vi.mocked(workbenchValue.openRuntimeTask).mockReset().mockResolvedValue(undefined)
    vi.mocked(workbenchValue.startNewSkillChat).mockReset().mockResolvedValue(false)
    localCodexPluginMocks.listInstalledPlugins.mockReset().mockResolvedValue({ items: [] })
    localCodexPluginMocks.listSkills.mockReset().mockResolvedValue([])
    workbenchProviderMocks.autoReady = true
    workbenchProviderMocks.mounts.mockClear()
    idleTaskCoordinatorMocks.active.mockClear()
    localPathMocks.exists.mockReset().mockResolvedValue(false)
    mockSystemSkillsFetch()
  })

  afterEach(() => {
    delete window.__WEWORK_DSH_UI__
    delete window.__WEWORK_DSH_UI_MODULES__
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('mounts only the active task workbench during startup', async () => {
    window.history.pushState({}, '', '/')

    await renderApp()

    await screen.findByTestId('app-shell')
    await waitFor(() => expect(workbenchProviderMocks.mounts).toHaveBeenCalledTimes(1))
  })

  test.each([
    { change: 'cloud account', userId: 8, apiBaseUrl: 'https://cloud-a.example.com/api' },
    { change: 'cloud backend', userId: 7, apiBaseUrl: 'https://cloud-b.example.com/api' },
  ])(
    'isolates AppShell notification state when the $change changes under LOCAL_USER',
    async next => {
      appOwnerFixture.user = LOCAL_USER
      appOwnerFixture.connection = connectedAppOwner()
      appOwnerFixture.source = appOwnerTaskSource(true)
      window.history.pushState({}, '', '/test-app-owner')
      const view = await renderApp()
      await waitFor(() =>
        expect(screen.getByTestId('app-owner-pending-count')).toHaveTextContent('1')
      )
      await userEvent.click(screen.getByTestId('app-owner-edit-draft'))
      expect(screen.getByTestId('app-owner-drafts')).toHaveTextContent('Owner A private reply')
      expect(screen.getByTestId('app-owner-mount-state')).toHaveTextContent('1')
      const previousKeys = pendingInteractionStorageKeys()
      expect(previousKeys).toHaveLength(1)

      appOwnerFixture.connection = connectedAppOwner(next.userId, next.apiBaseUrl)
      const nextSource = appOwnerTaskSource(false)
      appOwnerFixture.source = nextSource
      await act(async () => view.rerenderApp())

      expect(screen.getByTestId('app-owner-account')).toHaveTextContent(String(next.userId))
      expect(screen.getByTestId('app-owner-backend')).toHaveTextContent(next.apiBaseUrl)
      expect(screen.getByTestId('app-owner-pending-count')).toHaveTextContent('0')
      expect(screen.getByTestId('app-owner-drafts')).toBeEmptyDOMElement()
      expect(screen.getByTestId('app-owner-mount-state')).toHaveTextContent('0')
      await waitFor(() =>
        expect(nextSource.services?.runtimeWorkApi?.listRuntimeWork).toHaveBeenCalled()
      )
      expect(nextSource.services?.runtimeWorkApi?.getRuntimeTranscript).not.toHaveBeenCalled()
      expect(pendingInteractionStorageKeys()).toHaveLength(2)
      expect(localStorage.getItem(previousKeys[0])).toContain('Order review')
    }
  )

  test('preserves AppShell notification state when the same owner refreshes its token', async () => {
    appOwnerFixture.user = LOCAL_USER
    appOwnerFixture.connection = connectedAppOwner()
    appOwnerFixture.source = appOwnerTaskSource(true)
    window.history.pushState({}, '', '/test-app-owner')
    const view = await renderApp()
    await waitFor(() =>
      expect(screen.getByTestId('app-owner-pending-count')).toHaveTextContent('1')
    )
    await userEvent.click(screen.getByTestId('app-owner-edit-draft'))
    const previousKeys = pendingInteractionStorageKeys()

    appOwnerFixture.connection = connectedAppOwner(7, undefined, 'refreshed-owner-token')
    await act(async () => view.rerenderApp())

    expect(screen.getByTestId('app-owner-pending-count')).toHaveTextContent('1')
    expect(screen.getByTestId('app-owner-drafts')).toHaveTextContent('Owner A private reply')
    expect(screen.getByTestId('app-owner-mount-state')).toHaveTextContent('1')
    expect(pendingInteractionStorageKeys()).toEqual(previousKeys)
  })

  test('rebuilds AppShell for the local owner when retained cloud credentials expire', async () => {
    appOwnerFixture.user = LOCAL_USER
    appOwnerFixture.connection = connectedAppOwner()
    appOwnerFixture.source = appOwnerTaskSource(true)
    window.history.pushState({}, '', '/test-app-owner')
    const view = await renderApp()
    await waitFor(() =>
      expect(screen.getByTestId('app-owner-pending-count')).toHaveTextContent('1')
    )
    await userEvent.click(screen.getByTestId('app-owner-edit-draft'))
    const previousKeys = pendingInteractionStorageKeys()

    appOwnerFixture.connection = {
      ...connectedAppOwner(),
      status: 'expired',
      isConnected: false,
      token: null,
      serviceKey: 'expired',
    }
    appOwnerFixture.source = { ...appOwnerTaskSource(false), userId: LOCAL_USER.id }
    await act(async () => view.rerenderApp())

    expect(screen.getByTestId('app-owner-pending-count')).toHaveTextContent('0')
    expect(screen.getByTestId('app-owner-drafts')).toBeEmptyDOMElement()
    expect(screen.getByTestId('app-owner-mount-state')).toHaveTextContent('0')
    expect(pendingInteractionStorageKeys()).toHaveLength(2)
    expect(localStorage.getItem(previousKeys[0])).toContain('Order review')
  })

  test('renders an isolated extension child without the global navigation shell', async () => {
    window.history.pushState({}, '', '/test-isolated-surface?isolated=1')

    await renderApp()

    expect(await screen.findByTestId('test-isolated-extension-route')).toBeInTheDocument()
    expect(screen.getByTestId('isolated-surface-route')).toBeInTheDocument()
    expect(screen.queryByTestId('chrome-titlebar')).not.toBeInTheDocument()
    expect(document.querySelector('[data-workspace-tab-content]')).toBeNull()
    await waitFor(() => expect(workbenchProviderMocks.mounts).toHaveBeenCalledTimes(1))
  })

  test('does not assign legacy generic features to smart app locations', () => {
    expect(telemetryFeatureForLocation('/sites', '?app_type=smart_app')).toBe('sites')
    expect(telemetryFeatureForLocation('/sites', '?app_type=smart_app&view=owned')).toBe('sites')
    expect(telemetryFeatureForLocation('/app/harness-research-desk', '')).toBe('apps')
    expect(telemetryFeatureForLocation('/sites', '?app_type=web')).toBe('sites')
    expect(telemetryFeatureForLocation('/app/native-task', '')).toBe('apps')
  })

  test('automatically observes a Smart App view change when only search changes', async () => {
    await updateAppPreferences({ experimentalFeaturesEnabled: true })
    window.history.pushState({}, '', '/sites?app_type=smart_app')
    await renderApp()

    await waitFor(() =>
      expect(telemetryMocks.trackEvent).toHaveBeenCalledWith({
        name: 'smart_app_marketplace_opened',
        properties: { domain: 'smart_app' },
      })
    )

    await act(async () => {
      window.history.pushState({}, '', '/sites?app_type=smart_app&view=owned')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(telemetryMocks.trackEvent).toHaveBeenLastCalledWith({
        name: 'smart_app_owned_opened',
        properties: { domain: 'smart_app' },
      })
    )

    expect(telemetryMocks.track).not.toHaveBeenCalledWith('feature_opened', {
      feature: 'sites',
    })
  })

  test('dispatches application shortcuts from the focused conversation composer', async () => {
    window.history.pushState({}, '', '/')
    await renderApp()
    await screen.findByTestId('app-shell')
    const composer = document.createElement('textarea')
    composer.dataset.testid = 'chat-message-input'
    composer.value = 'Unsent draft'
    document.body.appendChild(composer)
    composer.focus()

    try {
      expect(
        fireEvent.keyDown(composer, {
          key: ',',
          code: 'Comma',
          metaKey: true,
        })
      ).toBe(false)
      await waitFor(() => expect(window.location.pathname).toBe('/settings'))
      expect(composer.value).toBe('Unsent draft')
    } finally {
      composer.remove()
    }
  })

  test('handles the sidebar shortcut before ProseMirror suppresses native bold', async () => {
    window.history.pushState({}, '', '/plugins')
    await renderApp()
    await screen.findByTestId('plugins-workspace', undefined, { timeout: 10_000 })
    const editor = new EditorView(document.body, {
      state: EditorState.create({ schema: composerSchema }),
      attributes: { 'data-testid': 'chat-message-input' },
    })
    Object.defineProperty(editor.dom, 'isContentEditable', { value: true })
    editor.focus()

    try {
      fireEvent.keyDown(editor.dom, { key: 'b', code: 'KeyB', keyCode: 66, metaKey: true })

      expect(await screen.findByTestId('auxiliary-expand-sidebar-button')).toBeInTheDocument()
      expect(editor.state.doc.textContent).toBe('')
    } finally {
      editor.destroy()
    }
  }, 15_000)

  test('does not dispatch application shortcuts from editable targets', async () => {
    window.history.pushState({}, '', '/')
    await renderApp()
    await screen.findByTestId('app-shell')
    const input = document.createElement('input')
    document.body.appendChild(input)

    expect(
      fireEvent.keyDown(input, {
        bubbles: true,
        cancelable: true,
        code: 'Comma',
        key: ',',
        metaKey: true,
      })
    ).toBe(true)
    expect(window.location.pathname).toBe('/')

    input.remove()
  })

  test('does not bypass startup readiness after ten seconds or an active app change', async () => {
    vi.useFakeTimers()
    try {
      workbenchProviderMocks.autoReady = false
      window.history.pushState({}, '', '/')

      await renderApp()
      await act(async () => {
        for (let index = 0; index < 10; index += 1) {
          await Promise.resolve()
        }
      })
      expect(screen.getByTestId('app-shell')).toBeInTheDocument()
      expect(idleTaskCoordinatorMocks.active).toHaveBeenLastCalledWith(false)

      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
      expect(idleTaskCoordinatorMocks.active).toHaveBeenLastCalledWith(false)

      await act(async () => {
        window.history.pushState({}, '', '/todo')
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      expect(window.location.pathname).toBe('/todo')
      expect(idleTaskCoordinatorMocks.active).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows Sites as unavailable instead of calling a relative API in disconnected local mode', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      runtimeMode: 'local-first',
      desktopHost: 'electron',
    }
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal server error'),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
    window.history.pushState({}, '', '/sites')

    await renderApp()

    expect(await screen.findByTestId('sites-unavailable-state')).toHaveTextContent(
      '站点功能尚未推出'
    )
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/sites'))).toBe(
      false
    )
    expect(screen.queryByText('Internal server error')).not.toBeInTheDocument()
  })

  test('loads Sites from the authenticated cloud Backend in local mode', async () => {
    localCodexPluginMocks.listInstalledPlugins.mockResolvedValue({
      items: [],
      deviceId: 'local-device',
    })
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      runtimeMode: 'local-first',
      desktopHost: 'electron',
    }
    localStorage.setItem(
      'wework.cloudConnection',
      JSON.stringify({
        backendUrl: 'http://127.0.0.1:9100',
        apiBaseUrl: 'http://127.0.0.1:9100/api',
        socketBaseUrl: 'http://127.0.0.1:9100',
        socketPath: '/socket.io',
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-07-15T00:00:00.000Z',
      })
    )
    window.weworkElectronCloudCredentials = {
      prepareAuthorization: vi.fn(),
      commitAuthorization: vi.fn(),
      discardAuthorization: vi.fn(),
      claimAuthorization: vi.fn(),
      refreshAccessToken: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          accessToken: 'cloud-secret',
          tokenType: 'bearer',
          expiresIn: 3600,
        },
      }),
      clear: vi.fn(),
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/users/me')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 7, user_name: 'alice', email: 'alice@example.com' }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                {
                  app_type: 'web',
                  siteid: 'site-cloud-1',
                  name: '云端站点',
                  internal_url: 'http://sites.internal/cloud',
                  external_url: null,
                  publish_status: 'unpublished',
                  thumbnail_url: null,
                },
              ],
              total: 1,
              offset: 0,
              limit: 20,
            }),
        } as Response
      }
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexSitesPlugin(),
              sync: successfulSitesDeviceSync(),
            }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.pushState({}, '', '/sites')

    await renderApp()

    expect(screen.getByText('云端站点')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/api/sites?app_type=web&offset=0&limit=20',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer cloud-secret' }),
      })
    )

    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/api/plugins/builtin/wegent-sites/ensure-installed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer cloud-secret' }),
      })
    )
  })

  test('ensures the cloud Sites plugin and opens it in a new chat', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        } as Response
      }
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexSitesPlugin(),
              sync: successfulSitesDeviceSync(),
            }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                {
                  app_type: 'web',
                  siteid: 'site-1',
                  name: '产品发布页',
                  internal_url: 'http://sites.internal/product',
                  external_url: null,
                  publish_status: 'unpublished',
                  thumbnail_url: null,
                },
              ],
              total: 1,
              offset: 0,
              limit: 20,
            }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites?app_type=web')

    await renderApp()
    await updateAppPreferences({ experimentalFeaturesEnabled: true })

    expect(await screen.findByTestId('sites-workspace')).toBeInTheDocument()
    expect(await screen.findByText('产品发布页')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|\/)api\/sites\?app_type=web&offset=0&limit=20$/),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(await screen.findByTestId('sites-button')).toHaveAttribute('aria-current', 'page')

    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|\/)api\/plugins\/builtin\/wegent-sites\/ensure-installed$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '快速建站',
        openInNewChat: true,
      }
    )
  })

  test('opens continue development with the Sites plugin reference before the project reference', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ items: [installedOnLocalDevice(installedCodexSitesPlugin())] }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [
                {
                  app_type: 'web',
                  siteid: 'site-1',
                  project_id: 'prj_01arz3ndektsv4rrffq69g5fav',
                  name: '产品发布页',
                  internal_url: 'http://sites.internal/product',
                  external_url: null,
                  publish_status: 'unpublished',
                  thumbnail_url: null,
                },
              ],
              total: 1,
              offset: 0,
              limit: 20,
            }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites?app_type=web')

    await renderApp()
    await act(async () => {
      await updateAppPreferences({ experimentalFeaturesEnabled: true })
    })
    expect(screen.getByText('产品发布页')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('site-continue-development-site-1'))

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$快速建站](plugin://wegent-sites@wegent) [产品发布页](wegent-sites-project://prj_01arz3ndektsv4rrffq69g5fav) 请说出你要做的改动',
        pluginName: '快速建站',
        app: expect.objectContaining({ pluginKey: 'wegent-sites' }),
        openInNewChat: true,
      }
    )
  })

  test('installs the Mini Program plugin with its creation prompt', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        } as Response
      }
      if (url.includes('/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexMiniProgramPlugin(),
              sync: successfulMiniProgramDeviceSync(),
            }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites?app_type=miniapp')

    await renderApp()
    await screen.findByText('还没有小程序')
    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-mini-program-menu-item'))

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(
        /(?:^|\/)api\/plugins\/builtin\/weibo-miniapp-h5-develop-agent\/ensure-installed$/
      ),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$微博小程序H5开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序',
        pluginName: '微博小程序H5开发助手',
        openInNewChat: true,
      }
    )
  })

  test('opens the Mini Program plugin from the local device installation without reinstalling', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              items: [installedOnLocalDevice(installedCodexMiniProgramPlugin())],
            }),
        } as Response
      }
      if (url.includes('/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed')) {
        throw new Error('ensure should not be called for a locally installed plugin')
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites?app_type=miniapp')

    await renderApp()
    await screen.findByText('还没有小程序')
    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-mini-program-menu-item'))

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) =>
          String(input).includes('/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed')
        )
    ).toBe(false)
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$微博小程序H5开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序',
        pluginName: '微博小程序H5开发助手',
      }
    )
  })

  test('installs the requested application plugin when the local device only has a same-name public plugin', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    const publicSitesPlugin = installedOnLocalDevice(installedCodexSitesPlugin())
    publicSitesPlugin.spec.visibility = 'public'
    publicSitesPlugin.spec.source.marketplace = 'wework'

    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [publicSitesPlugin] }),
        } as Response
      }
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexSitesPlugin(),
              sync: successfulSitesDeviceSync(),
            }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites')

    await renderApp()
    expect(await screen.findByText('还没有站点', {}, { timeout: 5_000 })).toBeInTheDocument()
    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|\/)api\/plugins\/builtin\/wegent-sites\/ensure-installed$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '快速建站',
      }
    )
  })

  test('opens the application chat when the target device sync succeeds and another device fails', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        } as Response
      }
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexSitesPlugin(),
              sync: sitesSyncWithUnrelatedDeviceFailure(),
            }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites')

    await renderApp()
    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '快速建站',
      }
    )
  })

  test('opens the application chat when legacy sync omits per-device results', async () => {
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        } as Response
      }
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        const sync = successfulSitesDeviceSync()
        delete (sync as Partial<typeof sync>).results
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexSitesPlugin(),
              sync,
            }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      if (url.includes('/sites?')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    window.history.pushState({}, '', '/sites')

    await renderApp()
    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '快速建站',
      }
    )
  })

  test('keeps Sites open when the target device sync is not confirmed', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ plugin: installedCodexSitesPlugin() }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
      } as Response
    })
    window.history.pushState({}, '', '/sites')

    await renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '应用插件未能同步到目标设备，请检查设备后重试'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('keeps Sites open when merge sync does not acknowledge the Sites plugin', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        const sync = successfulSitesDeviceSync()
        sync.plugins = [{ id: 202, name: 'historical-plugin', status: 'synced' }]
        sync.results[0].plugins = sync.plugins
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              plugin: installedCodexSitesPlugin(),
              sync,
            }),
        } as Response
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
      } as Response
    })
    window.history.pushState({}, '', '/sites')

    await renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '应用插件未能同步到目标设备，请检查设备后重试'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('keeps Sites open and allows retry when cloud plugin installation fails', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        throw new Error('plugin install failed')
      }
      if (url.includes('/sites/app-types')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(applicationTypesResponse()),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 20 }),
      } as Response
    })
    window.history.pushState({}, '', '/sites')

    await renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '应用插件安装失败，请重试'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(screen.getByTestId('sites-create-button')).toBeEnabled()
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test.each(['site', 'miniapp', 'continue'] as const)(
    'opens %s using local membership while Backend plugin queries fail',
    async entry => {
      const installed =
        entry === 'miniapp' ? installedCodexMiniProgramPlugin() : installedCodexSitesPlugin()
      localCodexPluginMocks.listInstalledPlugins.mockResolvedValue({
        items: [installed],
        deviceId: 'local-device',
      })
      vi.mocked(fetch).mockImplementation(async input => {
        const url = String(input)
        if (url.includes('/sites/app-types'))
          return { ok: true, status: 200, json: async () => applicationTypesResponse() } as Response
        if (url.includes('/sites?'))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  app_type: 'web',
                  siteid: 'site-local',
                  project_id: 'project-local',
                  name: 'Local site',
                  internal_url: 'http://sites.internal/local',
                  publish_status: 'unpublished',
                },
              ],
              total: 1,
              offset: 0,
              limit: 20,
            }),
          } as Response
        throw new Error('Backend plugin service unavailable')
      })
      window.history.pushState({}, '', '/sites')
      await renderApp()
      await screen.findByText('Local site')
      if (entry === 'continue')
        await userEvent.click(screen.getByTestId('site-continue-development-site-local'))
      else {
        await userEvent.click(screen.getByTestId('sites-create-button'))
        await userEvent.click(
          screen.getByTestId(
            entry === 'miniapp'
              ? 'sites-create-mini-program-menu-item'
              : 'sites-create-site-menu-item'
          )
        )
      }
      await waitFor(() => expect(window.location.pathname).toBe('/'))
      const trial = JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')
      expect(trial.input).toContain('plugin://' + installed.spec.source.pluginKey + '@wegent')
      if (entry === 'continue')
        expect(trial.input).toContain('wegent-sites-project://project-local')
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/plugins/builtin/'))
      ).toBe(false)
    }
  )

  test('shows inspection failure without installing, and permits retry', async () => {
    localCodexPluginMocks.listInstalledPlugins.mockRejectedValue(
      new Error('Executor inventory unavailable')
    )
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/sites/app-types'))
        return { ok: true, status: 200, json: async () => applicationTypesResponse() } as Response
      if (url.includes('/sites?'))
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
        } as Response
      throw new Error('Unexpected request: ' + url)
    })
    window.history.pushState({}, '', '/sites')
    await renderApp()
    await createSiteFromMenu()
    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '无法确认目标设备的插件安装状态'
    )
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/plugins/builtin/'))
    ).toBe(false)
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
    localCodexPluginMocks.listInstalledPlugins.mockResolvedValue({
      items: [installedCodexSitesPlugin()],
      deviceId: 'local-device',
    })
    await createSiteFromMenu()
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  test('switches between Codex and Core DSH plugin management tabs', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    await renderApp()

    expect(await screen.findByText('还没有安装插件')).toBeInTheDocument()
    expect(screen.queryByTestId('core-dsh-plugin-management')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-management-surface-core-dsh'))

    expect(screen.getByTestId('plugin-management-surface-core-dsh')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('core-dsh-plugin-management')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-management-codex-panel')).not.toBeInTheDocument()

    await userEvent.keyboard('{ArrowLeft}')

    expect(screen.getByTestId('plugin-management-surface-wework')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('plugin-management-codex-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('core-dsh-plugin-management')).not.toBeInTheDocument()
  })

  test('refreshes composer plugin candidates after toggling an installed plugin', async () => {
    const enabledPlugin = installedGithubPlugin()
    const disabledPlugin = installedGithubPlugin(false)
    const fallbackFetch = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/plugins/installed/59') && init?.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(disabledPlugin),
        } as Response
      }
      if (url.includes('/plugins/installed')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [enabledPlugin] }),
        } as Response
      }
      return fallbackFetch!(input, init)
    })
    const pluginStateChanged = vi.fn()
    window.addEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, pluginStateChanged)
    window.history.pushState({}, '', '/plugins/manage')

    await renderApp()
    expect(await screen.findByTestId('plugin-management-installed-list')).not.toHaveClass(
      'overflow-hidden'
    )
    await userEvent.click(screen.getByTestId('installed-plugin-actions-59'))
    expect(screen.getByTestId('installed-plugin-actions-menu-59')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('installed-plugin-toggle-59'))

    await waitFor(() => expect(pluginStateChanged).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/plugins/installed/59'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    )
    window.removeEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, pluginStateChanged)
  })
})
