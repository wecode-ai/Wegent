import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/tauri/appPreferences'
import './../../../src/i18n'
import { HarnessSettingsPage } from './HarnessSettingsPage'

const listLocalHarnessesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const openNativeExecutablePickerMock = vi.hoisted(() => vi.fn())

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    loaded: true,
    preferences: defaultAppPreferences,
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  listLocalHarnesses: listLocalHarnessesMock,
}))

vi.mock('@/lib/native-executable-picker', () => ({
  openNativeExecutablePicker: openNativeExecutablePickerMock,
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
    openNativeExecutablePickerMock.mockReset()
    openNativeExecutablePickerMock.mockResolvedValue('/opt/claude/bin/claude')
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
      {
        id: 'kimi_code',
        installed: true,
        executable_path: '/usr/local/bin/kimi',
        version: '1.0.0',
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
        kimi_code: null,
      })
    )
    expect(screen.getByTestId('harness-settings-opencode')).toHaveTextContent('1.2.3')
    expect(screen.getByTestId('harness-settings-claude_code')).toHaveTextContent('2.1.0')
    expect(screen.queryByTestId('harness-settings-panel-opencode')).not.toBeInTheDocument()
    expect(screen.queryByTestId('harness-settings-panel-claude_code')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('harness-settings-toggle-claude_code'))
    await userEvent.click(screen.getByTestId('harness-executable-select-claude_code'))
    expect(openNativeExecutablePickerMock).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      '选择 Claude Code 可执行文件'
    )
    expect(screen.getByTestId('harness-executable-path-claude_code')).toHaveTextContent(
      '/opt/claude/bin/claude'
    )
    await userEvent.selectOptions(screen.getByTestId('harness-permission-mode-claude_code'), 'plan')
    await userEvent.type(
      screen.getByTestId('harness-args-claude_code'),
      '--verbose\n--model\nsonnet'
    )
    await userEvent.type(
      screen.getByTestId('harness-env-claude_code'),
      'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-west-2'
    )
    await userEvent.click(screen.getByTestId('harness-enabled-opencode'))
    await waitFor(() =>
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        localHarnesses: [
          {
            id: 'opencode',
            enabled: false,
            executablePath: null,
            args: [],
            env: {},
            permissionMode: 'default',
          },
          {
            id: 'claude_code',
            enabled: true,
            executablePath: '/opt/claude/bin/claude',
            args: ['--verbose', '--model', 'sonnet'],
            env: {
              CLAUDE_CODE_USE_BEDROCK: '1',
              AWS_REGION: 'us-west-2',
            },
            permissionMode: 'plan',
          },
          {
            id: 'kimi_code',
            enabled: true,
            executablePath: null,
            args: [],
            env: {},
            permissionMode: 'default',
          },
        ],
      })
    )
    expect(screen.getByTestId('harness-settings-status')).toHaveTextContent(
      '编码工具设置已自动保存'
    )
  })

  test('does not persist malformed environment variables', async () => {
    render(<HarnessSettingsPage />)

    await screen.findByText('1.2.3')
    await userEvent.click(screen.getByTestId('harness-settings-toggle-opencode'))
    await userEvent.type(screen.getByTestId('harness-env-opencode'), 'MISSING_VALUE')
    await waitFor(() =>
      expect(screen.getByTestId('harness-settings-status')).toHaveTextContent(
        'OpenCode 的环境变量第 1 行无效'
      )
    )
    expect(updateAppPreferencesMock).not.toHaveBeenCalled()
  })

  test('shows one tool-specific settings panel at a time', async () => {
    render(<HarnessSettingsPage />)

    await screen.findByText('1.2.3')
    await userEvent.click(screen.getByTestId('harness-settings-toggle-opencode'))

    expect(screen.getByTestId('harness-settings-toggle-opencode')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('harness-settings-panel-opencode')).toBeInTheDocument()
    expect(screen.queryByTestId('harness-permission-mode-claude_code')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('harness-settings-toggle-claude_code'))

    expect(screen.getByTestId('harness-settings-toggle-opencode')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('harness-settings-panel-opencode')).not.toBeInTheDocument()
    expect(screen.getByTestId('harness-settings-panel-claude_code')).toBeInTheDocument()
    expect(screen.getByTestId('harness-permission-mode-claude_code')).toBeInTheDocument()
    expect(screen.queryByTestId('refresh-harness-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('save-harness-settings')).not.toBeInTheDocument()
  })
})
