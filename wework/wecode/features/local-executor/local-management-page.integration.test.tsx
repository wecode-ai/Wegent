import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import App from '@/App'

const tauriState = vi.hoisted(() => ({
  executorRunning: false,
  cliAvailable: true,
  actionPending: false,
  envSaveCalls: 0,
  cachedAuthToken: null as string | null,
  savedAuthToken: null as string | null,
  invokeCommands: [] as string[],
  invokeArgs: [] as Array<{ command: string; args?: Record<string, unknown> }>,
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
    tauriState.invokeArgs.push({ command, args })
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
          path: tauriState.cliAvailable ? '/Users/alice/.wecode/wecode-cli/bin/wecode' : null,
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

    if (command === 'local_executor_ensure_started') {
      return Promise.resolve({
        running: true,
        ready: true,
        deviceId: 'local-device',
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

    if (command === 'get_executor_process_diagnostics') {
      return Promise.resolve({
        processes: [],
        port_occupants: [],
        error: null,
      })
    }

    if (command === 'get_local_executor_auth_token') {
      return Promise.resolve(tauriState.cachedAuthToken)
    }

    if (command === 'save_local_executor_auth_token') {
      const apiKey = args?.apiKey as { key?: string } | undefined
      tauriState.savedAuthToken = apiKey?.key || null
      tauriState.cachedAuthToken = tauriState.savedAuthToken
      return Promise.resolve(null)
    }

    if (command === 'kill_executor_processes') {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: 'cleaned',
        stderr: '',
      })
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

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    startDragging: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    innerSize: vi.fn().mockResolvedValue({
      toLogical: () => ({ width: 1280, height: 720 }),
    }),
    scaleFactor: vi.fn().mockResolvedValue(1),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (_event: string, listener: NonNullable<typeof tauriState.commandOutputListener>) => {
      tauriState.commandOutputListener = listener
      return Promise.resolve(() => {
        tauriState.commandOutputListener = null
      })
    }
  ),
}))

vi.mock('@/features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  useWorkbench: () => ({
    state: {
      devices: [
        {
          device_id: 'macbook-pro',
          status: 'online',
          device_type: 'local',
        },
      ],
    },
  }),
}))

vi.mock('@/features/appshots/AppshotBridge', () => ({
  AppshotBridge: () => null,
}))

vi.mock('@/features/local-runtime/LocalRuntimeInitializer', () => ({
  LocalRuntimeInitializer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/local-runtime/CodexHomeInitializer', () => ({
  CodexHomeInitializer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/pages/WorkbenchPage', () => ({
  WorkbenchPage: () => <div data-testid="workbench-page">WeWork 工作台</div>,
}))

vi.mock('@wecode/features/local-executor/LocalExecutorStartupIndicator', () => ({
  LocalExecutorStartupIndicator: () => (
    <div data-testid="local-startup-indicator">
      <button
        type="button"
        data-testid="local-startup-open-management-button"
        onClick={() => {
          window.history.pushState({}, '', '/local-management')
          window.dispatchEvent(new PopStateEvent('popstate'))
        }}
      >
        本机管理
      </button>
    </div>
  ),
}))

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

async function openLocalManagement() {
  return screen.findByTestId('local-management-page')
}

