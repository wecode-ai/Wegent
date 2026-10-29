import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInProcessingSettings } from './StandInProcessingSettings'

function fixture(savedSilent = true) {
  return {
    value: { mode: 'silent' as const, intervalMinutes: 5 },
    onChange: vi.fn(),
    disabled: false,
    savedSilent,
    userId: 7,
    deviceId: 'remote-device',
    api: {
      processingStatus: vi.fn().mockResolvedValue({
        pendingCount: 3,
        running: false,
        actions: [],
        error: { code: 'model_unavailable', message: 'Select a model' },
      }),
      checkProcessing: vi.fn().mockResolvedValue({ pendingCount: 3, running: true, actions: [] }),
    } as unknown as StandInExecutorApi,
  }
}

it('does not check or poll until silent settings have been saved', async () => {
  const props = fixture(false)
  const user = userEvent.setup()
  render(<StandInProcessingSettings {...props} />)
  expect(screen.queryByTestId('stand-in-processing-check')).not.toBeInTheDocument()
  expect(props.api.processingStatus).not.toHaveBeenCalled()
  await user.selectOptions(screen.getByTestId('stand-in-processing-mode'), 'immediate')
  expect(props.onChange).toHaveBeenCalledWith({ mode: 'immediate', intervalMinutes: 5 })
  expect(props.api.checkProcessing).not.toHaveBeenCalled()
})

it('uses the selected device and displays model failures with an actionable check', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInProcessingSettings {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    getStandInErrorMessage({ code: 'model_unavailable' })
  )
  expect(props.api.processingStatus).toHaveBeenCalledWith(7, 'remote-device')
  await user.click(screen.getByTestId('stand-in-processing-check'))
  expect(props.api.checkProcessing).toHaveBeenCalledWith(7, 'remote-device')
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByTestId('stand-in-processing-check')).toBeDisabled()
})

it('retains the saved status and exposes an immediate-check error', async () => {
  const props = fixture()
  vi.mocked(props.api.checkProcessing).mockRejectedValue(new Error('Device disconnected'))
  const user = userEvent.setup()
  render(<StandInProcessingSettings {...props} />)
  await screen.findByRole('alert')
  await user.click(screen.getByTestId('stand-in-processing-check'))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      getStandInErrorMessage(new Error('Device disconnected'))
    )
  )
  expect(screen.getByTestId('stand-in-processing-check')).toBeEnabled()
})

it('never displays another account’s processing status while the new account loads', async () => {
  const props = fixture()
  const { rerender } = render(<StandInProcessingSettings {...props} />)
  await screen.findByRole('alert')
  vi.mocked(props.api.processingStatus).mockImplementation(() => new Promise(() => {}))
  rerender(<StandInProcessingSettings {...props} userId={8} />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(props.api.processingStatus).toHaveBeenLastCalledWith(8, 'remote-device')
})
