import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchContextValue } from '@/features/workbench/WorkbenchProvider'
import './i18n'
import App from './App'

const mockViewport = vi.hoisted(() => ({
  isMobile: false,
}))

const workbenchValue: WorkbenchContextValue = {
  state: {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    defaultTeam: null,
    projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
    devices: [],
    recentTasks: [],
    currentProject: null,
    standaloneDeviceId: null,
    currentTask: null,
    input: '',
    isBootstrapping: false,
    isSending: false,
    error: null,
  },
  messages: [],
  queuedMessages: [],
  guidanceMessages: [],
  runningTaskIds: new Set(),
  projectExecutionMode: 'current_workspace',
  setProjectExecutionMode: vi.fn(),
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
  selectStandaloneDevice: vi.fn(),
  startNewChat: vi.fn(),
  startStandaloneChat: vi.fn(),
  startNewProjectChat: vi.fn(),
  openTask: vi.fn(),
  rememberExecutionDevice: vi.fn(),
  refreshWorkLists: vi.fn(),
  createProject: vi.fn(),
  updateProjectName: vi.fn(),
  removeProject: vi.fn(),
  archiveAllChats: vi.fn(),
  archiveAllProjectChats: vi.fn(),
  archiveProjectChats: vi.fn(),
  archiveTask: vi.fn(),
  renameTask: vi.fn(),
  listArchivedTasks: vi.fn(),
  unarchiveTask: vi.fn(),
  deleteTask: vi.fn(),
  deleteArchivedTasks: vi.fn(),
  getDeviceHomeDirectory: vi.fn(),
  getProjectWorkspaceRoot: vi.fn(),
  listDeviceDirectories: vi.fn(),
  createDeviceDirectory: vi.fn(),
  loadEnvironmentInfo: vi.fn(),
  commitEnvironmentChanges: vi.fn(),
  listEnvironmentBranches: vi.fn(),
  checkoutEnvironmentBranch: vi.fn(),
  createEnvironmentBranch: vi.fn(),
  setInput: vi.fn(),
  sendCurrentInput: vi.fn(),
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
    ].join('\n'),
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
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    loginWithOidcToken: vi.fn(),
  }),
}))

vi.mock('@/features/workbench/WorkbenchProvider', () => ({
  WorkbenchProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchValue,
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
        payload = init?.method === 'PUT' ? installedSkillsResponse.items[0] : installedSkillsResponse
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
    }),
  )
}

