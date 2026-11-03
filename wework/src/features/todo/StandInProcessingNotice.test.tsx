import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInProcessingStatus } from '@/api/standIn'
import '@/i18n'
import { StandInProcessingNotice } from './StandInProcessingNotice'

function fixture(code: string) {
  const status: StandInProcessingStatus = {
    pendingCount: 1,
    running: false,
    taskId: 'stand-in-coordinator-7',
    error: { code, message: 'Internal diagnostic detail' },
    actions: [],
  }
  const checkProcessing = vi.fn(async () => ({ ...status, error: null }))
  const api = {
    processingStatus: vi.fn(async () => status),
    checkProcessing,
  } as unknown as StandInExecutorApi
  const onOpenTask = vi.fn()
  render(
    <StandInProcessingNotice
      api={api}
      userId={7}
      deviceId="mac"
      onOpen={vi.fn()}
      onOpenTask={onOpenTask}
    />
  )
  return { checkProcessing, onOpenTask }
}

it('an unconfirmed execution offers its original task without authorizing a retry', async () => {
  const { checkProcessing, onOpenTask } = fixture('coordination_recovery_required')
  await userEvent.click(await screen.findByTestId('stand-in-processing-open-task'))
  expect(onOpenTask).toHaveBeenCalledWith('stand-in-coordinator-7')
  expect(screen.queryByTestId('stand-in-processing-check')).toBeNull()
  expect(checkProcessing).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).not.toContain('Internal diagnostic detail')
})

it('a terminal failure retries only after an explicit click on the native check action', async () => {
  const { checkProcessing } = fixture('coordination_stopped')
  const check = await screen.findByTestId('stand-in-processing-check')
  expect(checkProcessing).not.toHaveBeenCalled()
  await userEvent.click(check)
  await waitFor(() => expect(checkProcessing).toHaveBeenCalledWith(7, 'mac'))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
