import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchContextValue } from '@/features/workbench/WorkbenchProvider'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'
import { updateAppPreferences } from '@/tauri/appPreferences'
import type { InstalledPlugin } from '@/types/api'
import './i18n'
import App from './App'

const localCodexPluginMocks = vi.hoisted(() => ({
  listInstalledPlugins: vi.fn(),
  listSkills: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    startDragging: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    innerSize: vi.fn().mockResolvedValue({
      width: 1280,
      height: 720,
      toLogical: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    }),
    scaleFactor: vi.fn().mockResolvedValue(1),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
  }),
}))

const localPathMocks = vi.hoisted(() => ({
  exists: vi.fn(),
}))

vi.mock('@/lib/local-terminal', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/local-terminal')>()
  return {
    ...actual,
    localPathExists: localPathMocks.exists,
  }
})

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  getInitializedBundledPluginMarketplace: vi.fn().mockReturnValue(null),
  requestLocalExecutor: vi.fn().mockResolvedValue({}),
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
  state: {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    defaultTeam: null,
    projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
    devices: [],
    runtimeWork: null,
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
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    isAttachmentReadyToSend: true,
    setSelectedModel: vi.fn(),
    setSelectedModelOption: vi.fn(),
    setSelectedSkills: vi.fn(),
    toggleSkill: vi.fn(),
    handleFileSelect: vi.fn(),
    addExistingAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    resetAttachments: vi.fn(),
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
  bindRuntimeTaskToImSessions: vi.fn(),
  getImNotificationSettings: vi.fn(),
  updateGlobalImNotification: vi.fn(),
  subscribeRuntimeTaskNotifications: vi.fn(),
  unsubscribeRuntimeTaskNotifications: vi.fn(),
  rememberExecutionDevice: vi.fn(),
  refreshWorkLists: vi.fn(),
  refreshDevices: vi.fn(),
  getRemoteDeviceStartupCommand: vi.fn(),
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
      displayName: '站点',
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
        displayName: '站点',
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
      displayName: '微博小程序开发助手',
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
        displayName: '微博小程序开发助手',
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
        capabilities: ['create', 'publish', 'delete'],
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

function cacheApplicationTypes() {
  localStorage.setItem('wework:sites-application-types', JSON.stringify(applicationTypesResponse()))
}

vi.mock('@/features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
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

vi.mock('@/features/workbench/WorkbenchProvider', () => ({
  WorkbenchProvider: ({
    children,
    onStartupReadyChange,
  }: {
    children: React.ReactNode
    onStartupReadyChange?: (ready: boolean) => void
  }) => {
    queueMicrotask(() => onStartupReadyChange?.(true))
    return <>{children}</>
  },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchValue,
  useWorkbenchPaneContext: () => workbenchValue,
}))

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockViewport.isMobile,
}))

