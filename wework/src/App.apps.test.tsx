import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import './i18n'
import App from './App'
import { saveStoredCloudConnection } from '@/features/cloud-connection/cloudConnectionStorage'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  navigateEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  openEmbeddedBrowser: vi.fn().mockResolvedValue({
    nativeLabel: 'embedded-browser-native-1',
    title: null,
    url: 'https://app.example.com',
  }),
  setEmbeddedBrowserBounds: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/embedded-browser', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/embedded-browser')>()),
  ...embeddedBrowserMocks,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
  }),
}))

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

vi.mock('@/features/appshots/AppshotBridge', () => ({
  AppshotBridge: () => null,
}))

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

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    codexHomeMigrationStatus: vi.fn().mockResolvedValue({
      weworkCodexHome: '/Users/test/.wegent-executor/codex',
      nativeCodexHome: '/Users/test/.codex',
      weworkCodexHomeExists: true,
      nativeCodexHomeExists: true,
      shouldPromptMigration: false,
    }),
  }),
}))

vi.mock('@/pages/WorkbenchPage', () => ({
  WorkbenchPage: () => {
    const [value, setValue] = useState('')
    return (
      <div data-testid="workbench-page">
        WeWork 工作台
        <input
          data-testid="workbench-state-input"
          value={value}
          onChange={event => setValue(event.target.value)}
        />
      </div>
    )
  },
}))

vi.mock('@/pages/SitesPage', () => ({
  SitesPage: () => <div data-testid="sites-page">Sites</div>,
}))

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  })
}

