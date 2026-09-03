import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import './../../../src/i18n'
import { MobileSettingsPage } from './MobileSettingsPage'
import { AppearanceProvider } from '@/features/appearance'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { installDshUiTestContributions } from '@/test/setup'

vi.mock('@/features/model-settings/localCodexSettings', () => ({
  DEFAULT_CODEX_PERSONALITY: 'pragmatic',
  getLocalCodexPersonality: vi.fn().mockResolvedValue('pragmatic'),
  saveLocalCodexPersonality: vi.fn().mockImplementation(value => Promise.resolve(value)),
}))
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
const settingsDeviceApi = vi.hoisted(() => ({
  getAllDevices: vi.fn(),
  getGitAccountSyncSummary: vi.fn(),
  syncGitAccounts: vi.fn(),
}))

vi.mock('./settings-cloud-api', () => ({
  createSettingsDeviceApi: () => settingsDeviceApi,
  createSettingsModelApi: () => ({ listModels: vi.fn().mockResolvedValue({ data: [] }) }),
  createSettingsRemoteTerminalClientFactory: vi.fn(),
}))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

describe('MobileSettingsPage', () => {
  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.settingsPage]: [
          {
            id: 'git-hosting',
            path: '/settings/git-hosting',
            icon: 'git-pull-request',
            labelKey: 'settings_nav_git_hosting',
            label: '代码托管',
            category: 'coding',
            categoryLabel: '编码',
            module: 'plugins/wework-ui-git-settings.js',
          },
          {
            id: 'worktrees',
            path: '/settings/worktrees',
            icon: 'git-branch',
            labelKey: 'settings_nav_worktrees',
            label: '工作树',
            category: 'coding',
            categoryLabel: '编码',
            module: 'plugins/wework-ui-git-settings.js',
          },
        ],
      },
      {
        'plugins/wework-ui-git-settings.js': () => import('../../../dsh/ui-git/src/settings-page'),
      }
    )
    experimentalFeatures.enabled = true
    settingsDeviceApi.getAllDevices.mockReset()
    settingsDeviceApi.getGitAccountSyncSummary.mockReset()
    settingsDeviceApi.syncGitAccounts.mockReset()
    settingsDeviceApi.getAllDevices.mockResolvedValue([])
    settingsDeviceApi.getGitAccountSyncSummary.mockResolvedValue({
      accounts: [],
      effective_count: 0,
      duplicate_count: 0,
    })
  })

  test('renders mobile settings actions with plugins navigation', async () => {
    const onBack = vi.fn()
    const onOpenPlugins = vi.fn()

    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={onBack} onOpenPlugins={onOpenPlugins} />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-general-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-appearance-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-context-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-about-button')).not.toBeInTheDocument()
    const pluginsButton = screen.getByTestId('mobile-settings-plugins-button')
    expect(pluginsButton).toHaveTextContent('插件')
    expect(pluginsButton.querySelector('.lucide-plug')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-personal-button')).toHaveTextContent('个人')
    expect(screen.getByTestId('mobile-settings-connections-button')).toHaveTextContent('云端连接')
    expect(screen.getAllByTestId('mobile-settings-worktrees-button')).toHaveLength(1)
    expect(screen.getByTestId('mobile-settings-worktrees-button')).toHaveTextContent('工作树')
    expect(screen.getByTestId('mobile-settings-worktrees-button')).toHaveClass('min-h-[56px]')
    expect(screen.getByTestId('mobile-settings-archived-conversations-button')).toHaveTextContent(
      '已归档任务'
    )
    expect(screen.getByTestId('mobile-settings-plugins-config-button')).toHaveTextContent('插件')
    expect(screen.getByTestId('mobile-settings-harnesses-experimental-badge')).toHaveTextContent(
      '实验性'
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-general-button')).toHaveTextContent('通用')
    expect(screen.getByTestId('mobile-settings-appearance-button')).toHaveTextContent('外观')
    expect(screen.getByTestId('mobile-settings-about-button')).toHaveTextContent('关于')
    expect(screen.getByTestId('mobile-settings-context-button')).toHaveTextContent('上下文')
    expect(screen.getByTestId('mobile-settings-model-settings-button')).toHaveTextContent('模型')

    await userEvent.click(screen.getByTestId('mobile-personal-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-settings-back-button'))
    expect(onBack).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })

  test('opens cloud connection settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-connections-button'))

    expect(screen.getByTestId('mobile-connections-settings-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '云端连接' })).toBeInTheDocument()
    expect(await screen.findByTestId('git-device-sync-section')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-connections-settings-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
  })

  test('hides harness settings while experimental features are off', () => {
    experimentalFeatures.enabled = false

    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    expect(screen.queryByTestId('mobile-settings-harnesses-button')).not.toBeInTheDocument()
  })

  test('opens appearance settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-appearance-button'))

    expect(screen.getByTestId('mobile-appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-appearance-back-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
  })

  test('opens context settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-context-button'))

    expect(screen.getByTestId('mobile-context-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('context-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('codex-personality-select')).toHaveTextContent('务实')
    await userEvent.click(screen.getByTestId('codex-personality-select'))
    await userEvent.click(screen.getByTestId('codex-personality-option-friendly'))
    expect(screen.getByTestId('codex-personality-select')).toHaveTextContent('亲和')

    await userEvent.click(screen.getByTestId('mobile-context-back-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
  })

  test('opens about settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-about-button'))

    expect(screen.getByTestId('mobile-about-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('about-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('about-check-update-button')).toBeInTheDocument()
    expect(screen.getByTestId('about-link-github')).toBeInTheDocument()
    expect(screen.getByTestId('about-link-discord')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-about-back-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
  })
})
