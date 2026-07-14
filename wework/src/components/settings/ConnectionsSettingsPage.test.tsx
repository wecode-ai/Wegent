import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConnectionsSettingsPage } from './ConnectionsSettingsPage'
import { createDeviceApi } from '@/api/devices'
import { createUserApi } from '@/api/users'
import { AppearanceProvider } from '@/features/appearance'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import { openExternalUrl } from '@/lib/external-links'
import { getLocalExecutorDeviceId, isLocalTerminalAvailable } from '@/lib/local-terminal'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import '@/i18n'
import type { DeviceInfo } from '@/types/devices'

const runtimeConfigMock = vi.hoisted(() => ({
  value: {
    appBasePath: '',
    apiBaseUrl: '/api',
    cloudDeviceScalingWikiUrl: '',
  },
}))
const localCodexPluginApiMock = vi.hoisted(() => ({
  readCodexLocalConfig: vi.fn(),
  updateCodexLocalConfig: vi.fn(),
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => runtimeConfigMock.value,
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn((options: unknown) => ({ options })),
  shouldUseTauriFetch: vi.fn(() => false),
}))

vi.mock('@/api/models', () => ({
  createModelApi: vi.fn(() => ({
    listModels: vi.fn().mockResolvedValue({ data: [] }),
  })),
}))

vi.mock('@/api/local/codexOfficialModels', () => ({
  getLocalCodexOfficialModels: vi.fn().mockResolvedValue({
    providers: [],
    models: [],
  }),
}))

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({
    runtime: 'codex',
    targetPath: '/Users/me/.codex/auth.json',
    exists: true,
    updatedAt: '2026-07-01T00:00:00.000Z',
    sha256: 'abc123',
    sizeBytes: 128,
    error: null,
  }),
}))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => localCodexPluginApiMock,
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/api/users', () => ({
  createUserApi: vi.fn(),
}))

vi.mock('@/lib/local-terminal', () => ({
  getLocalExecutorDeviceId: vi.fn(),
  isLocalTerminalAvailable: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: vi.fn().mockResolvedValue({ restarted: true }),
}))

vi.mock('@/components/layout/workspace-panels/RemoteTerminal', () => ({
  RemoteTerminal: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div
      data-testid="settings-device-remote-terminal"
      data-session-id={sessionId}
      hidden={!active}
    />
  ),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createUserApiMock = vi.mocked(createUserApi)
const openExternalUrlMock = vi.mocked(openExternalUrl)
const getLocalExecutorDeviceIdMock = vi.mocked(getLocalExecutorDeviceId)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)

function cloudDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'yunpeng7-executor-device-1',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.712',
    cloud_config: {
      sandboxId: 'sandbox-1',
      deviceId: 'cloud-runtime-device-1',
      ubuntuInitialPassword: 'initial-password-1',
    },
    ...overrides,
  }
}

function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return cloudDevice({
    id: 2,
    device_id: 'local-device',
    name: 'Local Claude Device',
    device_type: 'local',
    bind_shell: 'claudecode',
    cloud_config: undefined,
    ...overrides,
  })
}

function remoteDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return cloudDevice({
    id: 3,
    device_id: 'remote-device',
    name: 'Docker Remote Device',
    device_type: 'remote',
    bind_shell: 'claudecode',
    cloud_config: undefined,
    remote_config: {
      provider: 'docker',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      deviceId: 'remote-device',
      deviceName: 'Docker Remote Device',
    },
    ...overrides,
  })
}

