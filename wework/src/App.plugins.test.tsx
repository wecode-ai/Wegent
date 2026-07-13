import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchContextValue } from '@/features/workbench/WorkbenchProvider'
import './i18n'
import App from './App'

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
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
        weworkCodexHome: '/Users/test/.wegent-executor/codex',
        nativeCodexHome: '/Users/test/.codex',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: true,
        shouldPromptMigration: false,
      }),
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
  currentRuntimeTaskRunning: false,
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

function createSkillZipFile(name: string, rootSkillMd = false): File {
  const encoder = new TextEncoder()
  const fileName = rootSkillMd ? 'SKILL.md' : `${name}/SKILL.md`
  const fileNameBytes = encoder.encode(fileName)
  const contentBytes = encoder.encode(
    [
      '---',
      `name: ${name}`,
      'description: Uploaded helper',
      'version: 1.0.0',
      'author: Alice',
      'tags: [personal, upload]',
      '---',
      '',
      'Use this skill carefully.',
    ].join('\n')
  )
  const localHeader = new Uint8Array(30 + fileNameBytes.length)
  const localView = new DataView(localHeader.buffer)
  localView.setUint32(0, 0x04034b50, true)
  localView.setUint16(4, 20, true)
  localView.setUint16(8, 0, true)
  localView.setUint32(18, contentBytes.length, true)
  localView.setUint32(22, contentBytes.length, true)
  localView.setUint16(26, fileNameBytes.length, true)
  localHeader.set(fileNameBytes, 30)

  const centralHeader = new Uint8Array(46 + fileNameBytes.length)
  const centralView = new DataView(centralHeader.buffer)
  centralView.setUint32(0, 0x02014b50, true)
  centralView.setUint16(4, 20, true)
  centralView.setUint16(6, 20, true)
  centralView.setUint16(10, 0, true)
  centralView.setUint32(20, contentBytes.length, true)
  centralView.setUint32(24, contentBytes.length, true)
  centralView.setUint16(28, fileNameBytes.length, true)
  centralHeader.set(fileNameBytes, 46)

  const centralDirectoryOffset = localHeader.length + contentBytes.length
  const endHeader = new Uint8Array(22)
  const endView = new DataView(endHeader.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, 1, true)
  endView.setUint16(10, 1, true)
  endView.setUint32(12, centralHeader.length, true)
  endView.setUint32(16, centralDirectoryOffset, true)

  return new File([localHeader, contentBytes, centralHeader, endHeader], `${name}.zip`, {
    type: 'application/zip',
  })
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
    vi.stubEnv('DEV', false)
    mockViewport.isMobile = false
    workbenchValue.state.runtimeWork = null
    workbenchValue.state.currentRuntimeTask = null
    vi.mocked(workbenchValue.openRuntimeTask).mockReset().mockResolvedValue(undefined)
    mockSystemSkillsFetch()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('opens the plugins page from the desktop sidebar', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugins-button'))

    await waitFor(() => expect(window.location.pathname).toBe('/plugins'))
    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-sidebar-placeholder')).not.toBeInTheDocument()
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

    render(<App />)

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

    render(<App />)

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

    render(<App />)

    const pluginsDragRegion = within(screen.getByTestId('plugins-topbar-drag-region')).getByTestId(
      'macos-titlebar-drag-region'
    )

    expect(pluginsDragRegion).toHaveAttribute('data-tauri-drag-region')
    expect(screen.getByTestId('plugins-topbar-drag-region')).toContainElement(pluginsDragRegion)
    expect(screen.getByTestId('runtime-search-button')).toBeInTheDocument()
    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '插件' })).toBeInTheDocument()
    expect(screen.getByTestId('plugins-no-marketplace-welcome')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-search-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-installed-strip')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '技能' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'MCP' })).not.toBeInTheDocument()
  })

  test('collapses and expands the desktop sidebar on plugin routes', async () => {
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-topbar')).toHaveClass('md:pl-6')

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
  })

  test('does not reserve traffic light space on collapsed plugin routes in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    localStorage.setItem('wework.desktop.sidebar.collapsed', 'true')
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()

    expect(screen.queryByTestId('chrome-titlebar')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-topbar')).toHaveClass('md:pl-6')
    expect(screen.getByTestId('plugins-topbar').style.paddingLeft).toBe('')
  })

  test('collapses and expands the desktop sidebar on plugin management route', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
  })

  test('uses the mobile shell for plugins route at the shared mobile breakpoint', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    expect(screen.getByTestId('open-mobile-drawer-button')).toBeInTheDocument()
    expect(screen.queryByTestId('collapse-sidebar-button')).not.toBeInTheDocument()
    expect(await screen.findByTestId('plugins-workspace')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-no-marketplace-welcome')).toBeInTheDocument()
    expect(screen.queryByTestId('plugins-create-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-marketplace-selector')).not.toBeInTheDocument()
  })

  test('opens plugins from the mobile settings menu', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins')

    render(<App />)

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

    render(<App />)

    expect(screen.getByTestId('open-mobile-drawer-button')).toBeInTheDocument()
    expect(screen.queryByTestId('collapse-sidebar-button')).not.toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
  })

  test('navigates to plugin management from the manage button', async () => {
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugins-manage-button'))

    await waitFor(() => expect(window.location.pathname).toBe('/plugins/manage'))
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.getByText('管理')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '插件 0' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'MCP 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '市场 1' })).toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('供应商 Token')).not.toBeInTheDocument()
  })

  test('renders plugin management on direct /plugins/manage visit', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-search-button')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索插件')).toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/plugins/installed'))
    ).toBe(false)
  })

  test('keeps installed plugin switch knobs anchored inside the track', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: 'MCP 1' }))
    const switchKnob = (await screen.findByTestId('installed-mcp-toggle-7')).querySelector('span')

    expect(switchKnob).toHaveClass('left-1')
  })

  test('toggles installed MCPs from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: 'MCP 1' }))
    expect(await screen.findByText('Custom Docs MCP')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('installed-mcp-toggle-7'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/installed/7',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    )
  })

  test('creates custom MCPs from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugin-management-create-button'))
    await userEvent.click(screen.getByTestId('plugins-create-mcp-option'))
    fireEvent.change(screen.getByTestId('custom-mcp-name-input'), {
      target: { value: 'local-docs' },
    })
    fireEvent.change(screen.getByTestId('custom-mcp-display-name-input'), {
      target: { value: 'Local Docs' },
    })
    fireEvent.change(screen.getByTestId('custom-mcp-url-input'), {
      target: { value: 'https://mcp.example.com/local' },
    })
    await userEvent.click(screen.getByTestId('custom-mcp-submit-button'))

    await userEvent.click(await screen.findByRole('tab', { name: 'MCP 2' }))
    expect(await screen.findByText('Local Docs')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/custom',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'local-docs',
          displayName: 'Local Docs',
          description: '',
          server: {
            type: 'streamable-http',
            url: 'https://mcp.example.com/local',
            base_url: 'https://mcp.example.com/local',
          },
          enabled: true,
        }),
      })
    )
  })

  test('configures provider token and installs provider MCPs', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: '市场 1' }))
    expect(screen.getByText('MCP Router')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('mcp-provider-token-mcp_router'), {
      target: { value: 'token' },
    })
    await userEvent.click(screen.getByTestId('mcp-provider-save-token-mcp_router'))

    expect(await screen.findByText('Hot Search MCP')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mcp-provider-install--weibo-hot-search'))

    await userEvent.click(await screen.findByRole('tab', { name: 'MCP 2' }))
    expect(await screen.findByText('Hot Search MCP')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcp-providers/keys',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mcp_router: 'token' }),
      })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/install',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"providerKey":"mcp_router"'),
      })
    )
  })

  test('toggles installed system skills from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: '技能 2' }))

    expect(await screen.findByText('wehot')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('installed-skill-toggle-42'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/42',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    )
  })

  test('uninstalls system skills from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: '技能 2' }))
    expect(await screen.findByText('wehot')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('installed-skill-uninstall-42'))

    await waitFor(() => expect(screen.queryByText('wehot')).not.toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/42',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  test('shows and uninstalls personal skills from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: '技能 2' }))
    expect(await screen.findByText('Excel Helper')).toBeInTheDocument()
    expect(screen.getByText('Analyze Excel workbooks')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('installed-skill-toggle-88'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/88',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    )

    await userEvent.click(screen.getByTestId('installed-skill-uninstall-88'))

    await waitFor(() => expect(screen.queryByText('Excel Helper')).not.toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/88',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  test('opens the management create menu and uploads a personal skill', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugin-management-create-button'))
    expect(screen.getByTestId('plugins-create-skill-option')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-create-mcp-option')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugins-create-skill-option'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const upload = screen.getByTestId('skill-upload-file-input')
    const file = createSkillZipFile('zip-helper', true)
    await userEvent.upload(upload, file)

    expect(await screen.findByDisplayValue('zip-helper')).toBeInTheDocument()
    expect(screen.getByText('Uploaded helper')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('skill-upload-confirm-button'))

    await userEvent.click(await screen.findByRole('tab', { name: '技能 3' }))
    expect(await screen.findByText('zip-helper')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/kinds/skills/upload',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/install/personal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ skillId: 78 }),
      })
    )
  })
})