function renderApp() {
  const lifecycleStore = new RuntimeTaskLifecycleStore('app-plugins-test')
  return render(
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <App />
    </RuntimeTaskLifecycleProvider>
  )
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
      if (url.includes('/mcp-providers/mcp_router/servers')) {
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
  beforeEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    localStorage.clear()
    sessionStorage.clear()
    vi.stubEnv('DEV', false)
    mockViewport.isMobile = false
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
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
    localPathMocks.exists.mockReset().mockResolvedValue(false)
    mockSystemSkillsFetch()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('opens the plugins page from the desktop sidebar', async () => {
    window.history.pushState({}, '', '/')

    renderApp()

    await userEvent.click(await screen.findByTestId('plugins-button'))

    await waitFor(() => expect(window.location.pathname).toBe('/plugins'))
    expect(
      await screen.findByTestId('plugins-workspace', undefined, { timeout: 3000 })
    ).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-sidebar-placeholder')).not.toBeInTheDocument()
  })

  test('shows Sites as unavailable instead of calling a relative API in disconnected local mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      runtimeMode: 'local-first',
    }
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal server error'),
    } as Response)
    window.history.pushState({}, '', '/sites')

    renderApp()

    expect(await screen.findByTestId('sites-unavailable-state')).toHaveTextContent(
      '应用功能尚未推出'
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Internal server error')).not.toBeInTheDocument()
  })

  test('loads Sites from the authenticated cloud Backend in local mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      runtimeMode: 'local-first',
    }
    localStorage.setItem(
      'wework.cloudConnection',
      JSON.stringify({
        backendUrl: 'http://127.0.0.1:9100',
        apiBaseUrl: 'http://127.0.0.1:9100/api',
        socketBaseUrl: 'http://127.0.0.1:9100',
        socketPath: '/socket.io',
        token: 'cloud-secret',
        tokenExpiresAt: null,
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-07-15T00:00:00.000Z',
      })
    )
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

    renderApp()

    expect(await screen.findByText('云端站点')).toBeInTheDocument()
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
    window.history.pushState({}, '', '/sites')

    renderApp()
    await updateAppPreferences({ experimentalFeaturesEnabled: true })

    expect(await screen.findByTestId('sites-workspace')).toBeInTheDocument()
    expect(await screen.findByText('产品发布页')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/sites?app_type=web&offset=0&limit=20',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(await screen.findByTestId('sites-button')).toHaveAttribute('aria-current', 'page')

    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/builtin/wegent-sites/ensure-installed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$站点](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '站点',
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

    renderApp()
    await screen.findByText('还没有小程序')
    await userEvent.click(screen.getByTestId('sites-create-button'))
    await userEvent.click(screen.getByTestId('sites-create-mini-program-menu-item'))

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$微博小程序开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序',
        pluginName: '微博小程序开发助手',
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

    renderApp()
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
          '[$微博小程序开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序',
        pluginName: '微博小程序开发助手',
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

    renderApp()
    await screen.findByText('还没有站点')
    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/builtin/wegent-sites/ensure-installed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ device_id: 'local-device' }),
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      })
    )
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$站点](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '站点',
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

    renderApp()
    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$站点](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '站点',
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

    renderApp()
    await createSiteFromMenu()

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(JSON.parse(sessionStorage.getItem('wework:pending-plugin-trial') ?? '{}')).toMatchObject(
      {
        input:
          '[$站点](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
        pluginName: '站点',
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

    renderApp()

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

    renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '应用插件未能同步到目标设备，请检查设备后重试'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('does not install Sites until an online compatible target device is selected', async () => {
    workbenchValue.state.devices = []
    workbenchValue.state.standaloneDeviceId = null
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
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

    renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '请选择一个在线且版本兼容的设备后再创建应用'
    )
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) =>
          String(input).includes('/plugins/builtin/wegent-sites/ensure-installed')
        )
    ).toBe(false)
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

    renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '应用插件安装失败，请重试'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(screen.getByTestId('sites-create-button')).toBeEnabled()
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('explains when the cloud Backend does not provide the built-in Sites endpoint', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/plugins/builtin/wegent-sites/ensure-installed')) {
        return {
          ok: false,
          status: 404,
          text: () => Promise.resolve('{"detail":"Not Found"}'),
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

    renderApp()

    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '云端 Backend 尚未支持对应的应用插件，请先部署最新 Backend'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('requires a cloud connection before installing Sites in local-first mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      runtimeMode: 'local-first',
    }
    cacheApplicationTypes()
    window.history.pushState({}, '', '/sites')

    renderApp()

    await screen.findByTestId('sites-unavailable-state')
    await createSiteFromMenu()

    expect(await screen.findByTestId('sites-create-error')).toHaveTextContent(
      '连接云端后才能使用应用创建插件'
    )
    expect(window.location.pathname).toBe('/sites')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('opens a runtime task from the plugins sidebar and leaves the plugins route', async () => {
    const workspacePath = '/Users/alice/Documents/Codex/plugin-task'
    workbenchValue.state.runtimeWork = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          deviceName: 'Local Mac',
          deviceStatus: 'online',
          available: true,
          workspacePath,
          workspaceKind: 'chat',
          tasks: [
            {
              taskId: 'plugin-task',
              workspacePath,
              workspaceKind: 'chat',
              title: 'Return to task',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 1,
    }
    window.history.pushState({}, '', '/plugins')

    renderApp()

    await userEvent.click(await screen.findByTestId('runtime-local-task-row-plugin-task'))

    await waitFor(() => {
      expect(workbenchValue.openRuntimeTask).toHaveBeenCalledWith({
        deviceId: 'local-device',
        workspacePath,
        taskId: 'plugin-task',
      })
      expect(window.location.pathname).toBe('/runtime-tasks')
    })
    expect(window.location.search).toBe('?deviceId=local-device&taskId=plugin-task')
    expect(screen.queryByTestId('plugins-workspace')).not.toBeInTheDocument()
  })

  test('preserves the workbench composer while visiting plugins', async () => {
    window.history.pushState({}, '', '/')

    renderApp()

    const composer = await screen.findByTestId('chat-message-input')
    fireEvent.input(composer, { target: { textContent: '保留这段草稿' } })
    await userEvent.click(screen.getByTestId('plugins-button'))
    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()

    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(screen.getByTestId('chat-message-input')).toBe(composer)
  })

  test('renders the plugins page on direct /plugins visit', async () => {
    window.history.pushState({}, '', '/plugins')

    renderApp()

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()

    const pluginsDragRegion = within(screen.getByTestId('plugins-topbar-drag-region')).getByTestId(
      'macos-titlebar-drag-region'
    )

    expect(pluginsDragRegion).toHaveAttribute('data-tauri-drag-region')
    expect(screen.getByTestId('plugins-topbar-drag-region')).toContainElement(pluginsDragRegion)
    expect(screen.getByTestId('runtime-search-button')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '插件' })).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toHaveTextContent(
      'Wework 云端市场'
    )
    expect(screen.getByTestId('plugins-search-input')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-installed-strip')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '技能' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'MCP' })).not.toBeInTheDocument()
  })

  test('collapses and expands the desktop sidebar on plugin routes', async () => {
    window.history.pushState({}, '', '/plugins')

    renderApp()

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    await userEvent.click(
      within(screen.getByTestId('desktop-sidebar')).getByTestId('collapse-sidebar-button')
    )

    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-page-content')).toHaveClass('md:pl-6')

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))
    expect(await screen.findByTestId('plugins-button')).toBeInTheDocument()
  })

  test('uses the global Chrome titlebar on collapsed plugin routes in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    localStorage.setItem('wework.desktop.sidebar.collapsed', 'true')
    window.history.pushState({}, '', '/plugins')

    renderApp()

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()

    expect(screen.getByTestId('chrome-titlebar')).toBeInTheDocument()
    expect(screen.getByTestId('macos-traffic-light-spacer')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-page-content')).toHaveClass('md:pl-6')
    expect(screen.getByTestId('plugins-page-content').style.paddingLeft).toBe('')
  })

  test('uses the mobile shell for plugins route at the shared mobile breakpoint', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins')

    renderApp()

    expect(await screen.findByTestId('open-mobile-drawer-button')).toBeInTheDocument()
    expect(screen.queryByTestId('collapse-sidebar-button')).not.toBeInTheDocument()
    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-marketplace-tab-default')).toHaveTextContent(
      'Wework 云端市场'
    )
    expect(screen.getByTestId('plugins-create-button')).toHaveClass('plugin-market-action-button')
    expect(screen.getByTestId('plugins-create-button')).toHaveTextContent('创建')
    expect(screen.getByTestId('plugins-marketplace-source-switcher')).toHaveClass('sr-only')
  })

  test('opens plugins from the mobile settings menu', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins')

    renderApp()

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-button'))

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-plugins-button')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/plugins')
  })

  test('uses the mobile shell for plugin management route at the shared mobile breakpoint', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins/manage')

    renderApp()

    expect(await screen.findByTestId('open-mobile-drawer-button')).toBeInTheDocument()
    expect(screen.queryByTestId('collapse-sidebar-button')).not.toBeInTheDocument()
    expect(await screen.findByText('还没有安装插件')).toBeInTheDocument()
  })

  test('navigates to plugin management from the manage button', async () => {
    window.history.pushState({}, '', '/plugins')

    renderApp()

    await userEvent.click(await screen.findByTestId('plugins-manage-button'))

    await waitFor(() => expect(window.location.pathname).toBe('/plugins/manage'))
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '管理插件' })).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(await screen.findByText('还没有安装插件')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-management-browse-marketplace-button')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('供应商 Token')).not.toBeInTheDocument()
  })

  test('renders plugin management on direct /plugins/manage visit', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    renderApp()

    expect(await screen.findByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-search-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-management-topbar')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-management-page-content')).toBeInTheDocument()
    expect(await screen.findByText('还没有安装插件')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/plugins/installed'))
      ).toBe(true)
    )
  })

  test('keeps standalone MCP and Skill management out of the plugin page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    renderApp()

    expect(await screen.findByRole('heading', { name: '管理插件' })).toBeInTheDocument()
    expect(screen.queryByText('Custom Docs MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('wehot')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
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

    renderApp()
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