describe('ConnectionsSettingsPage', () => {
  const api = {
    getAllDevices: vi.fn(),
    startTerminal: vi.fn(),
    startCodeServer: vi.fn(),
    openLocalTerminal: vi.fn(),
    createCloudDevice: vi.fn(),
    createDockerRemoteDeviceCommand: vi.fn(),
    renameDevice: vi.fn(),
    restartCloudDevice: vi.fn(),
    deleteCloudDevice: vi.fn(),
    deleteDevice: vi.fn(),
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
    getVncConfig: vi.fn(),
  }
  const userApi = {
    updateCurrentUser: vi.fn(),
    getRuntimeConfig: vi.fn(),
    updateRuntimeConfig: vi.fn(),
    getProxyConfig: vi.fn(),
    updateProxyConfig: vi.fn(),
    uploadRuntimeAuthJson: vi.fn(),
    importRuntimeAuthJson: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      cloudDeviceScalingWikiUrl: '',
    }
    window.history.pushState({}, '', '/settings/connections')
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue('local-claude')
    openExternalUrlMock.mockResolvedValue(true)
    api.openLocalTerminal.mockResolvedValue(undefined)
    api.getMetrics.mockResolvedValue({
      cpu_usage: 42,
      memory_usage: 68,
      disk_usage: 57,
    })
    api.getMetricsHistory.mockResolvedValue({
      cpu: [],
      memory: [],
      disk: [],
    })
    api.getVncConfig.mockResolvedValue({
      wss_url: 'wss://example.com/vnc',
      signature: 'signature',
      sandbox_id: 'sandbox-1',
    })
    localCodexPluginApiMock.readCodexLocalConfig.mockResolvedValue({
      codexHome: '/Users/crystal/.wegent-executor/codex',
      configPath: '/Users/crystal/.wegent-executor/codex/config.toml',
      remoteAppsEnabled: false,
    })
    localCodexPluginApiMock.updateCodexLocalConfig.mockImplementation(patch =>
      Promise.resolve({
        codexHome: '/Users/crystal/.wegent-executor/codex',
        configPath: '/Users/crystal/.wegent-executor/codex/config.toml',
        remoteAppsEnabled: Boolean(patch.remoteAppsEnabled),
      })
    )
    createDeviceApiMock.mockReturnValue(api)
    userApi.getRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    userApi.updateRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: true,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:01Z',
    })
    userApi.getProxyConfig.mockResolvedValue({
      configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: null,
    })
    userApi.updateProxyConfig.mockResolvedValue({
      configured: true,
      proxy_url_masked: 'http://127.0.0.1:7890',
      proxy_updated_at: '2026-06-09T00:00:02Z',
      updated_at: '2026-06-09T00:00:02Z',
    })
    userApi.uploadRuntimeAuthJson.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    userApi.importRuntimeAuthJson.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    createUserApiMock.mockReturnValue(userApi as ReturnType<typeof createUserApi>)
  })

  test('opens general settings by default', async () => {
    window.history.pushState({}, '', '/settings')
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('general-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
    const integrationsCategory = screen.getByTestId('settings-category-integrations')
    const codingCategory = screen.getByTestId('settings-category-coding')
    const archivedCategory = screen.getByTestId('settings-category-archived')
    const pluginsNav = screen.getByTestId('settings-nav-plugins')
    const worktreesNav = screen.getByTestId('settings-nav-worktrees')

    expect(integrationsCategory).toHaveTextContent('集成')
    expect(codingCategory).toHaveTextContent('编码')
    expect(archivedCategory).toHaveTextContent('已归档')
    expect(integrationsCategory.parentElement).toContainElement(pluginsNav)
    expect(
      within(integrationsCategory.parentElement!).queryByTestId('settings-nav-worktrees')
    ).toBeNull()
    expect(codingCategory.parentElement).toContainElement(worktreesNav)
    expect(within(codingCategory.parentElement!).queryByTestId('settings-nav-plugins')).toBeNull()
    expect(
      pluginsNav.compareDocumentPosition(codingCategory) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      worktreesNav.compareDocumentPosition(archivedCategory) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(worktreesNav)

    expect(window.location.pathname).toBe('/settings/worktrees')
    expect(screen.getByTestId('worktrees-settings-page')).toBeInTheDocument()
  })

  test('adds titlebar clearance for the settings back button in Tauri', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-sidebar-topbar')).toHaveClass('h-[76px]', 'pt-6', 'mb-1')
    expect(screen.getByTestId('settings-back-button')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('settings-main-titlebar-drag-region')).getByTestId(
        'macos-titlebar-drag-region'
      )
    ).toHaveAttribute('data-tauri-drag-region')
  })

  test('keeps the cloud device creation notice visible after the create request resolves', async () => {
    api.getAllDevices.mockResolvedValue([])
    api.createCloudDevice.mockResolvedValue({
      id: 1,
      device_id: 'device-1',
      name: 'yunpeng7-executor-device-1',
      status: 'offline',
      device_type: 'cloud',
      message: 'created',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-add-device-button'))
    const createDialog = screen.getByTestId('add-cloud-device-dialog')
    expect(createDialog.querySelector('.text-\\[\\#0d9488\\]')).toBeNull()
    expect(createDialog).toHaveClass('bg-popover')
    expect(screen.queryByTestId('add-cloud-device-start-command')).not.toBeInTheDocument()
    expect(screen.getByTestId('add-cloud-device-confirm')).toHaveClass(
      'bg-text-primary',
      'text-background'
    )
    await userEvent.click(screen.getByTestId('add-cloud-device-confirm'))

    await waitFor(() => expect(api.createCloudDevice).toHaveBeenCalledTimes(1))
    const creatingNotice = screen.getByText(
      '云设备创建中，初始化约需 2-3 分钟，完成后将自动出现在列表中'
    )
    expect(creatingNotice).toHaveClass('text-text-secondary')
    expect(creatingNotice).not.toHaveClass('text-primary')
  })

  test('opens appearance settings from desktop settings navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-appearance'))

    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-mode-system')).toBeInTheDocument()
  })

  test('opens about settings from desktop settings navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-about'))

    expect(screen.getByTestId('about-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('about-check-update-button')).toBeInTheDocument()
    expect(screen.getByTestId('about-link-github')).toBeInTheDocument()
    expect(screen.getByTestId('about-link-discord')).toBeInTheDocument()
  })

  test('opens model settings under personal group without manual device sync', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-category-personal')).toHaveTextContent('个人')

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))

    expect(await screen.findByTestId('model-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('model-interface-settings')).toHaveTextContent('模型接口')
    expect(
      within(screen.getByTestId('model-interface-settings')).queryByRole('heading', {
        name: '本机接口',
      })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('Codex 设置')
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('认证信息')
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('模型')
    expect(screen.getByTestId('local-codex-model-row')).toHaveTextContent('设备认证')
    expect(await screen.findByTestId('runtime-config-status')).toHaveTextContent('已配置')
    expect(screen.getByText('共享认证')).toBeInTheDocument()
    expect(screen.getByText('~/.codex/auth.json')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-config-sync-source-select')).toHaveTextContent('当前设备')
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toHaveTextContent(
      '同步到其他设备'
    )
    expect(screen.queryByTestId('runtime-config-import-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-upload-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-proxy-toggle')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-config-toggle'))

    await waitFor(() =>
      expect(userApi.updateRuntimeConfig).toHaveBeenCalledWith('codex', {
        use_user_config: true,
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-config-toggle')).toHaveAttribute('aria-checked', 'true')
    )

    expect(screen.queryByTestId('runtime-config-sync-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-sync-result')).not.toBeInTheDocument()
  })

  test('tests a model before saving it', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      expect(screen.getByTestId('local-model-request-url')).toHaveTextContent(
        '填写模型基础地址和请求路径；粘贴完整地址时会自动拆分'
      )
      const urlInput = screen.getByTestId('local-model-url-input')
      urlInput.focus()
      await userEvent.paste('http://localhost:11434/v1/responses')
      expect(screen.getByTestId('local-model-url-input')).toHaveValue('http://localhost:11434/v1')
      expect(screen.getByTestId('local-model-request-path-input')).toHaveValue('/responses')
      expect(screen.getByTestId('local-model-request-url')).toHaveTextContent(
        '请求地址：http://localhost:11434/v1/responses'
      )
      await userEvent.type(screen.getByTestId('local-model-id-input'), 'gpt-oss:20b')
      await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'local-secret')
      await userEvent.click(screen.getByTestId('local-model-test-button'))

      expect(await screen.findByTestId('local-model-test-result')).toHaveTextContent('模型连接正常')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer local-secret',
          }),
        })
      )
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('prompts before discarding an unsaved local model form', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.type(screen.getByTestId('local-model-url-input'), 'http://localhost:11434/v1')

    await userEvent.click(screen.getByTestId('local-model-add-button'))

    expect(screen.getByTestId('local-model-discard-changes-dialog')).toHaveTextContent(
      '放弃未保存的模型配置？'
    )
    expect(screen.getByTestId('local-model-url-input')).toHaveValue('http://localhost:11434/v1')

    await userEvent.click(screen.getByTestId('local-model-discard-changes-cancel-button'))

    expect(screen.queryByTestId('local-model-discard-changes-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('local-model-url-input')).toHaveValue('http://localhost:11434/v1')

    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.click(screen.getByTestId('local-model-discard-changes-confirm-button'))

    expect(screen.queryByTestId('local-model-discard-changes-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('local-model-url-input')).toHaveValue('')
  })

  test('keeps cloud auth sync controls unavailable when cloud is disconnected', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))

    expect(await screen.findByTestId('model-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('local-codex-model-row')).toHaveTextContent('设备认证')
    const cloudSyncSection = screen.getByTestId('runtime-config-cloud-sync')
    expect(cloudSyncSection).toHaveClass('bg-background')
    expect(screen.getByTestId('runtime-config-shared-auth-unavailable')).toHaveClass(
      'border-dashed'
    )
    expect(
      within(screen.getByTestId('model-interface-settings')).getByText('模型接口')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('cloud-models-section')).getByText('云端模型')
    ).toBeInTheDocument()
    expect(screen.getByTestId('cloud-models-configure-button')).toHaveTextContent('连接云端后可用')
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('Codex 设置')
    expect(screen.getByTestId('runtime-config-cloud-required')).toHaveTextContent('未连接云端')
    expect(screen.queryByTestId('runtime-config-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-proxy-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-import-device-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-import-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-upload-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-cloud-configure-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-config-sync-source-select')).toBeDisabled()
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toHaveTextContent(
      '连接云端后可用'
    )
    expect(screen.getByTestId('runtime-config-sync-auth-button')).not.toBeDisabled()
    expect(userApi.getRuntimeConfig).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('runtime-config-sync-auth-button'))

    expect(screen.getByRole('heading', { name: '云端连接' })).toBeInTheDocument()
    expect(screen.getByTestId('settings-cloud-connect-button')).toHaveTextContent('连接云端')
    expect(window.location.pathname).toBe('/settings/connections')
  })

  test('saves personal proxy from proxy settings', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))

    expect(await screen.findByTestId('proxy-settings-page')).toBeInTheDocument()
    const proxyInput = await screen.findByTestId('proxy-config-url-input')
    await userEvent.type(proxyInput, 'http://127.0.0.1:7890')
    await userEvent.click(screen.getByTestId('proxy-config-save-button'))

    await waitFor(() =>
      expect(userApi.updateProxyConfig).toHaveBeenCalledWith('http://127.0.0.1:7890')
    )
    expect(screen.getByTestId('proxy-config-local-device-section')).toHaveTextContent(
      '本地设备代理'
    )
    expect(screen.getByTestId('proxy-config-cloud-device-section')).toHaveTextContent(
      '云端设备代理'
    )
    expect(await screen.findByText('http://127.0.0.1:7890')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-proxy-toggle')).not.toBeInTheDocument()
  })

  test('distinguishes local and cloud proxy settings while cloud is disconnected', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))

    expect(await screen.findByTestId('proxy-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-config-local-device-section')).toHaveTextContent(
      '本地设备代理'
    )
    expect(screen.getByTestId('proxy-config-cloud-required')).toHaveTextContent('云端设备代理')
    await userEvent.type(
      screen.getByTestId('local-proxy-config-url-input'),
      'http://127.0.0.1:7890'
    )
    await userEvent.click(screen.getByTestId('local-proxy-config-save-button'))

    expect(requestLocalExecutor).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-proxy-config-notice')).toHaveTextContent('本地设备代理已保存')
    const restartCodexButton = screen.getByTestId('local-proxy-config-restart-codex-button')
    expect(restartCodexButton).toHaveTextContent('重启 Codex')
    await userEvent.click(restartCodexButton)
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart')
    )
    expect(screen.getByTestId('local-proxy-config-notice')).toHaveTextContent('Codex 已重启')
    expect(screen.getByTestId('proxy-config-local-device-section')).toHaveTextContent(
      'http://127.0.0.1:7890'
    )
    expect(userApi.getProxyConfig).not.toHaveBeenCalled()
    expect(userApi.updateProxyConfig).not.toHaveBeenCalled()
  })

  test('updates the local Codex remote apps setting from plugin settings', async () => {
    window.history.pushState({}, '', '/settings/plugins')
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const toggle = await screen.findByTestId('codex-plugin-remote-apps-toggle')
    expect(screen.getByTestId('settings-category-integrations')).toHaveTextContent('集成')
    expect(screen.getByTestId('settings-nav-plugins')).toHaveTextContent('插件')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(localCodexPluginApiMock.updateCodexLocalConfig).toHaveBeenCalledWith({
        remoteAppsEnabled: true,
      })
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('opens appearance settings from the browser path on reload', () => {
    api.getAllDevices.mockResolvedValue([])
    window.history.pushState({}, '', '/settings/appearance')

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-appearance')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
  })

  test('keeps uncommon cloud device actions in a compact more menu with confirmation', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.restartCloudDevice.mockResolvedValue({ message: 'restart sent' })
    api.deleteCloudDevice.mockResolvedValue({ message: 'deleted' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    expect(screen.queryByTestId('connection-restart-button-device-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-delete-button-device-1')).not.toBeInTheDocument()

    const moreButton = screen.getByTestId('connection-more-button-device-1')
    expect(moreButton).toHaveClass('h-7', 'w-7')
    expect(moreButton).toHaveAccessibleName('更多操作')

    await userEvent.click(moreButton)
    const restartMenuItem = screen.getByTestId('connection-restart-menu-item-device-1')
    const deleteMenuItem = screen.getByTestId('connection-delete-menu-item-device-1')
    expect(restartMenuItem).toHaveTextContent('重启设备')
    expect(deleteMenuItem).toHaveTextContent('删除设备')

    await userEvent.click(restartMenuItem)
    expect(api.restartCloudDevice).not.toHaveBeenCalled()
    const restartDialog = screen.getByTestId('confirm-restart-device-dialog')
    const restartConfirmButton = screen.getByTestId('confirm-restart-device-button')
    expect(restartDialog.querySelector('.text-\\[\\#0d9488\\]')).toBeNull()
    expect(restartDialog).toHaveClass('bg-popover')
    expect(restartConfirmButton).toHaveClass('bg-text-primary', 'text-background')
    await userEvent.click(restartConfirmButton)

    await userEvent.click(moreButton)
    await userEvent.click(screen.getByTestId('connection-delete-menu-item-device-1'))
    expect(api.deleteCloudDevice).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('confirm-delete-device-button'))

    expect(api.restartCloudDevice).toHaveBeenCalledWith('device-1')
    expect(api.deleteCloudDevice).toHaveBeenCalledWith('device-1')
  })

  test('shows cloud device connection info from the compact more menu and copies values', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    await userEvent.click(screen.getByTestId('connection-info-menu-item-device-1'))

    const dialog = screen.getByTestId('connection-info-dialog')
    expect(dialog).toHaveTextContent('连接信息')
    expect(dialog).toHaveTextContent('sandbox-1')
    expect(dialog).toHaveTextContent('cloud-runtime-device-1')
    expect(dialog).toHaveTextContent('ubuntu')
    expect(dialog).toHaveTextContent('initial-password-1')

    await userEvent.click(screen.getByTestId('copy-connection-info-password'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('initial-password-1')

    await userEvent.click(screen.getByTestId('copy-connection-info-all'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      [
        'Sandbox ID: sandbox-1',
        'Device ID: cloud-runtime-device-1',
        'Username: ubuntu',
        'Password: initial-password-1',
      ].join('\n')
    )
  })

  test('falls back to legacy ubuntu password field in cloud device connection info', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({
        cloud_config: {
          sandboxId: 'sandbox-legacy',
          deviceId: 'device-legacy',
          ubuntuPassword: 'legacy-password',
        },
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    await userEvent.click(screen.getByTestId('connection-info-menu-item-device-1'))

    expect(screen.getByTestId('connection-info-dialog')).toHaveTextContent('legacy-password')
  })

  test.each([
    {
      name: 'missing',
      cloudConfig: {
        sandboxId: 'sandbox-without-password',
        deviceId: 'device-without-password',
      },
    },
    {
      name: 'empty',
      cloudConfig: {
        sandboxId: 'sandbox-empty-password',
        deviceId: 'device-empty-password',
        ubuntuInitialPassword: '',
      },
    },
  ])('falls back to ubuntu when the initial password is $name', async ({ cloudConfig }) => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({
        cloud_config: cloudConfig,
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    await userEvent.click(screen.getByTestId('connection-info-menu-item-device-1'))
    await userEvent.click(screen.getByTestId('copy-connection-info-password'))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ubuntu')
  })

  test('lists local and cloud Claude Code devices while excluding unsupported shells', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({
        device_id: 'cloud-claude',
        name: 'Cloud Claude Device',
        device_type: 'cloud',
        bind_shell: 'claudecode',
      }),
      cloudDevice({
        device_id: 'cloud-openclaw',
        name: 'Cloud OpenClaw Device',
        device_type: 'cloud',
        bind_shell: 'openclaw',
      }),
      localDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByText('Cloud Claude Device')).toBeInTheDocument()
    expect(screen.getByText('Local Claude Device')).toBeInTheDocument()
    expect(screen.queryByText('Cloud OpenClaw Device')).not.toBeInTheDocument()
  })

  test('lists remote Claude Code devices in a separate section', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({ device_id: 'cloud-claude', name: 'Cloud Claude Device' }),
      remoteDevice({ device_id: 'remote-docker', name: 'Docker Remote Device' }),
      localDevice({ device_id: 'local-claude', name: 'Local Claude Device' }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByText('Cloud Claude Device')).toBeInTheDocument()
    expect(screen.getByText('Docker Remote Device')).toBeInTheDocument()
    expect(screen.getByText('Local Claude Device')).toBeInTheDocument()
    expect(screen.getByText('远程设备')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-remote-docker')).not.toBeInTheDocument()
  })

  test('groups the current app backend registration with local devices', async () => {
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'local-claude',
        name: 'Current App Backend Registration',
        device_type: 'app',
        app_device_id: 'local-claude',
        status: 'online',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-local-claude')).toBeInTheDocument()
    const localSection = screen.getByText('本地设备').closest('section')
    expect(localSection).not.toBeNull()
    expect(
      within(localSection as HTMLElement).getByText('Current App Backend Registration')
    ).toBeInTheDocument()
    expect(screen.queryByText('远程设备')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-connection-status-card')).toHaveTextContent(/在线云设备.*0/)

    await userEvent.click(await screen.findByTestId('connection-terminal-button-local-claude'))

    await waitFor(() => expect(api.openLocalTerminal).toHaveBeenCalledWith('local-claude'))
    expect(api.startTerminal).not.toHaveBeenCalled()
  })

  test('generates and copies a remote Docker device command from the add device dialog', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.createDockerRemoteDeviceCommand.mockResolvedValue({
      device_id: 'remote-device',
      name: 'Docker Remote Device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {
        DEVICE_TYPE: 'remote',
        EXECUTOR_MODE: 'local',
      },
      command:
        'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-add-device-button'))
    expect(screen.queryByTestId('remote-docker-image-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-docker-backend-url-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-docker-public-url-input')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('add-remote-docker-button'))

    await waitFor(() => expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1))
    expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledWith({
      client_origin: window.location.origin,
    })
    expect(screen.getByTestId('remote-docker-command')).toHaveTextContent('DEVICE_TYPE=remote')
    expect(screen.getByTestId('remote-docker-command')).toHaveTextContent('EXECUTOR_MODE=local')

    await userEvent.click(screen.getByTestId('copy-remote-docker-command'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest'
    )
  })

  test('disables cloud device creation when the user already has one cloud device', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.createDockerRemoteDeviceCommand.mockResolvedValue({
      device_id: 'remote-device',
      name: 'Docker Remote Device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {
        DEVICE_TYPE: 'remote',
        EXECUTOR_MODE: 'local',
      },
      command:
        'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-add-device-button'))

    expect(screen.getByTestId('add-cloud-device-confirm')).toBeDisabled()
    expect(screen.getByText(/每个用户只能创建一个云设备/)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('add-remote-docker-button'))

    expect(api.createCloudDevice).not.toHaveBeenCalled()
    await waitFor(() => expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1))
  })

  test('uses theme-aware surfaces for device cards and controls', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const deviceCard = await screen.findByTestId('connection-device-device-1')
    const terminalButton = screen.getByTestId('connection-terminal-button-device-1')
    const moreButton = screen.getByTestId('connection-more-button-device-1')

    expect(deviceCard).toHaveClass('bg-background', 'border-border')
    expect(deviceCard).not.toHaveClass('bg-white')
    expect(terminalButton).toHaveClass('bg-background', 'text-text-primary')
    expect(moreButton).toHaveClass('bg-background', 'text-text-secondary')
  })

  test('launches a native terminal for online local devices without exposing cloud-only actions', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-local-claude')).toBeInTheDocument()
    await waitFor(() => expect(getLocalExecutorDeviceIdMock).toHaveBeenCalledWith('/api'))
    expect(screen.getByText('Local Claude Device')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('connection-terminal-button-local-claude'))

    await waitFor(() => expect(api.openLocalTerminal).toHaveBeenCalledWith('local-claude'))
    expect(api.startTerminal).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId('connection-code-server-button-local-claude')
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-vnc-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-delete-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('device-metrics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-scale-wiki')).not.toBeInTheDocument()
    expect(api.getMetrics).not.toHaveBeenCalled()
  })

  test('embeds a remote terminal for socketio cloud device terminal sessions', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.startTerminal.mockResolvedValue({
      session_id: 'terminal-1',
      device_id: 'device-1',
      type: 'terminal',
      path: '/workspace',
      url: '',
      transport: 'socketio',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-terminal-button-device-1'))

    await waitFor(() => expect(api.startTerminal).toHaveBeenCalledWith('device-1'))
    expect(openSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('settings-device-terminal-panel')).toBeInTheDocument()
    expect(screen.getByTestId('settings-device-remote-terminal')).toHaveAttribute(
      'data-session-id',
      'terminal-1'
    )
  })

  test('opens URL-based terminal sessions through the external URL helper', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.startTerminal.mockResolvedValue({
      session_id: 'terminal-1',
      device_id: 'device-1',
      type: 'terminal',
      path: '/workspace',
      url: 'http://localhost/terminal',
      transport: 'http',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-terminal-button-device-1'))

    await waitFor(() => expect(api.startTerminal).toHaveBeenCalledWith('device-1'))
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/terminal')
    expect(openSpy).not.toHaveBeenCalled()
  })

  test('keeps local device terminal hidden outside the WeWork macOS app', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(false)
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-local-claude')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-terminal-button-local-claude')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('connection-code-server-button-local-claude')
    ).not.toBeInTheDocument()
  })

  test('keeps local device terminal hidden when the executor is on another device', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue('another-local-device')
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-local-claude')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByTestId('connection-terminal-button-local-claude')
      ).not.toBeInTheDocument()
    )
    expect(api.openLocalTerminal).not.toHaveBeenCalled()
  })

  test('shows configured cloud device scaling wiki link in the cloud section guidance', async () => {
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      cloudDeviceScalingWikiUrl: 'https://wiki.example.com/cloud-device-scaling',
    }
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    const link = screen.getByTestId('connection-scale-wiki-link')

    expect(link).toHaveTextContent('详细见Wiki')
    expect(link).toHaveAttribute('href', 'https://wiki.example.com/cloud-device-scaling')
    expect(link).toHaveClass('text-text-secondary', 'hover:text-primary')
    expect(link).toHaveClass('ml-2')
    expect(link.closest('p')).toHaveTextContent('持续超过 80%')
  })

  test('allows deleting offline local device registrations', async () => {
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'offline-local',
        name: 'Offline Local Device',
        status: 'offline',
      }),
    ])
    api.deleteDevice.mockResolvedValue({ message: 'deleted' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-offline-local')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-offline-local')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('connection-delete-button-offline-local'))
    expect(screen.getByTestId('confirm-delete-device-dialog')).toHaveTextContent('删除本地设备')
    expect(screen.getByTestId('confirm-delete-device-dialog')).toHaveTextContent('本地设备注册记录')
    await userEvent.click(screen.getByTestId('confirm-delete-device-button'))

    await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('offline-local'))
    expect(api.deleteCloudDevice).not.toHaveBeenCalled()
  })
})