describe('App plugins route', () => {
  beforeEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    localStorage.clear()
    mockViewport.isMobile = false
    mockSystemSkillsFetch()
  })

  test('navigates to the plugins page from the sidebar button', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugins-button'))

    await waitFor(() => expect(window.location.pathname).toBe('/plugins'))
    expect(screen.getByRole('tab', { name: '插件' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: '技能' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(screen.getByRole('tab', { name: 'MCP' })).toBeInTheDocument()
    expect(screen.getByText('让 Wework 按你的方式工作')).toBeInTheDocument()
  })

  test('renders the plugins page on direct /plugins visit', async () => {
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    const pluginsDragRegion = within(
      screen.getByTestId('plugins-topbar-drag-region'),
    ).getByTestId('macos-titlebar-drag-region')

    expect(pluginsDragRegion).toHaveAttribute('data-tauri-drag-region')
    expect(screen.getByTestId('plugins-topbar-drag-region')).toContainElement(
      pluginsDragRegion,
    )
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '技能' }))
    expect(await screen.findByText('wehot')).toBeInTheDocument()
    expect(screen.queryByText('找不到技能')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills?category=system&page=1&pageSize=20',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  test('collapses and expands the desktop sidebar on plugin routes', async () => {
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.queryByTestId('plugins-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-topbar')).toHaveClass('md:pl-6')

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
  })

  test('reserves native macOS traffic light space on collapsed plugin routes in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.getByTestId('plugins-topbar')).toHaveStyle({
      paddingLeft: '89px',
    })
  })

  test('collapses and expands the desktop sidebar on plugin management route', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.queryByTestId('plugins-button')).not.toBeInTheDocument()
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
    expect(screen.getByTestId('plugins-create-button')).toHaveClass(
      'h-11',
      'w-11',
    )
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
  })

  test('closes mobile settings when opening plugins from the settings menu', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-button'))

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))

    await waitFor(() =>
      expect(screen.queryByTestId('mobile-settings-page')).not.toBeInTheDocument(),
    )
    expect(window.location.pathname).toBe('/plugins')
    expect(screen.getByTestId('open-mobile-drawer-button')).toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
  })

  test('uses the mobile shell for plugin management route at the shared mobile breakpoint', async () => {
    mockViewport.isMobile = true
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    expect(screen.getByTestId('open-mobile-drawer-button')).toBeInTheDocument()
    expect(screen.queryByTestId('collapse-sidebar-button')).not.toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
  })

  test('switches to the MCP catalog from the plugins page', async () => {
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    await userEvent.click(screen.getByRole('tab', { name: 'MCP' }))

    expect(screen.getByRole('tab', { name: 'MCP' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByPlaceholderText('搜索 MCP')).toBeInTheDocument()
    expect(await screen.findByText('MCP Router')).toBeInTheDocument()
    expect(await screen.findByText('Hot Search MCP')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('供应商 Token')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcp-providers/mcp_router/servers',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes('/api/mcps/installed')),
    ).toBe(false)
  })

  test('navigates to plugin management from the manage button', async () => {
    window.history.pushState({}, '', '/plugins')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugins-manage-button'))

    await waitFor(() =>
      expect(window.location.pathname).toBe('/plugins/manage'),
    )
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.getByText('管理')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '插件 0' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: 'MCP 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '市场 1' })).toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('供应商 Token')).not.toBeInTheDocument()
  })

  test('renders plugin management on direct /plugins/manage visit', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    expect(screen.getByTestId('plugins-button')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]',
    )
    expect(screen.getByPlaceholderText('搜索插件')).toBeInTheDocument()
    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/installed',
        expect.objectContaining({ method: 'GET' }),
      ),
    )
  })

  test('keeps installed plugin switch knobs anchored inside the track', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: 'MCP 1' }))
    const switchKnob = (
      await screen.findByTestId('installed-mcp-toggle-7')
    ).querySelector('span')

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
      }),
    )
  })

  test('creates custom MCPs from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(screen.getByTestId('plugin-management-create-button'))
    await userEvent.click(screen.getByTestId('plugins-create-mcp-option'))
    await userEvent.type(screen.getByTestId('custom-mcp-name-input'), 'local-docs')
    await userEvent.type(
      screen.getByTestId('custom-mcp-display-name-input'),
      'Local Docs',
    )
    await userEvent.type(
      screen.getByTestId('custom-mcp-url-input'),
      'https://mcp.example.com/local',
    )
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
      }),
    )
  })

  test('configures provider token and installs provider MCPs', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: '市场 1' }))
    expect(screen.getByText('MCP Router')).toBeInTheDocument()
    await userEvent.type(
      screen.getByTestId('mcp-provider-token-mcp_router'),
      'token',
    )
    await userEvent.click(
      screen.getByTestId('mcp-provider-save-token-mcp_router'),
    )

    expect(await screen.findByText('Hot Search MCP')).toBeInTheDocument()
    await userEvent.click(
      screen.getByTestId('mcp-provider-install--weibo-hot-search'),
    )

    await userEvent.click(await screen.findByRole('tab', { name: 'MCP 2' }))
    expect(await screen.findByText('Hot Search MCP')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcp-providers/keys',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mcp_router: 'token' }),
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/install',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"providerKey":"mcp_router"'),
      }),
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
      }),
    )
  })

  test('uninstalls system skills from management page', async () => {
    window.history.pushState({}, '', '/plugins/manage')

    render(<App />)

    await userEvent.click(await screen.findByRole('tab', { name: '技能 2' }))
    expect(await screen.findByText('wehot')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('installed-skill-uninstall-42'))

    await waitFor(() =>
      expect(screen.queryByText('wehot')).not.toBeInTheDocument(),
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/42',
      expect.objectContaining({ method: 'DELETE' }),
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
      }),
    )

    await userEvent.click(screen.getByTestId('installed-skill-uninstall-88'))

    await waitFor(() =>
      expect(screen.queryByText('Excel Helper')).not.toBeInTheDocument(),
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/88',
      expect.objectContaining({ method: 'DELETE' }),
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
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/install/personal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ skillId: 78 }),
      }),
    )
  })
})