describe('App center route', () => {
  beforeEach(() => {
    localStorage.clear()
    enableTauri()
    vi.stubEnv('DEV', false)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        let payload: unknown = {}
        if (url.includes('/auth/wework/config')) {
          payload = {
            web_url: 'https://app.example.com',
          }
        } else if (url.includes('/plugins/installed')) {
          payload = {
            items: [],
          }
        } else if (url.includes('/devices')) {
          payload = {
            items: [
              {
                id: 1,
                device_id: 'macbook-pro',
                name: 'MacBook Pro',
                status: 'online',
                is_default: true,
                device_type: 'local',
                connection_mode: 'websocket',
                capabilities: ['claudecode'],
                slot_used: 2,
                slot_max: 5,
                running_tasks: [],
                executor_version: '1.8.0',
                latest_version: '1.8.0',
                update_available: false,
                bind_shell: 'claudecode',
              },
            ],
            total: 1,
          }
        } else if (url.includes('/users/me/runtime-configs/codex')) {
          payload = {
            runtime: 'codex',
            display_name: 'Codex',
            use_user_config: false,
            use_proxy: false,
            configured: false,
            target_path: '~/.codex/auth.json',
            proxy_configured: false,
            proxy_url_masked: '',
          }
        } else if (url.includes('/users/me/proxy-config')) {
          payload = {
            configured: true,
            proxy_url_masked: 'http://127.0.0.1:7890',
          }
        } else if (url.includes('/apps/installed')) {
          payload = {
            apps: [
              {
                id: 'wegent-sites',
                slug: 'wegent-sites',
                name: 'Wegent Sites',
                description: 'Build and deploy Wegent Sites projects.',
                icon_url: null,
                runtime_name: 'Wegent Sites',
                enabled: true,
                callable: true,
                connection: {
                  status: 'connected',
                  external_account_name: null,
                  granted_scopes: [],
                  expires_at: null,
                },
                tool_summaries: [
                  {
                    name: 'wegent-sites__create_site',
                    title: 'Create Site',
                    description: 'Create a site',
                    raw_tool_name: 'create_site',
                  },
                ],
              },
            ],
          }
        }

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(payload),
        })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function waitForStartupScreenToClose() {
    await waitFor(() => {
      expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
    })
  }

  test('renders the app center in an Apps document tab', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    await waitForStartupScreenToClose()

    await waitFor(() => expect(window.location.pathname).toBe('/apps'))
    expect(screen.getByTestId('workspace-tab-strip')).toHaveTextContent('应用')
    expect(screen.getByRole('tab', { name: /应用/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('desktop-auxiliary-surface')).toHaveClass(
      'app-view-surface',
      'rounded-xl',
      'border'
    )
    expect(screen.getByTestId('workspace-tab-add')).toBeInTheDocument()
    expect(screen.getByTestId('apps-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '管理你的办公与编码应用' })).toBeInTheDocument()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('模型设置')).toBeInTheDocument()
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
    expect(screen.queryByText('MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('插件包')).not.toBeInTheDocument()
  })

  test('loads Agent from the connected cloud address', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://app.example.com',
      token: 'cloud-token',
      tokenExpiresAt: null,
      user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-21T00:00:00.000Z',
    })
    window.history.pushState({}, '', '/app/wegent')

    render(<App />)

    expect(await screen.findByTestId('app-iframe-wegent')).toHaveAttribute(
      'data-src',
      'https://app.example.com/login/oidc?access_token=cloud-token&token_type=bearer&login_success=true'
    )
  })

  test('renders the global Chrome titlebar on the workbench route', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(screen.getByTestId('chrome-titlebar')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-page')).toBeInTheDocument()
  })

  test('keeps duplicate task tabs as independent persistent workbench instances', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await waitForStartupScreenToClose()
    const firstInput = screen.getByTestId('workbench-state-input')
    fireEvent.change(firstInput, {
      target: { value: 'first task draft' },
    })

    fireEvent.click(screen.getByTestId('workspace-tab-add'))
    fireEvent.click(screen.getByTestId('workspace-tab-add-task'))

    const taskTabs = screen.getAllByRole('tab', { name: '任务' })
    expect(taskTabs).toHaveLength(2)
    const inputs = screen.getAllByTestId('workbench-state-input')
    expect(inputs).toHaveLength(2)
    expect(inputs.filter(input => input.getAttribute('value') === '')).toHaveLength(1)
    expect(inputs.filter(input => input.getAttribute('value') === 'first task draft')).toHaveLength(
      1
    )
    const secondInput = inputs.find(input => input !== firstInput)
    expect(secondInput).toBeDefined()
    fireEvent.change(secondInput!, {
      target: { value: 'second task draft' },
    })

    fireEvent.click(taskTabs[0])
    await waitFor(() => expect(firstInput).toHaveValue('first task draft'))
    fireEvent.click(taskTabs[1])
    await waitFor(() => expect(secondInput).toHaveValue('second task draft'))
    expect(firstInput).toHaveValue('first task draft')
  })

  test('keeps duplicate Agent tabs mounted as distinct iframe instances', async () => {
    saveStoredCloudConnection({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      webUrl: 'https://app.example.com',
      token: 'cloud-token',
      tokenExpiresAt: null,
      user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-07-21T00:00:00.000Z',
    })
    window.history.pushState({}, '', '/app/wegent')

    render(<App />)

    const firstIframe = await screen.findByTestId('app-iframe-wegent')
    const firstTabId = firstIframe.getAttribute('data-workspace-tab-id')
    expect(firstTabId).toMatch(/^agent-/)

    fireEvent.click(screen.getByTestId('workspace-tab-add'))
    fireEvent.click(screen.getByTestId('workspace-tab-add-agent'))

    const agentTabs = screen.getAllByRole('tab', { name: '智能体' })
    const iframes = screen.getAllByTestId('app-iframe-wegent')
    expect(agentTabs).toHaveLength(2)
    expect(iframes).toHaveLength(2)
    expect(new Set(iframes.map(iframe => iframe.getAttribute('data-workspace-tab-id'))).size).toBe(
      2
    )

    fireEvent.click(agentTabs[0])
    await waitFor(() => expect(agentTabs[0]).toHaveAttribute('aria-selected', 'true'))
    expect(document.body.contains(firstIframe)).toBe(true)
    expect(screen.getAllByTestId('app-iframe-wegent')).toHaveLength(2)
  })

  test('renders copyable debug instance rows', async () => {
    window.history.pushState({}, '', '/')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    })
    vi.stubEnv('VITE_WEWORK_DEV_TITLE', 'Runtime task')
    vi.stubEnv('VITE_WEWORK_DEV_PORT', '1420')
    vi.stubEnv('VITE_WEWORK_DEV_WORKTREE', '/Users/me/Wegent')
    vi.stubEnv('VITE_WEWORK_PARENT_TITLE', 'Parent task')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(screen.getByTestId('wework-dev-instance-trigger')).toHaveClass(
      'h-8',
      'w-8',
      'rounded-full'
    )
    fireEvent.click(screen.getByTestId('wework-dev-instance-trigger'))
    expect(screen.getByTestId('wework-dev-instance-badge')).toHaveTextContent('Runtime task')
    fireEvent.click(screen.getByTestId('copy-wework-dev-port-button'))
    expect(writeText).toHaveBeenCalledWith('1420')
    fireEvent.click(screen.getByTestId('copy-wework-dev-parent-title-button'))
    expect(writeText).toHaveBeenCalledWith('Parent task')

    fireEvent.click(screen.getByTestId('collapse-wework-dev-instance-button'))
    expect(screen.getByTestId('wework-dev-instance-trigger')).toHaveClass(
      'h-8',
      'w-8',
      'rounded-full'
    )
    expect(screen.getByTestId('wework-dev-instance-badge')).toHaveTextContent('Port')

    const badge = screen.getByTestId('wework-dev-instance-badge')
    vi.spyOn(badge, 'getBoundingClientRect').mockReturnValue({
      left: 900,
      top: 700,
      width: 32,
      height: 32,
      right: 932,
      bottom: 732,
      x: 900,
      y: 700,
      toJSON: () => ({}),
    })
    const trigger = screen.getByTestId('wework-dev-instance-trigger')
    fireEvent.pointerDown(trigger, { button: 0, clientX: 916, clientY: 716 })
    fireEvent.pointerMove(window, { clientX: 816, clientY: 616 })
    fireEvent.pointerUp(window)
    fireEvent.click(trigger)
    expect(badge).toHaveStyle({ left: '800px', top: '600px' })
    expect(trigger).toHaveClass('rounded-full')

    fireEvent.click(screen.getByTestId('wework-dev-instance-trigger'))
    expect(screen.getByTestId('wework-dev-instance-trigger')).not.toHaveClass('rounded-full')
  })

  test('keeps the app center sidebar available on desktop app widths', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()

    const appsPage = screen.getByTestId('apps-page')
    const sidebar = screen.getByTestId('apps-sidebar-nav')
    const sectionTabs = screen.getByTestId('apps-section-tabs')

    expect(appsPage).toHaveClass('md:grid-cols-[220px_minmax(0,1fr)]')
    expect(appsPage).not.toHaveClass('xl:grid-cols-[220px_minmax(0,1fr)]')
    expect(sidebar).toHaveClass('hidden', 'md:flex')
    expect(sidebar).not.toHaveClass('xl:flex')
    expect(sectionTabs).toHaveClass('md:hidden')
    expect(sectionTabs).not.toHaveClass('xl:hidden')
  })

  test('uses the document tab strip on the app center route', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()

    expect(screen.getByRole('tab', { name: /应用/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('workspace-tab-add')).toBeInTheDocument()

    expect(screen.getByTestId('apps-sidebar-nav')).toBeInTheDocument()
  })

  test('shows installed connector apps and opens Sites from Wegent Sites', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('apps-nav-installed-apps'))

    expect(await screen.findByTestId('installed-app-wegent-sites')).toHaveTextContent(
      'Wegent Sites'
    )
    expect(screen.getByTestId('installed-app-wegent-sites')).toHaveTextContent('create_site')

    fireEvent.click(screen.getByTestId('installed-app-open-sites'))

    await waitFor(() => expect(window.location.pathname).toBe('/sites'))
    expect(screen.getByTestId('sites-page')).toBeInTheDocument()
  })

  test('collapses the apps page header while scrolling the overview', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()

    const scrollContainer = screen.getByTestId('apps-scroll-container')
    const header = screen.getByTestId('apps-page-header')

    expect(header).toHaveAttribute('data-collapse-progress', '0.00')

    fireEvent.scroll(scrollContainer, { target: { scrollTop: 120 } })

    await waitFor(() => {
      expect(header).toHaveAttribute('data-collapse-progress', '1.00')
    })
  })
})
