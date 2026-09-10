import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ComputerUseActivityIndicator } from './ComputerUseActivityIndicator'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('@/desktop/computerUse', () => ({
  getComputerUseStatus: mocks.getStatus,
  stopComputerUseCurrentAction: mocks.stop,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

const activeStatus = {
  supported: true,
  requiresPermissions: false,
  enabled: true,
  running: true,
  accessibilityPermissionGranted: true,
  screenRecordingPermissionGranted: true,
  currentTool: 'click',
  error: null,
}

describe('ComputerUseActivityIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getStatus.mockResolvedValue(activeStatus)
    mocks.stop.mockResolvedValue({ ...activeStatus, currentTool: null })
  })

  test('shows the active tool and stops it from the button', async () => {
    render(<ComputerUseActivityIndicator />)

    const indicator = await screen.findByTestId('computer-use-activity-indicator')
    const spinner = indicator.querySelector('.animate-spin')
    expect(spinner).toBeInstanceOf(HTMLSpanElement)
    expect(spinner).toHaveClass('will-change-transform')
    expect(spinner?.querySelector('svg')).not.toHaveClass('animate-spin')
    await userEvent.click(screen.getByTestId('computer-use-stop-button'))

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce())
  })

  test('stops the active tool when Escape is pressed', async () => {
    render(<ComputerUseActivityIndicator />)

    await screen.findByTestId('computer-use-activity-indicator')
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce())
  })
})
