import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  connectLocalExecutorToBackend: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  disconnectLocalExecutorFromBackend: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
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
  })

  async function waitForStartupScreenToClose() {
    await waitFor(() => {
      expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
    })
  }

  test('opens the app center from the fixed titlebar tab', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await waitForStartupScreenToClose()
    await userEvent.click(await screen.findByTestId('chrome-tab-apps'))

    await waitFor(() => expect(window.location.pathname).toBe('/apps'))
    expect(screen.getByTestId('chrome-tab-wework')).toHaveClass('w-8', 'min-w-0', 'px-0')
    expect(screen.getByTestId('chrome-tab-apps')).toHaveClass('w-8', 'min-w-0', 'px-0')
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

  test('overlays the workbench titlebar so the sidebar can reach the window top', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await waitForStartupScreenToClose()
    expect(screen.getByTestId('chrome-titlebar')).toHaveClass(
      'absolute',
      'inset-x-0',
      'top-0',
      'z-system',
      'bg-transparent'
    )
    expect(screen.getByTestId('chrome-tab-wework')).toHaveClass('w-8', 'min-w-0', 'px-0')
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