describe('local executor management page', () => {
  beforeEach(() => {
    localStorage.clear()
    tauriState.executorRunning = false
    tauriState.cliAvailable = true
    tauriState.actionPending = false
    tauriState.envSaveCalls = 0
    tauriState.cachedAuthToken = null
    tauriState.savedAuthToken = null
    tauriState.invokeCommands = []
    tauriState.invokeArgs = []
    tauriState.commandOutputListener = null
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
        } else if (url.includes('/api-keys')) {
          payload = {
            key: 'executor-api-key-1',
            name: 'wework-local-executor-test',
            created_at: '2026-06-16T00:00:00Z',
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

  test('shows the basic local management controls', async () => {
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    expect(await screen.findByText('v22.12.0')).toBeInTheDocument()
    expect(screen.getByText('本机依赖检测')).toBeInTheDocument()
    expect(screen.getByText('快捷操作')).toBeInTheDocument()
    expect(screen.queryByText('启动环境变量')).not.toBeInTheDocument()
    expect(screen.queryByText('连接诊断')).not.toBeInTheDocument()
    expect(screen.queryByText('本机插件')).not.toBeInTheDocument()
    expect(screen.queryByText('最近输出')).not.toBeInTheDocument()
    expect(await screen.findByTestId('executor-primary-action-button')).toHaveTextContent(
      '启动 Executor'
    )
    expect(screen.getByTestId('executor-local-primary-action-button')).toHaveTextContent(
      '启动 Executor'
    )
    expect(screen.queryByTestId('executor-env-toggle-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('executor-env-save-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('executor-open-logs-button')).not.toBeInTheDocument()
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
    expect(screen.queryByText('MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('插件包')).not.toBeInTheDocument()
  })

  test('unlocks local management advanced settings after five title clicks', async () => {
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    const title = await screen.findByTestId('local-management-title')
    for (let clickCount = 0; clickCount < 4; clickCount += 1) {
      fireEvent.click(title)
    }

    expect(screen.queryByText('启动环境变量')).not.toBeInTheDocument()

    fireEvent.click(title)

    expect(screen.getByText('启动环境变量')).toBeInTheDocument()
    expect(screen.getByText('连接诊断')).toBeInTheDocument()
    expect(screen.getByText('本机插件')).toBeInTheDocument()
    expect(screen.getByText('最近输出')).toBeInTheDocument()
    expect(screen.getByTestId('advanced-settings-toast')).toHaveTextContent('已开启高级设置')
    expect(localStorage.getItem('wework.localManagement.advancedSettingsEnabled')).toBe('true')
  })

  test('resets the title click sequence after three seconds', async () => {
    let currentTime = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    const title = await screen.findByTestId('local-management-title')
    for (let clickCount = 0; clickCount < 4; clickCount += 1) {
      fireEvent.click(title)
    }

    currentTime += 3_001
    fireEvent.click(title)
    for (let clickCount = 0; clickCount < 3; clickCount += 1) {
      fireEvent.click(title)
    }

    expect(screen.queryByText('启动环境变量')).not.toBeInTheDocument()

    fireEvent.click(title)

    expect(screen.getByText('启动环境变量')).toBeInTheDocument()
    nowSpy.mockRestore()
  })

  test('restores persisted advanced settings without showing the unlock toast', async () => {
    localStorage.setItem('wework.localManagement.advancedSettingsEnabled', 'true')
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    expect(await screen.findByText('启动环境变量')).toBeInTheDocument()
    expect(screen.getByText('连接诊断')).toBeInTheDocument()
    expect(screen.getByText('本机插件')).toBeInTheDocument()
    expect(screen.getByText('最近输出')).toBeInTheDocument()
    expect(screen.queryByTestId('advanced-settings-toast')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('local-management-title'))

    expect(screen.queryByTestId('advanced-settings-toast')).not.toBeInTheDocument()
  })

  test('switches the primary executor action to restart when running', async () => {
    tauriState.executorRunning = true
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    expect(await screen.findByTestId('executor-primary-action-button')).toHaveTextContent(
      '重启 Executor'
    )
    expect(screen.getByTestId('executor-local-primary-action-button')).toHaveTextContent(
      '重启 Executor'
    )
    expect(screen.queryByTestId('executor-restart-button')).not.toBeInTheDocument()
  })

  test('shows the active executor action animation while a command is running', async () => {
    tauriState.actionPending = true
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    const actionButton = await screen.findByTestId('executor-primary-action-button')
    await userEvent.click(actionButton)

    expect(actionButton).toHaveTextContent('启动中...')
    expect(actionButton.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.getByTestId('executor-stop-button')).toBeDisabled()
    await waitFor(() => expect(tauriState.invokeCommands).toContain('run_executor_command'))
    expect(tauriState.invokeCommands.indexOf('save_startup_env')).toBeLessThan(
      tauriState.invokeCommands.indexOf('run_executor_command')
    )
    expect(tauriState.savedAuthToken).toBe('executor-api-key-1')
    expect(
      tauriState.invokeArgs.find(item => item.command === 'run_executor_command')?.args
    ).toMatchObject({
      authToken: 'executor-api-key-1',
    })
  })

  test('streams executor command output in the quick actions terminal', async () => {
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()
    await userEvent.click(await screen.findByTestId('executor-primary-action-button'))

    const terminal = await screen.findByTestId('executor-command-terminal')
    const output = screen.getByTestId('executor-command-output')
    await waitFor(() => expect(terminal).toHaveTextContent('执行完成'))
    expect(output).toHaveTextContent('$ wecode executor start')
    expect(output).toHaveTextContent('Starting executor...')
    expect(output).toHaveTextContent('Executor started successfully')
  })

  test('offers automatic WeCode CLI installation when CLI is missing', async () => {
    tauriState.cliAvailable = false
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    const installButton = await screen.findByTestId('executor-primary-action-button')
    expect(installButton).toHaveTextContent('安装 WeCode CLI')
    await userEvent.click(installButton)

    await waitFor(() => expect(tauriState.invokeCommands).toContain('run_executor_command'))
    expect(screen.getByTestId('executor-command-output')).toHaveTextContent('$ 安装 WeCode CLI')
  })

  test('reuses cached local executor auth token when starting', async () => {
    tauriState.cachedAuthToken = 'cached-executor-api-key'
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()
    await userEvent.click(await screen.findByTestId('executor-primary-action-button'))

    await waitFor(() => expect(tauriState.invokeCommands).toContain('run_executor_command'))
    expect(tauriState.savedAuthToken).toBeNull()
    expect(
      tauriState.invokeArgs.find(item => item.command === 'run_executor_command')?.args
    ).toMatchObject({
      authToken: 'cached-executor-api-key',
    })
  })

  test('opens local management from the startup indicator', async () => {
    window.history.pushState({}, '', '/app/wegent')

    render(<App />)

    const indicator = await screen.findByTestId('local-startup-indicator')
    expect(indicator).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('local-startup-open-management-button'))

    await waitFor(() => expect(window.location.pathname).toBe('/local-management'))
    expect(await screen.findByTestId('local-management-page')).toBeInTheDocument()
  })

  test('shows four environment variables without clipping and autosaves edits', async () => {
    localStorage.setItem('wework.localManagement.advancedSettingsEnabled', 'true')
    window.history.pushState({}, '', '/local-management')

    render(<App />)
    await openLocalManagement()

    const addButton = await screen.findByTestId('executor-env-add-button')
    await userEvent.click(addButton)

    const fourthEnabled = screen.getByTestId('executor-env-enabled-checkbox-3')
    const fourthKey = screen.getByTestId('executor-env-key-input-3')
    expect(fourthEnabled.closest('label')).toBeVisible()
    expect(fourthKey).toBeVisible()
    expect(
      fourthEnabled.compareDocumentPosition(fourthKey) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.queryByTestId('executor-env-toggle-button')).not.toBeInTheDocument()

    await userEvent.type(fourthKey, 'WEGENT_BACKEND_URL')
    await userEvent.type(screen.getByTestId('executor-env-value-input-3'), 'http://localhost:9100')

    await waitFor(() => expect(tauriState.envSaveCalls).toBe(1), {
      timeout: 2000,
    })
    expect(screen.getByText('环境变量已自动保存，重启 Executor 后生效')).toBeInTheDocument()
  })
})
