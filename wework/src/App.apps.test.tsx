import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import './i18n'
import App from './App'

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
  WorkbenchPage: () => <div data-testid="workbench-page">WeWork 工作台</div>,
}))

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
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
        if (url.includes('/devices')) {
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

  test('renders the app center with fixed titlebar tabs on the app route', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    await waitForStartupScreenToClose()

    await waitFor(() => expect(window.location.pathname).toBe('/apps'))
    expect(screen.getByTestId('chrome-tab-wework')).toHaveClass('w-8', 'min-w-0', 'px-0')
    expect(screen.queryByTestId('chrome-tab-apps')).not.toBeInTheDocument()
    expect(screen.getByTestId('titlebar-sidebar-toggle-placeholder')).toHaveClass(
      'invisible',
      'pointer-events-none'
    )
    expect(screen.getByTestId('apps-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '管理你的办公与编码应用' })).toBeInTheDocument()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('模型设置')).toBeInTheDocument()
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
    expect(screen.queryByText('MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('插件包')).not.toBeInTheDocument()
  })

  test('does not render the global chrome titlebar on the workbench route', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(screen.queryByTestId('chrome-titlebar')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-page')).toBeInTheDocument()
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
    expect(screen.getByTestId('wework-dev-instance-badge')).toHaveTextContent('Runtime task')
    fireEvent.click(screen.getByTestId('copy-wework-dev-port-button'))
    expect(writeText).toHaveBeenCalledWith('1420')
    fireEvent.click(screen.getByTestId('copy-wework-dev-parent-title-button'))
    expect(writeText).toHaveBeenCalledWith('Parent task')
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
