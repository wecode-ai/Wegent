import { createDeviceApi } from '@/api/devices'
import {
  cancelLocalCodexLogin,
  listLocalCodexAccounts,
  startLocalCodexLogin,
  switchLocalCodexAccount,
} from '@/api/local/codexAuth'
import {
  deleteLocalCodexModelCatalogOverride,
  getLocalCodexModelCatalogOverrides,
  getLocalCodexOfficialModels,
  saveLocalCodexModelCatalogOverride,
} from '@/api/local/codexOfficialModels'
import { getLocalCodexAuthStatus } from '@/api/local/runtimeAuthStatus'
import { createUserApi } from '@/api/users'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import '@/i18n'
import { openExternalUrl } from '@/lib/external-links'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import type { DeviceInfo } from '@/types/devices'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'
import { ConnectionsSettingsPage } from './ConnectionsSettingsPage'

const runtimeConfigMock = vi.hoisted(() => ({
  value: {
    appBasePath: '',
    apiBaseUrl: '/api',
    socketBaseUrl: 'http://10.201.3.200:8000',
    socketPath: '/socket.io',
    cloudDeviceScalingWikiUrl: '',
  },
}))
const localCodexPluginApiMock = vi.hoisted(() => ({
  readCodexLocalConfig: vi.fn(),
  updateCodexLocalConfig: vi.fn(),
}))
const deviceSurfaceExtensionMock = vi.hoisted(() => ({
  available: true,
  DeviceAction: vi.fn(),
  supportsDevice: vi.fn((device: { device_type: string }) => device.device_type === 'cloud'),
  isInternalPageUrl: vi.fn(() => false),
  open: vi.fn(),
}))
const remoteDeviceOnboardingExtensionMock = vi.hoisted(() => ({
  Notice: vi.fn(() => null),
  CommandDetails: vi.fn(() => null),
}))
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('@extensions/device-surface', () => ({
  deviceSurfaceExtension: deviceSurfaceExtensionMock,
}))

vi.mock('@extensions/remote-device-onboarding', () => ({
  remoteDeviceOnboardingExtension: remoteDeviceOnboardingExtensionMock,
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => runtimeConfigMock.value,
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn((options: unknown) => ({ options })),
  shouldUseNativeFetch: vi.fn(() => false),
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
  getLocalCodexModelCatalogOverrides: vi.fn().mockResolvedValue([]),
  saveLocalCodexModelCatalogOverride: vi.fn().mockResolvedValue(undefined),
  deleteLocalCodexModelCatalogOverride: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn(),
}))

