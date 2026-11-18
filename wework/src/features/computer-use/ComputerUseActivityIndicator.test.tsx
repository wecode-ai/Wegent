import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  test('keeps one status request in flight when the host is slow', async () => {
    vi.useFakeTimers()
    let resolve!: (value: typeof activeStatus) => void
    mocks.getStatus.mockImplementationOnce(
      () =>
        new Promise<typeof activeStatus>(accept => {
          resolve = accept
        })
    )
    const { unmount } = render(<ComputerUseActivityIndicator />)
    try {
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(mocks.getStatus).toHaveBeenCalledOnce()
      await act(async () => resolve(activeStatus))
      await act(async () => vi.advanceTimersByTimeAsync(1_000))
      expect(mocks.getStatus).toHaveBeenCalledTimes(2)
    } finally {
      unmount()
      vi.useRealTimers()
    }
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

test('does not restore a stopped action from an older in-flight status read', async () => {
  vi.useFakeTimers()
  let finish!: (value: typeof activeStatus) => void
  mocks.getStatus
    .mockReset()
    .mockResolvedValueOnce(activeStatus)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  mocks.stop.mockResolvedValue({ ...activeStatus, currentTool: null })
  const view = render(<ComputerUseActivityIndicator />)
  try {
    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(mocks.getStatus).toHaveBeenCalledTimes(2)
    await act(async () => fireEvent.click(screen.getByTestId('computer-use-stop-button')))
    expect(screen.queryByTestId('computer-use-activity-indicator')).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(mocks.getStatus).toHaveBeenCalledTimes(2)
    await act(async () => finish(activeStatus))
    expect(screen.queryByTestId('computer-use-activity-indicator')).not.toBeInTheDocument()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})
