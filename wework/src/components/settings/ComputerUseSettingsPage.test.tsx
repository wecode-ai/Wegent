import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
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

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getStatus.mockResolvedValue(readyStatus)
  mocks.setEnabled.mockResolvedValue({ ...readyStatus, enabled: false, running: false })
  mocks.requestPermissions.mockResolvedValue(readyStatus)
})

describe('ComputerUseSettingsPage', () => {
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

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('polls only after the preceding status request settles and stops on unmount', async () => {
  vi.useFakeTimers()
  const pending = held<typeof readyStatus>()
  mocks.getStatus.mockReturnValue(pending.promise)
  const view = render(<ComputerUseSettingsPage />)
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(mocks.getStatus).toHaveBeenCalledTimes(1)
  await act(async () => {
    pending.resolve(readyStatus)
    await pending.promise
  })
  await act(() => vi.advanceTimersByTimeAsync(1999))
  expect(mocks.getStatus).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(mocks.getStatus).toHaveBeenCalledTimes(2)
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(mocks.getStatus).toHaveBeenCalledTimes(2)
})

test('a late status read cannot overwrite the newer enable receipt and polling continues', async () => {
  vi.useFakeTimers()
  const pending = held<typeof readyStatus>()
  mocks.getStatus
    .mockResolvedValueOnce(readyStatus)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ ...readyStatus, enabled: false, running: false })
  mocks.setEnabled.mockResolvedValue({ ...readyStatus, enabled: false, running: false })
  const view = render(<ComputerUseSettingsPage />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  await act(() => vi.advanceTimersByTimeAsync(2000))
  await act(async () => {
    fireEvent.click(screen.getByTestId('computer-use-enabled-toggle'))
  })
  expect(screen.getByTestId('computer-use-enabled-toggle')).toHaveAttribute('aria-checked', 'false')
  await act(async () => {
    pending.resolve(readyStatus)
    await pending.promise
  })
  expect(screen.getByTestId('computer-use-enabled-toggle')).toHaveAttribute('aria-checked', 'false')
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(mocks.getStatus).toHaveBeenCalledTimes(3)
  view.unmount()
})

test('language changes translate the view without restarting status reads', async () => {
  vi.useFakeTimers()
  const previousLanguage = i18n.language
  const view = render(<ComputerUseSettingsPage />)
  try {
    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(mocks.getStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('computer-use-enabled-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  } finally {
    view.unmount()
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('successful polls preserve a failed save until the user retries it', async () => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.setEnabled.mockRejectedValueOnce(new Error('denied'))
  const view = render(<ComputerUseSettingsPage />)
  try {
    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-use-enabled-toggle'))
    })
    expect(screen.getByTestId('computer-use-settings-error')).toHaveTextContent(
      i18n.t('workbench.computer_use_save_failed')
    )
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(screen.getByTestId('computer-use-settings-error')).toHaveTextContent(
      i18n.t('workbench.computer_use_save_failed')
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-use-enabled-toggle'))
    })
    expect(mocks.setEnabled).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('computer-use-settings-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('computer-use-enabled-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  } finally {
    view.unmount()
    log.mockRestore()
  }
})

test('duplicate enable actions issue one host mutation and late receipts do not restart a detached poll', async () => {
  vi.useFakeTimers()
  const receipt = held<typeof readyStatus>()
  mocks.setEnabled.mockReturnValue(receipt.promise)
  const view = render(<ComputerUseSettingsPage />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  const toggle = screen.getByTestId('computer-use-enabled-toggle')
  act(() => {
    fireEvent.click(toggle)
    fireEvent.click(toggle)
  })
  expect(mocks.setEnabled).toHaveBeenCalledTimes(1)
  view.unmount()
  await act(async () => {
    receipt.resolve(readyStatus)
    await receipt.promise
  })
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(mocks.getStatus).toHaveBeenCalledTimes(1)
})

test('permission receipts supersede pending status reads', async () => {
  vi.useFakeTimers()
  const missing = { ...readyStatus, accessibilityPermissionGranted: false, running: false }
  const pending = held<typeof readyStatus>()
  mocks.getStatus.mockResolvedValueOnce(missing).mockReturnValueOnce(pending.promise)
  const view = render(<ComputerUseSettingsPage />)
  await act(() => vi.advanceTimersByTimeAsync(2000))
  await act(async () => {
    fireEvent.click(screen.getByTestId('computer-use-open-accessibility-settings-button'))
  })
  expect(mocks.requestPermissions).toHaveBeenCalledOnce()
  await act(async () => {
    pending.resolve(missing)
    await pending.promise
  })
  expect(
    screen.queryByTestId('computer-use-open-accessibility-settings-button')
  ).not.toBeInTheDocument()
  view.unmount()
})

test('failed initial reads remain unknown and the next poll can recover', async () => {
  vi.useFakeTimers()
  mocks.getStatus.mockRejectedValueOnce(new Error('host offline'))
  const view = render(<ComputerUseSettingsPage />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByTestId('computer-use-settings-error')).toHaveTextContent(
    i18n.t('workbench.computer_use_load_failed')
  )
  expect(screen.getByTestId('computer-use-enabled-toggle')).toBeDisabled()
  expect(screen.queryByText(i18n.t('workbench.computer_use_macos_only'))).not.toBeInTheDocument()
  expect(screen.queryByText(i18n.t('workbench.computer_use_state_off'))).not.toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(screen.queryByTestId('computer-use-settings-error')).not.toBeInTheDocument()
  expect(screen.getByTestId('computer-use-enabled-toggle')).toBeEnabled()
  view.unmount()
})
