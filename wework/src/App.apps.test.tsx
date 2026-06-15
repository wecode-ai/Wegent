import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import './i18n'
import App from './App'

const tauriState = vi.hoisted(() => ({
  executorRunning: false,
  cliAvailable: true,
  actionPending: false,
  envSaveCalls: 0,
  invokeCommands: [] as string[],
  commandOutputListener: null as
    | ((event: {
        payload: {
          execution_id: string
          stream: 'stdout' | 'stderr'
          content: string
        }
      }) => void)
    | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn((command: string, args?: Record<string, unknown>) => {
    tauriState.invokeCommands.push(command)
    if (command === 'get_executor_status') {
      return Promise.resolve({
        node: {
          available: true,
          path: '/opt/homebrew/bin/node',
          version: 'v22.12.0',
          major_version: 22,
          meets_minimum: true,
          error: null,
        },
        cli: {
          available: tauriState.cliAvailable,
          path: tauriState.cliAvailable
            ? '/Users/alice/.wecode/wecode-cli/bin/wecode'
            : null,
          version: tauriState.cliAvailable ? 'wecode 1.2.3' : null,
          error: tauriState.cliAvailable ? null : 'wecode not found',
        },
        installed: tauriState.cliAvailable,
        running: tauriState.executorRunning,
        pid: tauriState.executorRunning ? 12345 : null,
        version: null,
        output: tauriState.executorRunning
          ? 'Installed: Yes\nStatus: Running\nPID: 12345'
          : 'Installed: Yes\nStatus: Stopped',
        error: null,
      })
    }

    if (command === 'get_startup_env') {
      return Promise.resolve([
        {
          key: 'WECODE_CLI_PORT',
          value: '3456',
          enabled: true,
          sensitive: false,
        },
        {
          key: 'WECODE_NO_AUTO_UPGRADE',
          value: '1',
          enabled: false,
          sensitive: false,
        },
        {
          key: 'CLAUDE_CODE_NPM_REGISTRY',
          value: 'https://registry.npmmirror.com',
          enabled: false,
          sensitive: false,
        },
      ])
    }

    if (command === 'save_startup_env') {
      tauriState.envSaveCalls += 1
      return Promise.resolve([
        {
          key: 'WECODE_CLI_PORT',
          value: '3456',
          enabled: true,
          sensitive: false,
        },
      ])
    }

    if (command === 'run_executor_command') {
      if (tauriState.actionPending) {
        return new Promise(() => undefined)
      }
      tauriState.commandOutputListener?.({
        payload: {
          execution_id: String(args?.executionId),
          stream: 'stdout',
          content: 'Starting executor...\\nExecutor started successfully\\n',
        },
      })
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: 'ok',
        stderr: '',
      })
    }

    return Promise.resolve(null)
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (
      _event: string,
      listener: NonNullable<typeof tauriState.commandOutputListener>,
    ) => {
      tauriState.commandOutputListener = listener
      return Promise.resolve(() => {
        tauriState.commandOutputListener = null
      })
    },
  ),
}))

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
    tauriState.executorRunning = false
    tauriState.cliAvailable = true
    tauriState.actionPending = false
    tauriState.envSaveCalls = 0
    tauriState.invokeCommands = []
    tauriState.commandOutputListener = null
    enableTauri()
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
      }),
    )
  })

  test('opens the app center from the fixed titlebar tab', async () => {
    window.history.pushState({}, '', '/')

    render(<App />)

    await userEvent.click(screen.getByTestId('chrome-tab-apps'))

    await waitFor(() => expect(window.location.pathname).toBe('/apps'))
    expect(screen.getByTestId('apps-page')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '管理你的办公与编码应用' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    expect(screen.getByTestId('apps-nav-local-management')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(
      screen.queryByTestId('local-management-page'),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('apps-nav-local-management'))
    expect(
      await screen.findByTestId('local-management-page'),
    ).toBeInTheDocument()
    expect(await screen.findByText('启动环境变量')).toBeInTheDocument()
    expect(await screen.findByText('v22.12.0')).toBeInTheDocument()
    expect(
      await screen.findByTestId('executor-primary-action-button'),
    ).toHaveTextContent('启动 Executor')
    expect(
      screen.getByTestId('executor-local-primary-action-button'),
    ).toHaveTextContent('启动 Executor')
    expect(
      screen.queryByTestId('executor-env-toggle-button'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('executor-env-save-button'),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('executor-open-logs-button')).toHaveTextContent(
      '打开日志目录',
    )
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
    expect(screen.queryByText('MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('插件包')).not.toBeInTheDocument()
  })

  test('collapses the apps page header while scrolling the overview', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()

    const scrollContainer = screen.getByTestId('apps-scroll-container')
    const header = screen.getByTestId('apps-page-header')

    expect(header).toHaveAttribute('data-collapse-progress', '0.00')

    fireEvent.scroll(scrollContainer, { target: { scrollTop: 120 } })

    await waitFor(() => {
      expect(header).toHaveAttribute('data-collapse-progress', '1.00')
    })
  })

  test('switches the primary executor action to restart when running', async () => {
    tauriState.executorRunning = true
    window.history.pushState({}, '', '/apps')

    render(<App />)

    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('apps-nav-local-management'))

    expect(
      await screen.findByTestId('executor-primary-action-button'),
    ).toHaveTextContent('重启 Executor')
    expect(
      screen.getByTestId('executor-local-primary-action-button'),
    ).toHaveTextContent('重启 Executor')
    expect(
      screen.queryByTestId('executor-restart-button'),
    ).not.toBeInTheDocument()
  })

  test('shows the active executor action animation while a command is running', async () => {
    tauriState.actionPending = true
    window.history.pushState({}, '', '/apps')

    render(<App />)

    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('apps-nav-local-management'))

    const actionButton = await screen.findByTestId(
      'executor-primary-action-button',
    )
    await userEvent.click(actionButton)

    expect(actionButton).toHaveTextContent('启动中...')
    expect(actionButton.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.getByTestId('executor-stop-button')).toBeDisabled()
    await waitFor(() =>
      expect(tauriState.invokeCommands).toContain('run_executor_command'),
    )
    expect(tauriState.invokeCommands.indexOf('save_startup_env')).toBeLessThan(
      tauriState.invokeCommands.indexOf('run_executor_command'),
    )
  })

  test('streams executor command output in the quick actions terminal', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('apps-nav-local-management'))
    await userEvent.click(
      await screen.findByTestId('executor-primary-action-button'),
    )

    const terminal = await screen.findByTestId('executor-command-terminal')
    const output = screen.getByTestId('executor-command-output')
    await waitFor(() => expect(terminal).toHaveTextContent('执行完成'))
    expect(output).toHaveTextContent('$ wecode executor start')
    expect(output).toHaveTextContent('Starting executor...')
    expect(output).toHaveTextContent('Executor started successfully')
  })

  test('offers automatic WeCode CLI installation when CLI is missing', async () => {
    tauriState.cliAvailable = false
    window.history.pushState({}, '', '/apps')

    render(<App />)

    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('apps-nav-local-management'))

    const installButton = await screen.findByTestId(
      'executor-primary-action-button',
    )
    expect(installButton).toHaveTextContent('安装 WeCode CLI')
    await userEvent.click(installButton)

    await waitFor(() =>
      expect(tauriState.invokeCommands).toContain('run_executor_command'),
    )
    expect(screen.getByTestId('executor-command-output')).toHaveTextContent(
      '$ 安装 WeCode CLI',
    )
  })

  test('shows four environment variables without clipping and autosaves edits', async () => {
    window.history.pushState({}, '', '/apps')

    render(<App />)

    expect(await screen.findByText('Executor 状态')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('apps-nav-local-management'))

    const addButton = await screen.findByTestId('executor-env-add-button')
    await userEvent.click(addButton)

    const fourthEnabled = screen.getByTestId('executor-env-enabled-checkbox-3')
    const fourthKey = screen.getByTestId('executor-env-key-input-3')
    expect(fourthEnabled).toBeVisible()
    expect(fourthKey).toBeVisible()
    expect(
      fourthEnabled.compareDocumentPosition(fourthKey) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      screen.queryByTestId('executor-env-toggle-button'),
    ).not.toBeInTheDocument()

    await userEvent.type(fourthKey, 'WEGENT_BACKEND_URL')
    await userEvent.type(
      screen.getByTestId('executor-env-value-input-3'),
      'http://localhost:9100',
    )

    await waitFor(() => expect(tauriState.envSaveCalls).toBe(1), {
      timeout: 2000,
    })
    expect(
      screen.getByText('环境变量已自动保存，重启 Executor 后生效'),
    ).toBeInTheDocument()
  })
})
