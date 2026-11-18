import { defaultAppPreferences } from '@/desktop/appPreferences'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { HarnessSettingsPage } from './HarnessSettingsPage'

const listLocalHarnessesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const openNativeExecutablePickerMock = vi.hoisted(() => vi.fn())
let currentAppPreferences = defaultAppPreferences

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    loaded: true,
    preferences: currentAppPreferences,
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  listLocalHarnesses: listLocalHarnessesMock,
}))

vi.mock('@/lib/native-executable-picker', () => ({
  openNativeExecutablePicker: openNativeExecutablePickerMock,
}))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    updateAppPreferences: updateAppPreferencesMock,
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('HarnessSettingsPage', () => {
  beforeEach(() => {
    currentAppPreferences = defaultAppPreferences
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
    updateAppPreferencesMock.mockImplementation(async patch => {
      currentAppPreferences = {
        ...currentAppPreferences,
        ...patch,
      }
      return currentAppPreferences
    })
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
    fireEvent.change(screen.getByTestId('harness-args-claude_code'), {
      target: { value: '--verbose\n--model\nsonnet' },
    })
    fireEvent.change(screen.getByTestId('harness-env-claude_code'), {
      target: { value: 'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-west-2' },
    })
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

  test('redetects harnesses with executable paths updated outside the settings form', async () => {
    const { rerender } = render(<HarnessSettingsPage />)

    await waitFor(() =>
      expect(listLocalHarnessesMock).toHaveBeenCalledWith({
        opencode: null,
        claude_code: null,
        kimi_code: null,
      })
    )
    listLocalHarnessesMock.mockClear()
    currentAppPreferences = {
      ...defaultAppPreferences,
      localHarnesses: defaultAppPreferences.localHarnesses.map(preference =>
        preference.id === 'claude_code'
          ? { ...preference, executablePath: '/opt/claude/bin/claude' }
          : preference
      ),
    }

    rerender(<HarnessSettingsPage />)

    await waitFor(() =>
      expect(listLocalHarnessesMock).toHaveBeenCalledWith({
        opencode: null,
        claude_code: '/opt/claude/bin/claude',
        kimi_code: null,
      })
    )
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

  test('detects a selected executable once instead of issuing duplicate reads', async () => {
    render(<HarnessSettingsPage />)
    await screen.findByText('1.2.3')
    expect(listLocalHarnessesMock).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByTestId('harness-settings-toggle-claude_code'))
    await userEvent.click(screen.getByTestId('harness-executable-select-claude_code'))
    await waitFor(() => expect(listLocalHarnessesMock).toHaveBeenCalledTimes(2))
    expect(listLocalHarnessesMock).toHaveBeenLastCalledWith({
      opencode: null,
      claude_code: '/opt/claude/bin/claude',
      kimi_code: null,
    })
  })

  test('retains a failed autosave draft and retries only from the explicit retry button', async () => {
    render(<HarnessSettingsPage />)
    await screen.findByText('1.2.3')
    fireEvent.click(screen.getByTestId('harness-settings-toggle-claude_code'))
    vi.useFakeTimers()
    updateAppPreferencesMock.mockRejectedValueOnce(new Error('Write failed'))
    fireEvent.change(screen.getByTestId('harness-args-claude_code'), {
      target: { value: '--unsaved' },
    })
    await act(async () => vi.advanceTimersByTimeAsync(400))
    expect(screen.getByTestId('harness-settings-status')).toHaveTextContent('编码工具设置保存失败')
    expect(screen.getByTestId('harness-args-claude_code')).toHaveValue('--unsaved')
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(updateAppPreferencesMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('harness-settings-retry-save'))
    await act(async () => {})
    expect(updateAppPreferencesMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('harness-settings-status')).toHaveTextContent(
      '编码工具设置已自动保存'
    )
    expect(listLocalHarnessesMock).toHaveBeenCalledTimes(1)
  })

  test('retries detection independently and does not write preferences', async () => {
    listLocalHarnessesMock.mockRejectedValueOnce(new Error('Detection unavailable'))
    render(<HarnessSettingsPage />)
    expect(await screen.findByTestId('harness-settings-detection-error')).toHaveTextContent(
      '编码工具检测失败'
    )
    expect(screen.getByTestId('harness-settings-claude_code')).not.toHaveTextContent('未检测到')
    await userEvent.click(screen.getByTestId('harness-settings-retry-detection'))
    expect(await screen.findByText('1.2.3')).toBeInTheDocument()
    expect(listLocalHarnessesMock).toHaveBeenCalledTimes(2)
    expect(updateAppPreferencesMock).not.toHaveBeenCalled()
  })

  test('keeps a detection failure visible after an independent successful save', async () => {
    listLocalHarnessesMock.mockRejectedValueOnce(new Error('Detection unavailable'))
    render(<HarnessSettingsPage />)
    await screen.findByTestId('harness-settings-detection-error')
    fireEvent.click(screen.getByTestId('harness-settings-toggle-claude_code'))
    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('harness-args-claude_code'), {
      target: { value: '--draft' },
    })
    await act(async () => vi.advanceTimersByTimeAsync(400))
    expect(screen.getByTestId('harness-settings-status')).toHaveTextContent(
      '编码工具设置已自动保存'
    )
    expect(screen.getByTestId('harness-settings-detection-error')).toBeInTheDocument()
    expect(listLocalHarnessesMock).toHaveBeenCalledTimes(1)
  })

  test('preserves drafts and the save deadline across language changes without redetecting', async () => {
    render(<HarnessSettingsPage />)
    await screen.findByText('1.2.3')
    fireEvent.click(screen.getByTestId('harness-settings-toggle-claude_code'))
    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('harness-args-claude_code'), {
      target: { value: '--draft' },
    })
    await act(async () => vi.advanceTimersByTimeAsync(200))
    const previousLanguage = i18n.language
    try {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
      expect(screen.getByTestId('harness-args-claude_code')).toHaveValue('--draft')
      expect(listLocalHarnessesMock).toHaveBeenCalledTimes(1)
      await act(async () => vi.advanceTimersByTimeAsync(200))
      expect(updateAppPreferencesMock).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('harness-settings-status')).toHaveTextContent(
        'Coding tool settings saved automatically'
      )
    } finally {
      await act(async () => {
        await i18n.changeLanguage(previousLanguage)
      })
    }
  })
})
