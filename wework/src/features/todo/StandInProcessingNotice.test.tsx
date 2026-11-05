import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInProcessingStatus } from '@/api/standIn'
import '@/i18n'
import { StandInProcessingNotice } from './StandInProcessingNotice'

function fixture(code: string | null, overrides: Partial<StandInProcessingStatus> = {}) {
  const status: StandInProcessingStatus = {
    pendingCount: 1,
    running: false,
    taskId: 'stand-in-coordinator-7',
    error: code ? { code, message: 'Internal diagnostic detail' } : null,
    actions: [],
    ...overrides,
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
  return { checkProcessing, onOpenTask, processingStatus: api.processingStatus }
}

it.each([
  { pendingCount: 19 },
  { running: true },
  {
    actions: [
      {
        id: 'previous-assessment',
        kind: 'assess',
        status: 'failed',
        createdAt: '2026-11-05T00:00:00Z',
        error: { code: 'model_unavailable', message: 'Previous failure' },
      },
    ],
  },
])('keeps ordinary background processing quiet: %j', async status => {
  const { processingStatus } = fixture(null, status)
  await waitFor(() => expect(processingStatus).toHaveBeenCalledWith(7, 'mac'))
  expect(screen.queryByTestId('stand-in-processing-notice')).toBeNull()
})

it('shows an unanswered question with its task action instead of configuration', async () => {
  const { onOpenTask } = fixture(null, { awaitingUser: true, pendingCount: 19 })
  const notice = await screen.findByTestId('stand-in-processing-notice')
  expect(notice).toHaveTextContent('需要你确认')
  expect(notice).not.toHaveTextContent('19')
  expect(screen.queryByTestId('stand-in-processing-open-settings')).toBeNull()
  await userEvent.click(screen.getByTestId('stand-in-processing-open-task'))
  expect(onOpenTask).toHaveBeenCalledWith('stand-in-coordinator-7')
})

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

it('distinguishes a background model configuration error from the conversation model', async () => {
  fixture('model_unavailable')
  expect(await screen.findByRole('alert')).toHaveTextContent('后台自动处理')
  expect(screen.getByRole('alert')).toHaveTextContent('当前对话仍可使用所选模型')
  expect(screen.getByTestId('stand-in-processing-open-settings')).toHaveTextContent('设置后台模型')
  expect(screen.getByRole('alert')).not.toHaveTextContent('Internal diagnostic detail')
})