vi.mock('@/api/local/codexAuth', () => ({
  startLocalCodexLogin: vi.fn(),
  listLocalCodexAccounts: vi.fn(),
  switchLocalCodexAccount: vi.fn(),
  cancelLocalCodexLogin: vi.fn(),
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

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn().mockResolvedValue({
    running: true,
    ready: true,
    runtimeInstanceId: 'runtime-instance-1',
  }),
  getInitializedBundledPluginMarketplace: vi.fn().mockReturnValue(null),
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
const getLocalCodexOfficialModelsMock = vi.mocked(getLocalCodexOfficialModels)
const getLocalCodexModelCatalogOverridesMock = vi.mocked(getLocalCodexModelCatalogOverrides)
const saveLocalCodexModelCatalogOverrideMock = vi.mocked(saveLocalCodexModelCatalogOverride)
const deleteLocalCodexModelCatalogOverrideMock = vi.mocked(deleteLocalCodexModelCatalogOverride)
const getLocalCodexAuthStatusMock = vi.mocked(getLocalCodexAuthStatus)
const startLocalCodexLoginMock = vi.mocked(startLocalCodexLogin)
const listLocalCodexAccountsMock = vi.mocked(listLocalCodexAccounts)
const switchLocalCodexAccountMock = vi.mocked(switchLocalCodexAccount)
const cancelLocalCodexLoginMock = vi.mocked(cancelLocalCodexLogin)

function cloudDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'device-1',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.712',
    client_ip: '10.201.3.200',
    cloud_config: {
      sandboxId: 'sandbox-1',
      deviceId: 'cloud-runtime-device-1',
      deviceName: 'device-1',
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
    client_ip: '10.201.3.201',
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

// Compile the injected DSH modules outside the per-test hook timeout. The setup hook
// still clears and restores the module cache before every test to preserve isolation.
await preloadDefaultDshUiTestModules()

describe('ConnectionsSettingsPage', () => {
  const api = {
    getAllDevices: vi.fn(),
    getGitAccountSyncSummary: vi.fn(),
    syncGitAccounts: vi.fn(),
    startTerminal: vi.fn(),
    startCodeServer: vi.fn(),
    createCloudDevice: vi.fn(),
    createDockerRemoteDeviceCommand: vi.fn(),
    renameDevice: vi.fn(),
    restartCloudDevice: vi.fn(),
    upgradeDevice: vi.fn(),
    deleteCloudDevice: vi.fn(),
    deleteDevice: vi.fn(),
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
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

  beforeEach(async () => {
    await preloadDefaultDshUiTestModules()
    await installGitUiTestContributions()
    experimentalFeatures.enabled = true
    vi.clearAllMocks()
    getLocalCodexOfficialModelsMock.mockResolvedValue({ providers: [], models: [] })
    getLocalCodexModelCatalogOverridesMock.mockResolvedValue([])
    saveLocalCodexModelCatalogOverrideMock.mockResolvedValue(undefined)
    deleteLocalCodexModelCatalogOverrideMock.mockResolvedValue(undefined)
    getLocalCodexAuthStatusMock.mockResolvedValue({
      runtime: 'codex',
      targetPath: '/Users/me/.codex/auth.json',
      exists: true,
      updatedAt: '2026-07-01T00:00:00.000Z',
      sha256: 'abc123',
      sizeBytes: 128,
      error: null,
    })
    startLocalCodexLoginMock.mockResolvedValue({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/auth',
    })
    listLocalCodexAccountsMock.mockResolvedValue({
      activeAccountId: 'account-1',
      accounts: [
        {
          id: 'account-1',
          accountType: 'chatgpt',
          email: 'one@example.com',
          planType: 'pro',
          createdAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    switchLocalCodexAccountMock.mockResolvedValue({
      activeAccountId: 'account-2',
      accounts: [
        {
          id: 'account-1',
          accountType: 'chatgpt',
          email: 'one@example.com',
          planType: 'pro',
          createdAt: 1,
          lastUsedAt: 1,
        },
        {
          id: 'account-2',
          accountType: 'chatgpt',
          email: 'two@example.com',
          planType: 'plus',
          createdAt: 2,
          lastUsedAt: 3,
        },
      ],
    })
    cancelLocalCodexLoginMock.mockResolvedValue(undefined)
    localStorage.clear()
    delete window.weworkElectronNetwork
    delete window.__WEWORK_RUNTIME_CONFIG__
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      socketBaseUrl: 'http://10.201.3.200:8000',
      socketPath: '/socket.io',
      cloudDeviceScalingWikiUrl: '',
    }
    window.history.pushState({}, '', '/settings/connections')
    openExternalUrlMock.mockResolvedValue(true)
    deviceSurfaceExtensionMock.available = true
    deviceSurfaceExtensionMock.DeviceAction.mockImplementation(
      ({ deviceId, disabled, onOpened }) => (
        <button
          type="button"
          data-testid={`connection-device-surface-button-${deviceId}`}
          disabled={disabled}
          onClick={onOpened}
        >
          设备界面
        </button>
      )
    )
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
    localCodexPluginApiMock.readCodexLocalConfig.mockResolvedValue({
      codexHome: '/Users/crystal/.wework/codex',
      configPath: '/Users/crystal/.wework/codex/config.toml',
      remoteAppsEnabled: false,
    })
    localCodexPluginApiMock.updateCodexLocalConfig.mockImplementation(patch =>
      Promise.resolve({
        codexHome: '/Users/crystal/.wework/codex',
        configPath: '/Users/crystal/.wework/codex/config.toml',
        remoteAppsEnabled: Boolean(patch.remoteAppsEnabled),
      })
    )
    createDeviceApiMock.mockReturnValue(api)
    api.getGitAccountSyncSummary.mockResolvedValue({
      accounts: [
        {
          id: 'git-1',
          domain: 'git.example.com',
          provider: 'gitlab',
          login: 'alice',
          email: 'alice@example.com',
          effective: true,
          duplicate_of: null,
        },
      ],
      effective_count: 1,
      duplicate_count: 0,
    })
    api.syncGitAccounts.mockResolvedValue({
      device_id: 'remote-device',
      status: 'synced',
      synced_domains: ['git.example.com'],
      removed_domains: [],
      duplicate_domains: [],
      identity_warning_domains: [],
      cli: [],
      warning_codes: [],
    })
    userApi.getRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: 'auth.json',
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
      target_path: 'auth.json',
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
      target_path: 'auth.json',
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
      target_path: 'auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    createUserApiMock.mockReturnValue(userApi as ReturnType<typeof createUserApi>)
  }, 60_000)

  test('opens model settings under personal group without manual device sync', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-category-personal')).toHaveTextContent('个人')

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))

    expect(await screen.findByTestId('model-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-models-section')).toHaveTextContent('云端模型')
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('Codex 订阅')
    expect(screen.queryByTestId('local-codex-model-row')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('codex-account-details-toggle'))
    expect(await screen.findByTestId('local-codex-model-row')).toHaveTextContent('Codex 账号')
    expect(await screen.findByTestId('runtime-config-status')).toHaveTextContent('认证已保存')
    expect(screen.getByText('Codex 认证同步')).toBeInTheDocument()
    expect(
      screen.getByText('从本机或在线设备保存一份认证；开启后自动同步到同一账号下缺少认证的设备。')
    ).toBeInTheDocument()
    expect(screen.queryByText('设备 Codex Home/auth.json')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-config-sync-source-select')).toHaveTextContent('本机')
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toHaveTextContent('选择并保存')
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

  test('signs in to Codex when this computer has no reusable Codex App auth', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    listLocalCodexAccountsMock
      .mockResolvedValueOnce({
        activeAccountId: null,
        accounts: [],
      })
      .mockResolvedValue({
        activeAccountId: 'account-1',
        accounts: [
          {
            id: 'account-1',
            accountType: 'chatgpt',
            email: 'one@example.com',
            planType: 'pro',
            createdAt: 1,
            lastUsedAt: 2,
          },
        ],
      })
    getLocalCodexAuthStatusMock
      .mockResolvedValueOnce({
        runtime: 'codex',
        targetPath: '/Users/me/.wework/codex/auth.json',
        exists: false,
        updatedAt: null,
        sha256: null,
        sizeBytes: null,
        error: null,
      })
      .mockResolvedValue({
        runtime: 'codex',
        targetPath: '/Users/me/.wework/codex/auth.json',
        exists: true,
        updatedAt: '2026-09-10T00:00:00.000Z',
        sha256: 'signed-in',
        sizeBytes: 256,
        error: null,
      })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await userEvent.click(await screen.findByTestId('codex-account-details-toggle'))
    const loginButton = await screen.findByTestId('local-codex-login-button')
    expect(loginButton).toHaveTextContent('登录')
    expect(screen.getByTestId('local-codex-model-row')).toHaveTextContent(
      '登录 ChatGPT 账号以在 Wework 中使用 Codex。'
    )
    expect(screen.getByTestId('local-codex-model-row')).not.toHaveTextContent('auth.json')
    expect(screen.getByTestId('local-codex-model-row')).not.toHaveTextContent('SHA-256')

    await userEvent.click(loginButton)

    await waitFor(() => expect(startLocalCodexLoginMock).toHaveBeenCalledOnce())
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://chatgpt.com/auth', {
      target: 'system',
    })
    await waitFor(() =>
      expect(screen.getByTestId('local-codex-model-status-pill')).toHaveTextContent('已登录')
    )
    expect(listLocalCodexAccountsMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('local-codex-login-button')).toHaveTextContent('添加账号')
    expect(screen.getByTestId('local-codex-account-list')).toHaveTextContent('one@example.com')
  })

  test('cancels the Codex login session when the browser cannot be opened', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    getLocalCodexAuthStatusMock.mockResolvedValue({
      runtime: 'codex',
      targetPath: '/Users/me/.wework/codex/auth.json',
      exists: false,
      updatedAt: null,
      sha256: null,
      sizeBytes: null,
      error: null,
    })
    openExternalUrlMock.mockResolvedValue(false)

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await userEvent.click(await screen.findByTestId('codex-account-details-toggle'))
    await userEvent.click(await screen.findByTestId('local-codex-login-button'))

    await waitFor(() => expect(cancelLocalCodexLoginMock).toHaveBeenCalledWith('login-1'))
    expect(screen.getByTestId('local-codex-login-error')).toHaveTextContent(
      '无法打开 Codex 登录页面'
    )
    expect(cancelLocalCodexLoginMock).toHaveBeenCalledWith('login-1')
  })

  test('switches the active Codex auth without changing conversation sessions', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    listLocalCodexAccountsMock.mockResolvedValue({
      activeAccountId: 'account-1',
      accounts: [
        {
          id: 'account-1',
          accountType: 'chatgpt',
          email: 'one@example.com',
          planType: 'pro',
          createdAt: 1,
          lastUsedAt: 1,
        },
        {
          id: 'account-2',
          accountType: 'chatgpt',
          email: 'two@example.com',
          planType: 'plus',
          createdAt: 2,
          lastUsedAt: 2,
        },
      ],
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await userEvent.click(await screen.findByTestId('codex-account-details-toggle'))
    await userEvent.click(await screen.findByTestId('local-codex-account-switch-account-2'))

    await waitFor(() => expect(switchLocalCodexAccountMock).toHaveBeenCalledWith('account-2'))
    expect(screen.getByTestId('local-codex-account-account-2')).toHaveTextContent('当前账号')
  })

  test('imports shared auth from the selected device and explains a missing source file', async () => {
    api.getAllDevices.mockResolvedValue([
      localDevice(),
      cloudDevice({
        device_id: 'cloud-device',
        name: 'Cloud Codex Device',
      }),
    ])
    userApi.importRuntimeAuthJson.mockRejectedValueOnce(
      new Error('runtime auth file does not exist')
    )

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await userEvent.click(await screen.findByTestId('codex-account-details-toggle'))
    await screen.findByTestId('runtime-config-status')

    await userEvent.selectOptions(
      screen.getByTestId('runtime-config-sync-source-select'),
      'device:cloud-device'
    )
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toHaveTextContent('读取并保存')

    await userEvent.click(screen.getByTestId('runtime-config-sync-auth-button'))

    await waitFor(() =>
      expect(userApi.importRuntimeAuthJson).toHaveBeenCalledWith('codex', 'cloud-device')
    )
    expect(await screen.findByTestId('runtime-config-error')).toHaveTextContent(
      '所选设备没有 Codex 认证，请选择本机或其他已配置设备。'
    )
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
    expect(screen.queryByTestId('local-codex-model-row')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '云端模型' })).toBeInTheDocument()
    expect(screen.getByTestId('cloud-models-configure-button')).toHaveTextContent('去连接')
    expect(screen.queryByTestId('runtime-config-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-sync-source-select')).not.toBeInTheDocument()
    expect(userApi.getRuntimeConfig).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('codex-account-details-toggle'))
    expect(await screen.findByTestId('local-codex-model-row')).toHaveTextContent('Codex 账号')
    expect(screen.queryByTestId('runtime-config-sync-auth-button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-models-configure-button'))
    expect(screen.getByRole('heading', { name: '云端连接' })).toBeInTheDocument()
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
    await userEvent.click(screen.getByTestId('local-proxy-mode-custom'))
    await userEvent.type(
      screen.getByTestId('local-proxy-config-url-input'),
      'http://127.0.0.1:7890'
    )
    await userEvent.click(screen.getByTestId('local-proxy-config-save-button'))

    expect(requestLocalExecutor).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-proxy-config-notice')).toHaveTextContent(
      '本地设备网络设置已保存'
    )
    const restartCodexButton = screen.getByTestId('local-proxy-config-restart-codex-button')
    expect(restartCodexButton).toHaveTextContent('重启 Codex')
    await userEvent.click(restartCodexButton)
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart', {
        proxyUrl: 'http://127.0.0.1:7890',
      })
    )
    expect(screen.getByTestId('local-proxy-config-notice')).toHaveTextContent('Codex 已重启')
    expect(screen.getByTestId('local-proxy-config-status')).toHaveTextContent('自定义代理')
    expect(screen.getByTestId('local-proxy-effective-url')).toHaveTextContent(
      'http://127.0.0.1:7890（自定义代理）'
    )
    expect(userApi.getProxyConfig).not.toHaveBeenCalled()
    expect(userApi.updateProxyConfig).not.toHaveBeenCalled()
  })

  test('forces direct local Codex connections without resolving the system proxy', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    const resolveProxy = vi.fn().mockResolvedValue('http://system-proxy.example.com:7890')
    window.weworkElectronNetwork = { resolveProxy }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))
    expect(await screen.findByTestId('local-proxy-config-status')).toHaveTextContent('跟随系统')

    await userEvent.click(screen.getByTestId('local-proxy-mode-direct'))
    await userEvent.click(screen.getByTestId('local-proxy-config-save-button'))

    expect(screen.getByTestId('local-proxy-config-status')).toHaveTextContent('强制直连')
    expect(screen.getByTestId('local-proxy-effective-url')).toHaveTextContent(
      '直连（已忽略系统代理）'
    )
    const restartCodexButton = screen.getByTestId('local-proxy-config-restart-codex-button')
    await userEvent.click(restartCodexButton)

    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart', {
        proxyUrl: null,
      })
    )
    expect(resolveProxy).toHaveBeenCalledTimes(1)
  })

  test('shows the effective system proxy used by local Codex', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    window.weworkElectronNetwork = {
      resolveProxy: vi.fn().mockResolvedValue('http://system-proxy.example.com:7890'),
    }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))

    expect(await screen.findByTestId('local-proxy-config-status')).toHaveTextContent('跟随系统')
    expect(screen.getByTestId('local-proxy-effective-url')).toHaveTextContent(
      'http://system-proxy.example.com:7890（系统代理）'
    )
  })

  test('explains when system proxy rules choose a direct connection', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    window.weworkElectronNetwork = {
      resolveProxy: vi.fn().mockResolvedValue(null),
    }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))

    expect(await screen.findByTestId('local-proxy-config-status')).toHaveTextContent('跟随系统')
    expect(screen.getByTestId('local-proxy-effective-url')).toHaveTextContent(
      '直连（系统未使用代理）'
    )
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

  test('warns about active work and disables sessions while a cloud device restarts', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice({ slot_used: 1 })])
    api.restartCloudDevice.mockResolvedValue({ message: 'restart sent' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    await userEvent.click(screen.getByTestId('connection-restart-menu-item-device-1'))

    expect(screen.getByTestId('confirm-restart-device-dialog')).toHaveTextContent('当前有任务运行')
    expect(screen.getByTestId('confirm-restart-device-dialog')).toHaveTextContent(
      '终端、IDE 等设备连接不可用'
    )

    await userEvent.click(screen.getByTestId('confirm-restart-device-button'))

    const notice = await screen.findByTestId('connection-device-restart-status-device-1')
    expect(notice).toHaveTextContent('设备将短暂离线')
    expect(screen.getByTestId('connection-terminal-button-device-1')).toBeDisabled()
    expect(screen.getByTestId('connection-code-server-button-device-1')).toBeDisabled()
    expect(screen.getByTestId('connection-device-surface-button-device-1')).toBeDisabled()
    expect(screen.getByTestId('connection-more-button-device-1')).toBeDisabled()
    expect(
      within(screen.getByTestId('connection-device-device-1')).getByText('重启中')
    ).toBeVisible()
  })

  test('shows a retryable inline error without presenting the device as offline', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.restartCloudDevice.mockRejectedValue(new Error('restart rejected'))

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    await userEvent.click(screen.getByTestId('connection-restart-menu-item-device-1'))
    await userEvent.click(screen.getByTestId('confirm-restart-device-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent('restart rejected')
    expect(screen.getByTestId('connection-device-restart-retry-device-1')).toBeEnabled()
    expect(within(screen.getByTestId('connection-device-device-1')).getByText('在线')).toBeVisible()
  })

  test('upgrades an available cloud device through the restart-aligned flow', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({
        executor_version: '1.8.5',
        latest_version: '1.9.0',
        slot_used: 1,
        update_available: true,
      }),
    ])
    api.restartCloudDevice.mockResolvedValue({ message: 'restart sent' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const upgradeBadge = await screen.findByTestId('connection-upgrade-badge-device-1')
    expect(upgradeBadge).toHaveAccessibleName('当前版本：v1.8.5 · 最新版本：v1.9.0 · 点击升级')
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    expect(screen.getByTestId('connection-upgrade-menu-item-device-1')).toBeEnabled()
    await userEvent.click(screen.getByTestId('connection-more-button-device-1'))
    await userEvent.click(upgradeBadge)

    const dialog = screen.getByTestId('confirm-upgrade-device-dialog')
    expect(dialog).toHaveTextContent('当前有任务运行')
    expect(dialog).toHaveTextContent('v1.8.5')
    expect(dialog).toHaveTextContent('v1.9.0')
    expect(api.restartCloudDevice).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('confirm-upgrade-device-button'))

    expect(api.restartCloudDevice).toHaveBeenCalledWith('device-1')
    expect(api.upgradeDevice).not.toHaveBeenCalled()
    expect(
      await screen.findByTestId('connection-device-upgrade-status-device-1')
    ).toHaveTextContent('设备将短暂离线')
    expect(screen.getByTestId('connection-terminal-button-device-1')).toBeDisabled()
    expect(screen.getByTestId('connection-more-button-device-1')).toBeDisabled()
    const status = within(screen.getByTestId('connection-device-device-1')).getByTestId(
      'connection-device-status'
    )
    expect(status).toHaveTextContent('升级中')
    expect(status).toHaveClass('shrink-0', 'whitespace-nowrap')
  })

  test('passes an offline device as disabled to the device surface action', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({
        status: 'offline',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-surface-button-device-1')).toBeDisabled()
    expect(deviceSurfaceExtensionMock.DeviceAction).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', disabled: true }),
      undefined
    )
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

  test.each<DeviceInfo['status']>(['offline'])(
    'lists remote Claude Code devices with status-aware upgrade guidance: %s',
    async status => {
      api.getAllDevices.mockResolvedValue([
        cloudDevice({ device_id: 'cloud-claude', name: 'Cloud Claude Device' }),
        remoteDevice({
          device_id: 'remote-docker',
          name: 'Remote Alias',
          status,
          update_available: true,
        }),
        localDevice({ device_id: 'local-claude', name: 'Local Claude Device' }),
      ])

      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      expect(await screen.findByText('Cloud Claude Device')).toBeInTheDocument()
      expect(screen.getByText('Remote Alias')).toBeInTheDocument()
      expect(screen.queryByText('Local Claude Device')).not.toBeInTheDocument()
      expect(screen.getByText('远程设备')).toBeInTheDocument()
      expect(screen.queryByTestId('connection-more-button-remote-docker')).not.toBeInTheDocument()
      expect(screen.getByTestId('cloud-connection-device-count')).toHaveTextContent('2')
      expect(screen.getByTestId('cloud-connection-status-card')).toHaveTextContent('云端设备数量')
      const hint = screen.queryByTestId('connection-remote-upgrade-hint-remote-docker')
      if (status === 'offline') {
        expect(hint).not.toBeInTheDocument()
      } else {
        expect(hint).toHaveTextContent('重新拉取')
      }
      expect(screen.queryByTestId('connection-upgrade-badge-remote-docker')).not.toBeInTheDocument()
      expect(
        screen.queryByTestId('connection-upgrade-menu-item-remote-docker')
      ).not.toBeInTheDocument()
    }
  )

  test.each([
    ['cloud', cloudDevice(), 'device-1'],
    ['remote Docker', remoteDevice(), 'remote-device'],
  ])('opens a %s device IDE directly in the system browser', async (_label, device, deviceId) => {
    api.getAllDevices.mockResolvedValue([device])
    api.startCodeServer.mockResolvedValue({
      session_id: 'code-server-1',
      device_id: deviceId,
      type: 'code-server',
      path: '/home/wegent/.wecode/wegent-executor/workspace',
      url: 'http://10.20.30.40:17888/session/code-server-1?token=secret',
      transport: 'http',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId(`connection-code-server-button-${deviceId}`))
    await waitFor(() => {
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        'http://10.20.30.40:17888/session/code-server-1?token=secret',
        { target: 'system' }
      )
    })
    expect(screen.queryByTestId(`connection-ide-target-${deviceId}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`connection-ide-confirm-${deviceId}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`connection-ide-cancel-${deviceId}`)).not.toBeInTheDocument()
  })

  test('allows retrying after the system browser fails to open the IDE', async () => {
    api.getAllDevices.mockResolvedValue([remoteDevice()])
    api.startCodeServer.mockResolvedValue({
      session_id: 'code-server-1',
      device_id: 'remote-device',
      type: 'code-server',
      path: '/home/wegent/.wecode/wegent-executor/workspace',
      url: 'http://10.20.30.40:17888/session/code-server-1?token=secret',
      transport: 'http',
    })
    openExternalUrlMock
      .mockRejectedValueOnce(new Error('System browser unavailable'))
      .mockResolvedValueOnce(true)

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const ideButton = await screen.findByTestId('connection-code-server-button-remote-device')
    await userEvent.click(ideButton)
    expect(await screen.findByTestId('connection-session-error-remote-device')).toHaveTextContent(
      '无法使用系统默认浏览器打开 IDE，请重试'
    )

    await userEvent.click(ideButton)
    await waitFor(() => expect(openExternalUrlMock).toHaveBeenCalledTimes(2))
    expect(api.startCodeServer).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('connection-session-error-remote-device')).not.toBeInTheDocument()
  })

  test('allows deleting offline remote device registrations', async () => {
    api.getAllDevices.mockResolvedValue([
      remoteDevice({
        device_id: 'offline-remote',
        name: 'Offline Remote Device',
        status: 'offline',
      }),
    ])
    api.deleteDevice.mockResolvedValue({ message: 'deleted' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-offline-remote')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-offline-remote')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('connection-delete-button-offline-remote'))
    expect(screen.getByTestId('confirm-delete-device-dialog')).toHaveTextContent('删除远程设备')
    expect(screen.getByTestId('confirm-delete-device-dialog')).toHaveTextContent('远程设备注册记录')
    await userEvent.click(screen.getByTestId('confirm-delete-device-button'))

    await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('offline-remote'))
    expect(api.deleteCloudDevice).not.toHaveBeenCalled()
  })
})
