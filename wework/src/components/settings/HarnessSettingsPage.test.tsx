import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/tauri/appPreferences'
import './../../../src/i18n'
import { HarnessSettingsPage } from './HarnessSettingsPage'

const listLocalHarnessesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    loaded: true,
    preferences: defaultAppPreferences,
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  listLocalHarnesses: listLocalHarnessesMock,
}))

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return {
    ...actual,
    updateAppPreferences: updateAppPreferencesMock,
  }
})

describe('HarnessSettingsPage', () => {
  beforeEach(() => {
    listLocalHarnessesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'opencode',
        installed: true,
        executable_path: '/usr/local/bin/opencode',
        version: '1.2.3',
      },
      {
        id: 'claude_code',
        installed: true,
        executable_path: '/usr/local/bin/claude',
        version: '2.1.0',
      },
    ])
    updateAppPreferencesMock.mockImplementation(async patch => ({
      ...defaultAppPreferences,
      ...patch,
    }))
  })

  test('detects and saves OpenCode and Claude Code launch settings', async () => {
    render(<HarnessSettingsPage />)

    await waitFor(() =>
      expect(listLocalHarnessesMock).toHaveBeenCalledWith({
        opencode: null,
        claude_code: null,
      })
    )
    expect(screen.getByTestId('harness-settings-opencode')).toHaveTextContent('1.2.3')
    expect(screen.getByTestId('harness-settings-claude_code')).toHaveTextContent('2.1.0')

    await userEvent.clear(screen.getByTestId('harness-executable-claude_code'))
    await userEvent.type(
      screen.getByTestId('harness-executable-claude_code'),
      '/opt/claude/bin/claude'
    )
    await userEvent.selectOptions(screen.getByTestId('harness-permission-mode-claude_code'), 'plan')
    await userEvent.type(screen.getByTestId('harness-models-claude_code'), 'sonnet\nopus')
    await userEvent.type(
      screen.getByTestId('harness-args-claude_code'),
      '--verbose\n--model\nsonnet'
    )
    await userEvent.type(
      screen.getByTestId('harness-env-claude_code'),
      'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-west-2'
    )
    await userEvent.click(screen.getByTestId('harness-enabled-opencode'))
    await userEvent.click(screen.getByTestId('save-harness-settings'))

    await waitFor(() =>
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        localHarnesses: [
          {
            id: 'opencode',
            enabled: false,
            executablePath: null,
            models: [],
            args: [],
            env: {},
            permissionMode: 'default',
          },
          {
            id: 'claude_code',
            enabled: true,
            executablePath: '/opt/claude/bin/claude',
            models: ['sonnet', 'opus'],
            args: ['--verbose', '--model', 'sonnet'],
            env: {
              CLAUDE_CODE_USE_BEDROCK: '1',
              AWS_REGION: 'us-west-2',
            },
            permissionMode: 'plan',
          },
        ],
      })
    )
    expect(screen.getByTestId('harness-settings-status')).toHaveTextContent('运行工具设置已保存')
  })

  test('does not persist malformed environment variables', async () => {
    render(<HarnessSettingsPage />)

    await screen.findByText('1.2.3')
    await userEvent.type(screen.getByTestId('harness-env-opencode'), 'MISSING_VALUE')
    await userEvent.click(screen.getByTestId('save-harness-settings'))

    expect(updateAppPreferencesMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('harness-settings-status')).toHaveTextContent(
      'OpenCode 的环境变量第 1 行无效'
    )
  })
})
