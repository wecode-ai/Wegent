import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConnectionsSettingsPage } from './ConnectionsSettingsPage'
import { createDeviceApi } from '@/api/devices'
import {
  deleteLocalCodexModelCatalogOverride,
  getLocalCodexModelCatalogOverrides,
  getLocalCodexOfficialModels,
  saveLocalCodexModelCatalogOverride,
} from '@/api/local/codexOfficialModels'
import { createUserApi } from '@/api/users'
import { AppearanceProvider } from '@/features/appearance'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import { saveLocalModelConfig } from '@/features/model-settings/localModelSettings'
import { openExternalUrl } from '@/lib/external-links'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { preloadDefaultDshUiTestModules } from '@/test/setup'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'
import '@/i18n'
import type { DeviceInfo } from '@/types/devices'

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
const cloudDesktopExtensionMock = vi.hoisted(() => ({
  available: true,
  DeviceAction: vi.fn(),
  isInternalPageUrl: vi.fn(() => false),
  open: vi.fn(),
}))
const remoteDeviceOnboardingExtensionMock = vi.hoisted(() => ({
  Notice: vi.fn(() => null),
  CommandDetails: vi.fn(() => null),
}))
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
const appPreferencesMocks = vi.hoisted(() => ({
  update: vi.fn(),
}))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    updateAppPreferences: appPreferencesMocks.update,
  }
})

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('@extensions/cloud-desktop', () => ({
  cloudDesktopExtension: cloudDesktopExtensionMock,
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
    appPreferencesMocks.update.mockResolvedValue({
      ...defaultAppPreferences,
      remoteControlEnabled: true,
    })
    getLocalCodexOfficialModelsMock.mockResolvedValue({ providers: [], models: [] })
    getLocalCodexModelCatalogOverridesMock.mockResolvedValue([])
    saveLocalCodexModelCatalogOverrideMock.mockResolvedValue(undefined)
    deleteLocalCodexModelCatalogOverrideMock.mockResolvedValue(undefined)
    localStorage.clear()
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
    cloudDesktopExtensionMock.available = true
    cloudDesktopExtensionMock.DeviceAction.mockImplementation(
      ({ deviceId, disabled, onOpened }) => (
        <button
          type="button"
          data-testid={`connection-cloud-desktop-button-${deviceId}`}
          disabled={disabled}
          onClick={onOpened}
        >
          桌面
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
  }, 60_000)

  test('opens general settings by default', async () => {
    window.history.pushState({}, '', '/settings')
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('general-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
    const personalCategory = screen.getByTestId('settings-category-personal')
    const integrationsCategory = screen.getByTestId('settings-category-integrations')
    const codingCategory = screen.getByTestId('settings-category-coding')
    const archivedCategory = screen.getByTestId('settings-category-archived')
    const pluginsNav = screen.getByTestId('settings-nav-plugins')
    const gitHostingNav = screen.getByTestId('settings-nav-git-hosting')
    const harnessesNav = screen.getByTestId('settings-nav-harnesses')
    expect(screen.getByTestId('settings-nav-harnesses-experimental-badge')).toHaveTextContent(
      '实验性'
    )
    const worktreesNav = screen.getByTestId('settings-nav-worktrees')

    expect(personalCategory).toHaveClass('mt-2')
    expect(integrationsCategory).toHaveClass('mt-5')
    expect(integrationsCategory).toHaveTextContent('集成')
    expect(codingCategory).toHaveTextContent('编码')
    expect(archivedCategory).toHaveTextContent('已归档')
    expect(integrationsCategory.parentElement).toContainElement(pluginsNav)
    expect(
      within(integrationsCategory.parentElement!).queryByTestId('settings-nav-worktrees')
    ).toBeNull()
    expect(screen.getAllByTestId('settings-category-coding')).toHaveLength(1)
    expect(within(codingCategory.parentElement!).queryByTestId('settings-nav-plugins')).toBeNull()
    expect(
      pluginsNav.compareDocumentPosition(codingCategory) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      harnessesNav.compareDocumentPosition(gitHostingNav) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      gitHostingNav.compareDocumentPosition(worktreesNav) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      worktreesNav.compareDocumentPosition(archivedCategory) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(worktreesNav)

    expect(window.location.pathname).toBe('/settings/worktrees')
    expect(screen.getByTestId('worktrees-settings-page')).toBeInTheDocument()
  })

  test('hides harness settings and redirects direct routes while experimental features are off', async () => {
    experimentalFeatures.enabled = false
    window.history.pushState({}, '', '/settings/harnesses')
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('general-settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-harnesses')).not.toBeInTheDocument()
    expect(screen.queryByTestId('harness-settings-page')).not.toBeInTheDocument()
  })

  test('settings page fills its container instead of the full viewport', async () => {
    window.history.pushState({}, '', '/settings')
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const settingsPage = await screen.findByTestId('wework-settings-page')
    expect(settingsPage).toHaveClass('h-full')
    expect(settingsPage).not.toHaveClass('h-screen')
  })

  test('does not duplicate titlebar clearance beneath the Electron app chrome', () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-sidebar-topbar')).toHaveClass('h-[52px]', 'mb-1')
    expect(screen.getByTestId('settings-sidebar-topbar')).not.toHaveClass('h-[76px]', 'pt-6')
    expect(screen.getByTestId('settings-back-button')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-main-titlebar-drag-region')).not.toBeInTheDocument()
    expect(screen.getByTestId('wework-settings-page').querySelector('main')).toHaveClass('pt-8')
  })

  test('opens the add device dialog from the cloud work route query', async () => {
    window.history.pushState({}, '', '/settings/connections?addDevice=1')
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('add-cloud-device-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-connections')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
  })

  test('keeps the settings navigation scrollable within the sidebar', () => {
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-sidebar-topbar')).toHaveClass('shrink-0')
    expect(screen.getByTestId('settings-sidebar-nav')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
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

  test('lets the configured workbench background show through the settings shell', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    const settingsPage = screen.getByTestId('wework-settings-page')
    expect(settingsPage).toHaveClass('bg-transparent')
    expect(settingsPage.querySelector('aside')).toHaveClass('bg-background/25')
    expect(settingsPage.querySelector('aside')).not.toHaveClass('backdrop-blur-xl')
    expect(settingsPage.querySelector('main')).toHaveClass('bg-background/20')
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

  test('opens browser settings from the integrations navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const browserNav = screen.getByTestId('settings-nav-browser')
    expect(browserNav).toHaveTextContent('浏览器')
    await userEvent.click(browserNav)

    expect(await screen.findByTestId('browser-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('browser-external-link-target')).toHaveValue('system')
    expect(window.location.pathname).toBe('/settings/browser')
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

  test('edits and restores the catalog for a visible Codex model', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const model = {
      id: 'gpt-5.6-sol',
      displayName: 'GPT 5.6 Sol',
      modelId: 'gpt-5.6-sol',
      providerId: 'openai',
      providerName: 'CodeX',
      providerType: 'official' as const,
      providerCurrent: true,
      description: 'Agentic coding model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['high'],
      supportsFastMode: false,
    }
    getLocalCodexOfficialModelsMock.mockResolvedValue({
      providers: [
        {
          id: 'openai',
          displayName: 'CodeX',
          type: 'official',
          current: true,
          available: true,
          error: null,
          models: [model],
        },
      ],
      models: [model],
    })
    const baseline = createDefaultLocalModelCatalogEntry({
      id: 'official-gpt',
      displayName: 'GPT 5.6 Sol',
      toolProfile: 'custom',
      contextWindow: 272_000,
    })
    baseline.slug = 'gpt-5.6-sol'
    baseline.visibility = 'list'
    getLocalCodexModelCatalogOverridesMock
      .mockResolvedValueOnce([
        {
          slug: 'gpt-5.6-sol',
          baseline,
          effective: baseline,
          overridden: false,
        },
      ])
      .mockResolvedValue([
        {
          slug: 'gpt-5.6-sol',
          baseline,
          effective: { ...baseline, context_window: 300_000, max_context_window: 300_000 },
          overridden: true,
        },
      ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await userEvent.click(await screen.findByTestId('codex-model-provider-toggle-openai'))
    const editButton = await screen.findByTestId('codex-catalog-edit-openai-gpt-5.6-sol')
    await waitFor(() => expect(editButton).toBeEnabled())
    await userEvent.click(editButton)

    const contextWindow = screen.getByTestId('local-model-context-window-input')
    await userEvent.clear(contextWindow)
    await userEvent.type(contextWindow, '300000')
    await userEvent.click(screen.getByTestId('codex-catalog-editor-save'))

    await waitFor(() =>
      expect(saveLocalCodexModelCatalogOverrideMock).toHaveBeenCalledWith(
        'gpt-5.6-sol',
        expect.objectContaining({
          slug: 'gpt-5.6-sol',
          context_window: 300_000,
          max_context_window: 300_000,
        })
      )
    )
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart', {
      ifIdle: true,
    })

    await waitFor(() =>
      expect(screen.getByTestId('codex-catalog-restore-openai-gpt-5.6-sol')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId('codex-catalog-restore-openai-gpt-5.6-sol'))
    await waitFor(() =>
      expect(deleteLocalCodexModelCatalogOverrideMock).toHaveBeenCalledWith('gpt-5.6-sol')
    )
  })

  test('waits for a provider selection before showing model fields', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))

    expect(screen.getByTestId('local-model-provider-select')).toHaveValue('')
    expect(screen.queryByTestId('local-model-api-format-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-model-save-button')).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')

    expect(screen.getByTestId('local-model-api-format-select')).toBeInTheDocument()
    expect(screen.getByTestId('local-model-save-button')).toBeInTheDocument()
    expect(screen.queryByTestId('local-model-catalog-json-input')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('local-model-context-window-input')).toHaveLength(1)
  })

  test('offers image-capable local models as vision proxies', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const catalogEntry = createDefaultLocalModelCatalogEntry({
      id: 'vision',
      displayName: 'Vision Model',
      toolProfile: 'custom',
    })
    catalogEntry.input_modalities = ['text', 'image']
    saveLocalModelConfig({
      id: 'vision',
      providerProfileId: 'custom',
      displayName: 'Vision Model',
      modelId: 'vision-model',
      baseUrl: 'https://vision.example/v1',
      catalogEntry,
      enabled: true,
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'deepseek')

    const visionSelect = screen.getByTestId('local-model-vision-proxy-select')
    expect(visionSelect).toHaveTextContent('Vision Model')
    await userEvent.selectOptions(visionSelect, 'vision')
    expect(visionSelect).toHaveValue('vision')
  })

  test('persists custom catalog capabilities and silently restarts Codex when idle', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    vi.mocked(requestLocalExecutor).mockImplementation(async method =>
      method === 'runtime.codex.catalog.custom.write'
        ? { saved: true, modelCount: 1 }
        : { restarted: true, requiresConfirmation: false, activeTaskCount: 0 }
    )

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
    expect(
      (screen.getByTestId('local-model-base-instructions-input') as HTMLTextAreaElement).value
    ).toContain('# Working with the user')
    await userEvent.clear(screen.getByTestId('local-model-context-window-input'))
    await userEvent.type(screen.getByTestId('local-model-context-window-input'), '131072')
    await userEvent.click(screen.getByTestId('local-model-parallel-tools-select'))
    await userEvent.click(screen.getByTestId('local-model-input-modality-image'))
    await userEvent.click(screen.getByTestId('local-model-image-generation-checkbox'))
    await userEvent.click(screen.getByTestId('local-model-reasoning-level-high'))
    const defaultReasoningSelect = screen.getByTestId('local-model-default-reasoning-input')
    expect(
      within(defaultReasoningSelect).getByRole('option', {
        name: '高',
      })
    ).toHaveAttribute('value', 'high')
    expect(within(defaultReasoningSelect).queryByRole('option', { name: 'high' })).toBeNull()
    await userEvent.selectOptions(defaultReasoningSelect, 'high')
    await userEvent.click(screen.getByTestId('local-model-advanced-capabilities-toggle'))
    await userEvent.click(screen.getByTestId('local-model-advanced-section-metadata'))
    await userEvent.type(screen.getByTestId('local-model-speed-tiers-input'), 'fast')
    await userEvent.click(screen.getByTestId('local-model-speed-tiers-add'))
    await userEvent.click(screen.getByTestId('local-model-service-tiers-add'))
    await userEvent.type(screen.getByTestId('local-model-service-tiers-0-id'), 'priority')
    await userEvent.type(screen.getByTestId('local-model-service-tiers-0-name'), 'Priority')
    await userEvent.type(
      screen.getByTestId('local-model-service-tiers-0-description'),
      'Faster requests'
    )
    expect(screen.getByTestId('local-model-service-tiers-0-delete').closest('label')).toBeNull()
    await userEvent.selectOptions(
      screen.getByTestId('local-model-default-service-tier-input'),
      'priority'
    )
    await userEvent.click(screen.getByTestId('local-model-advanced-capabilities-close'))
    await userEvent.type(screen.getByTestId('local-model-id-input'), 'custom-coder')
    await userEvent.type(screen.getByTestId('local-model-url-input'), 'http://localhost:11434/v1')
    await userEvent.click(screen.getByTestId('local-model-save-button'))

    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith(
        'runtime.codex.catalog.custom.write',
        expect.objectContaining({ models: expect.any(Array) })
      )
    )
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart', {
      ifIdle: true,
    })
    const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
    expect(stored[0]).toMatchObject({
      modelId: 'custom-coder',
      codexCatalogModelId: expect.stringMatching(/^wework-custom-/),
      catalogReady: true,
      imageGenerationEnabled: true,
    })
    expect(stored[0].catalogEntry.base_instructions).toContain('# Rules for getting work done')
    expect(stored[0].catalogEntry).toMatchObject({
      context_window: 131072,
      max_context_window: 131072,
      supports_parallel_tool_calls: true,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'high', description: 'Deep reasoning' }],
      default_reasoning_level: 'high',
      service_tiers: [{ id: 'priority', name: 'Priority', description: 'Faster requests' }],
      additional_speed_tiers: ['fast'],
      default_service_tier: 'priority',
    })
  }, 15_000)

  test('keeps a custom model pending when active tasks prevent a silent restart', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    vi.mocked(requestLocalExecutor)
      .mockResolvedValueOnce({ saved: true, modelCount: 1 })
      .mockResolvedValueOnce({
        restarted: false,
        requiresConfirmation: true,
        activeTaskCount: 1,
      })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
    await userEvent.type(screen.getByTestId('local-model-id-input'), 'pending-coder')
    await userEvent.type(screen.getByTestId('local-model-url-input'), 'http://localhost:11434/v1')
    await userEvent.click(screen.getByTestId('local-model-save-button'))

    expect(await screen.findByTestId('local-model-catalog-restart-dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('local-model-catalog-restart-later-button'))
    expect(screen.getByTestId('local-model-settings')).toHaveTextContent('等待重启执行器')
    const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
    expect(stored[0].catalogReady).toBe(false)
  })

  test('uses the built-in K3 catalog profile and verified model defaults', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'k3' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
    })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(
        screen.getByTestId('local-model-provider-select'),
        'kimi-coding'
      )
      const groupInput = screen.getByTestId('local-model-group-input')
      expect(groupInput).toHaveValue('Kimi')
      await userEvent.clear(groupInput)
      await userEvent.type(groupInput, '月之暗面')
      await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'test-key')
      await userEvent.click(screen.getByTestId('local-model-load-provider-models-button'))
      await waitFor(() =>
        expect(screen.getByTestId('local-model-provider-model-select')).toHaveValue('k3')
      )
      await userEvent.click(screen.getByTestId('local-model-save-button'))

      const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
      expect(stored[0]).toMatchObject({
        providerProfileId: 'kimi-coding',
        group: '月之暗面',
        modelId: 'k3',
        contextWindow: 262_144,
        codexCatalogModelId: 'wework-kimi-k3',
        catalogReady: true,
      })
      expect(requestLocalExecutor).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('adds multiple models from the same provider in one configuration flow', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'k3' }, { id: 'kimi-for-coding-highspeed' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [{ function: { name: 'wework_capability_probe', arguments: '{}' } }],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
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
      await userEvent.selectOptions(
        screen.getByTestId('local-model-provider-select'),
        'kimi-coding'
      )
      await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'shared-key')
      await userEvent.click(screen.getByTestId('local-model-load-provider-models-button'))
      await waitFor(() =>
        expect(screen.getByTestId('local-model-provider-model-select')).toBeInTheDocument()
      )
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-model-select'), 'k3')
      await userEvent.click(screen.getByTestId('local-model-provider-model-add-button'))
      await userEvent.selectOptions(
        screen.getByTestId('local-model-provider-model-select-1'),
        'kimi-for-coding-highspeed'
      )
      await userEvent.click(screen.getByTestId('local-model-test-button-1'))
      expect(await screen.findByTestId('local-model-test-result-1')).toHaveTextContent(
        '模型连接正常'
      )
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
        model: 'kimi-for-coding-highspeed',
      })
      await userEvent.click(screen.getByTestId('local-model-save-button'))

      const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
      expect(stored).toHaveLength(2)
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerProfileId: 'kimi-coding',
            modelId: 'k3',
            apiKey: 'shared-key',
            codexCatalogModelId: 'wework-kimi-k3',
          }),
          expect.objectContaining({
            providerProfileId: 'kimi-coding',
            modelId: 'kimi-for-coding-highspeed',
            apiKey: 'shared-key',
            codexCatalogModelId: 'wework-kimi-k2-7',
          }),
        ])
      )
      expect(new Set(stored.map((model: { id: string }) => model.id)).size).toBe(2)
      expect(screen.getByTestId('local-model-settings')).toHaveTextContent('k3')
      expect(screen.getByTestId('local-model-settings')).toHaveTextContent(
        'kimi-for-coding-highspeed'
      )
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('adds another model while editing an existing provider configuration', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    saveLocalModelConfig({
      id: 'deepseek-flash',
      providerProfileId: 'deepseek',
      displayName: 'DeepSeek Flash',
      modelId: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'shared-key',
      enabled: true,
    })
    const originalFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      ),
    })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-edit-deepseek-flash'))
      await userEvent.click(screen.getByTestId('local-model-provider-model-add-button'))
      await waitFor(() =>
        expect(screen.getByTestId('local-model-provider-model-select-1')).toBeInTheDocument()
      )
      await userEvent.selectOptions(
        screen.getByTestId('local-model-provider-model-select-1'),
        'deepseek-v4-pro'
      )
      await userEvent.click(screen.getByTestId('local-model-save-button'))

      const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
      expect(stored).toHaveLength(2)
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'deepseek-flash',
            providerProfileId: 'deepseek',
            modelId: 'deepseek-v4-flash',
            apiKey: 'shared-key',
          }),
          expect.objectContaining({
            providerProfileId: 'deepseek',
            modelId: 'deepseek-v4-pro',
            apiKey: 'shared-key',
          }),
        ])
      )
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test.each([
    ['minimax', 'https://api.minimaxi.com/anthropic', 'https://api.minimaxi.com'],
    ['minimax-global', 'https://api.minimax.io/anthropic', 'https://api.minimax.io'],
  ] as const)(
    'configures %s through the managed Anthropic-compatible profile',
    async (providerProfileId, baseUrl, modelsBaseUrl) => {
      api.getAllDevices.mockResolvedValue([localDevice()])
      const originalFetch = globalThis.fetch
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'MiniMax-M2.7' }] }), {
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
        await userEvent.selectOptions(
          screen.getByTestId('local-model-provider-select'),
          providerProfileId
        )
        expect(screen.getByTestId('local-model-group-input')).toHaveValue('MiniMax')
        await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'test-key')
        await userEvent.click(screen.getByTestId('local-model-load-provider-models-button'))
        await waitFor(() =>
          expect(screen.getByTestId('local-model-provider-model-select')).toHaveValue(
            'MiniMax-M2.7'
          )
        )
        await userEvent.click(screen.getByTestId('local-model-save-button'))

        expect(fetchMock).toHaveBeenCalledWith(
          `${modelsBaseUrl}/v1/models`,
          expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } })
        )
        const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
        expect(stored[0]).toMatchObject({
          providerProfileId,
          group: 'MiniMax',
          modelId: 'MiniMax-M2.7',
          baseUrl,
          apiFormat: 'anthropic-messages',
          requestPath: '/v1/messages',
          toolProfile: 'function',
          contextWindow: 204_800,
          catalogReady: true,
        })
        expect(requestLocalExecutor).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value: originalFetch,
        })
      }
    }
  )

  test('tests a model before saving it', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_1',
          output: [
            {
              type: 'custom_tool_call',
              name: 'apply_patch',
              input:
                '*** Begin Patch\n*** Add File: wework-capability-probe.txt\n+PING\n*** End Patch\n',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
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
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
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

  test('switches the endpoint and test payload for Chat Completions models', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'wework_capability_probe', arguments: '{}' } }],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
      await userEvent.selectOptions(
        screen.getByTestId('local-model-api-format-select'),
        'openai-chat-completions'
      )
      expect(screen.getByTestId('local-model-request-path-input')).toHaveValue('/chat/completions')
      await userEvent.type(
        screen.getByTestId('local-model-url-input'),
        'https://api.kimi.com/coding/v1'
      )
      await userEvent.type(screen.getByTestId('local-model-id-input'), 'kimi-for-coding')
      await userEvent.click(screen.getByTestId('local-model-test-button'))

      expect(await screen.findByTestId('local-model-test-result')).toHaveTextContent('模型连接正常')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.kimi.com/coding/v1/chat/completions',
        expect.any(Object)
      )
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
        stream: false,
      })
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('switches the endpoint, headers, and test payload for Anthropic Messages models', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'wework_capability_probe', id: 'tool_1', input: {} }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
      await userEvent.selectOptions(
        screen.getByTestId('local-model-api-format-select'),
        'anthropic-messages'
      )
      expect(screen.getByTestId('local-model-request-path-input')).toHaveValue('/v1/messages')
      fireEvent.change(screen.getByTestId('local-model-url-input'), {
        target: { value: 'https://api.kimi.com/coding/' },
      })
      fireEvent.change(screen.getByTestId('local-model-id-input'), {
        target: { value: 'kimi-for-coding' },
      })
      fireEvent.change(screen.getByTestId('local-model-api-key-input'), {
        target: { value: 'local-secret' },
      })
      await userEvent.click(screen.getByTestId('local-model-test-button'))

      expect(await screen.findByTestId('local-model-test-result')).toHaveTextContent('模型连接正常')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.kimi.com/coding/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'local-secret',
            'anthropic-version': '2023-06-01',
          }),
        })
      )
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
        stream: false,
      })
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
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
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
    expect(screen.getByTestId('local-model-provider-select')).toHaveValue('')
    expect(screen.queryByTestId('local-model-url-input')).not.toBeInTheDocument()
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
      expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart', {
        proxyUrl: 'http://127.0.0.1:7890',
      })
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

  test('keeps connection settings open after the cloud desktop extension opens', async () => {
    const onBack = vi.fn()
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={onBack} />)

    const button = await screen.findByTestId('connection-cloud-desktop-button-device-1')
    expect(cloudDesktopExtensionMock.DeviceAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        disabled: false,
        onOpened: expect.any(Function),
      }),
      undefined
    )
    await userEvent.click(button)

    expect(onBack).not.toHaveBeenCalled()
  })

  test('does not render a cloud desktop action when the extension is unavailable', async () => {
    cloudDesktopExtensionMock.available = false
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    expect(screen.queryByTestId('connection-cloud-desktop-button-device-1')).not.toBeInTheDocument()
  })

  test('passes an offline device as disabled to the cloud desktop action', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice({ status: 'offline' })])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-cloud-desktop-button-device-1')).toBeDisabled()
    expect(cloudDesktopExtensionMock.DeviceAction).toHaveBeenCalledWith(
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

  test('lists cloud Claude Code devices while excluding local and unsupported devices', async () => {
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
    expect(screen.queryByText('Local Claude Device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-device-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByText('Cloud OpenClaw Device')).not.toBeInTheDocument()
  })

  test('lists remote Claude Code devices in a separate section', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({ device_id: 'cloud-claude', name: 'Cloud Claude Device' }),
      remoteDevice({ device_id: 'remote-docker', name: 'Remote Alias' }),
      localDevice({ device_id: 'local-claude', name: 'Local Claude Device' }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByText('Cloud Claude Device')).toBeInTheDocument()
    expect(screen.getByText('Remote Alias')).toBeInTheDocument()
    expect(screen.queryByText('Local Claude Device')).not.toBeInTheDocument()
    expect(screen.getByText('远程设备')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-remote-docker')).not.toBeInTheDocument()
  })

  test('persists the remote control switch while cloud is connected', async () => {
    api.getAllDevices.mockResolvedValue([])
    const renderPage = (remoteControlEnabled: boolean) => (
      <AppPreferencesContext.Provider
        value={{
          loaded: true,
          preferences: { ...defaultAppPreferences, remoteControlEnabled },
        }}
      >
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppPreferencesContext.Provider>
    )
    const view = render(renderPage(false))

    const toggle = await screen.findByTestId('remote-control-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toBeEnabled()

    await userEvent.click(toggle)

    await waitFor(() =>
      expect(appPreferencesMocks.update).toHaveBeenCalledWith({ remoteControlEnabled: true })
    )

    view.rerender(renderPage(true))
    expect(screen.getByTestId('remote-control-toggle')).toHaveAttribute('aria-checked', 'true')
  })

  test('keeps remote control unavailable until cloud is connected', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }

    render(
      <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
        <CloudConnectionContext.Provider value={disconnectedConnection}>
          <ConnectionsSettingsPage onBack={vi.fn()} />
        </CloudConnectionContext.Provider>
      </AppPreferencesContext.Provider>
    )

    const setting = await screen.findByTestId('remote-control-setting')
    expect(setting).toHaveTextContent('连接云端后才能开启远程控制')
    expect(screen.getByTestId('remote-control-toggle')).toBeDisabled()
    expect(appPreferencesMocks.update).not.toHaveBeenCalled()
  })

  test('reports a remote control preference save failure without changing state', async () => {
    api.getAllDevices.mockResolvedValue([])
    appPreferencesMocks.update.mockRejectedValueOnce(new Error('save failed'))

    render(
      <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppPreferencesContext.Provider>
    )

    const toggle = await screen.findByTestId('remote-control-toggle')
    await userEvent.click(toggle)

    expect(await screen.findByRole('alert')).toHaveTextContent('远程控制设置更新失败')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('shows device Git configuration after the cloud and remote device list', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({ device_id: 'cloud-claude', name: 'Cloud Claude Device' }),
      remoteDevice({ device_id: 'remote-docker', name: 'Remote Alias' }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const deviceList = await screen.findByText('Cloud Claude Device')
    const gitSyncSection = await screen.findByTestId('git-device-sync-section')
    expect(
      deviceList.compareDocumentPosition(gitSyncSection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(gitSyncSection).toHaveTextContent('gitlab · git.example.com')
    expect(screen.getByRole('option', { name: 'Remote Alias · remote' })).toBeInTheDocument()
  })

  test('does not show the current app backend registration in cloud connections', async () => {
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

    await waitFor(() => expect(api.getAllDevices).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('connection-device-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByText('Current App Backend Registration')).not.toBeInTheDocument()
    expect(screen.queryByText('本地设备')).not.toBeInTheDocument()
    expect(screen.queryByText('远程设备')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-connection-status-card')).toHaveTextContent(/在线云设备.*0/)
  })

  test('shows device IP until the user assigns an alias', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice(),
      remoteDevice(),
      cloudDevice({
        id: 4,
        device_id: 'aliased-device',
        name: 'Build Box',
        client_ip: '10.201.3.202',
      }),
      cloudDevice({
        id: 5,
        device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
        name: 'sifang-executor-0341b231eb06',
        client_ip: '10.201.3.203',
        cloud_config: {
          sandboxId: 'sandbox-generated-name',
          deviceId: 'runtime-generated-name',
          deviceName: 'sifang-executor-0341b231eb06',
        },
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByText('10.201.3.200')).toBeInTheDocument()
    expect(screen.getByText('10.201.3.201')).toBeInTheDocument()
    expect(screen.getByText('Build Box')).toBeInTheDocument()
    expect(screen.getByText('10.201.3.203')).toBeInTheDocument()
    expect(screen.queryByText('device-1')).not.toBeInTheDocument()
    expect(screen.queryByText('Docker Remote Device')).not.toBeInTheDocument()
    expect(screen.queryByText('sifang-executor-0341b231eb06')).not.toBeInTheDocument()
    expect(screen.queryByText('10.201.3.202')).not.toBeInTheDocument()
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
        WEGENT_BACKEND_URL: 'https://cloud.example.com/api',
        WEGENT_SOCKET_URL: 'wss://cloud.example.com/socket.io',
      },
      command:
        'docker run -d -p 17888:17888 -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-add-device-button'))
    expect(screen.queryByTestId('remote-docker-image-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-docker-backend-url-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-docker-public-url-input')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('add-remote-docker-button'))

    await waitFor(() => expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1))
    expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledWith()
    expect(screen.getByTestId('remote-docker-command')).toHaveTextContent('DEVICE_TYPE=remote')
    expect(screen.getByTestId('remote-docker-command')).toHaveTextContent('EXECUTOR_MODE=local')

    await userEvent.click(screen.getByTestId('copy-remote-docker-command'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'docker run -d -p 17888:17888 -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest'
    )
  })

  test('refreshes the device list and closes the dialog when the generated remote device connects', async () => {
    api.getAllDevices
      .mockResolvedValueOnce([cloudDevice()])
      .mockResolvedValue([cloudDevice(), remoteDevice()])
    api.createDockerRemoteDeviceCommand.mockResolvedValue({
      device_id: 'remote-device',
      name: 'Docker Remote Device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {
        DEVICE_TYPE: 'remote',
        EXECUTOR_MODE: 'local',
      },
      command:
        'docker run -d -p 17888:17888 -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-add-device-button'))
    await userEvent.click(screen.getByTestId('add-remote-docker-button'))

    await waitFor(() => expect(api.getAllDevices).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(screen.queryByTestId('add-cloud-device-dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('connection-device-remote-device')).toHaveTextContent('10.201.3.201')
    expect(screen.getByText('远程设备')).toBeInTheDocument()
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
        'docker run -d -p 17888:17888 -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
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

  test('shows cloud device metrics while omitting local devices and scaling guidance', async () => {
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      socketBaseUrl: 'http://10.201.3.200:8000',
      socketPath: '/socket.io',
      cloudDeviceScalingWikiUrl: 'https://wiki.example.com/cloud-device-scaling',
    }
    api.getAllDevices.mockResolvedValue([cloudDevice(), localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    expect(screen.queryByTestId('connection-device-local-device')).not.toBeInTheDocument()
    await waitFor(() => expect(api.getMetrics).toHaveBeenCalledWith('device-1'))
    await waitFor(() => {
      expect(screen.getByTestId('connection-device-metric-cpu-device-1')).toHaveTextContent('42%')
      expect(screen.getByTestId('connection-device-metric-memory-device-1')).toHaveTextContent(
        '68%'
      )
      expect(screen.getByTestId('connection-device-metric-disk-device-1')).toHaveTextContent('57%')
    })
    expect(screen.queryByTestId('connection-scale-wiki')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-scale-wiki-link')).not.toBeInTheDocument()
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

  test('shows the actual IDE target before opening a remote device session', async () => {
    api.getAllDevices.mockResolvedValue([remoteDevice()])
    api.startCodeServer.mockResolvedValue({
      session_id: 'code-server-1',
      device_id: 'remote-device',
      type: 'code-server',
      path: '/home/wegent/.wecode/wegent-executor/workspace',
      url: 'http://10.20.30.40:17888/session/code-server-1?token=secret',
      transport: 'http',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-code-server-button-remote-device'))
    const target = await screen.findByTestId('connection-ide-target-remote-device')
    expect(target).toHaveTextContent('http://10.20.30.40:17888')
    expect(target).not.toHaveTextContent('token=secret')
    expect(openExternalUrlMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('connection-ide-confirm-remote-device'))
    await waitFor(() => {
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        'http://10.20.30.40:17888/session/code-server-1?token=secret'
      )
    })
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
