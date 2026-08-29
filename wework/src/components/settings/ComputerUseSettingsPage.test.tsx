import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ComputerUseSettingsPage } from './ComputerUseSettingsPage'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  openScreenRecordingSettings: vi.fn(),
  requestPermissions: vi.fn(),
  setEnabled: vi.fn(),
}))

vi.mock('@/desktop/computerUse', () => ({
  getComputerUseStatus: mocks.getStatus,
  openComputerUseScreenRecordingSettings: mocks.openScreenRecordingSettings,
  requestComputerUsePermissions: mocks.requestPermissions,
  setComputerUseEnabled: mocks.setEnabled,
}))

const readyStatus = {
  supported: true,
  requiresPermissions: true,
  enabled: true,
  running: true,
  accessibilityPermissionGranted: true,
  screenRecordingPermissionGranted: true,
  currentTool: null,
  error: null,
}

describe('ComputerUseSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getStatus.mockResolvedValue(readyStatus)
    mocks.setEnabled.mockResolvedValue({ ...readyStatus, enabled: false, running: false })
    mocks.requestPermissions.mockResolvedValue(readyStatus)
  })

  test('shows ready status and disables computer use', async () => {
    render(<ComputerUseSettingsPage />)

    expect(await screen.findByText('workbench.computer_use_state_running')).toBeInTheDocument()
    const toggle = screen.getByTestId('computer-use-enabled-toggle')
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false))
  })

  test('opens permission controls when grants are missing', async () => {
    const missingPermissionsStatus = {
      ...readyStatus,
      running: false,
      accessibilityPermissionGranted: false,
      screenRecordingPermissionGranted: false,
    }
    mocks.getStatus.mockResolvedValue(missingPermissionsStatus)
    mocks.requestPermissions.mockResolvedValue(missingPermissionsStatus)
    render(<ComputerUseSettingsPage />)

    await userEvent.click(
      await screen.findByTestId('computer-use-open-accessibility-settings-button')
    )
    expect(mocks.requestPermissions).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByTestId('computer-use-open-screen-recording-settings-button'))
    expect(mocks.openScreenRecordingSettings).toHaveBeenCalledOnce()
  })
})
