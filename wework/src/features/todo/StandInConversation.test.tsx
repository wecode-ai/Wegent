import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskComposerCreateOptions } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { StandInConversation } from './StandInConversation'

const mocks = vi.hoisted(() => ({
  createTask: undefined as
    | undefined
    | ((message: string, options: RuntimeTaskComposerCreateOptions) => Promise<unknown>),
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: { createTask: typeof mocks.createTask }) => {
    mocks.createTask = props.createTask
    return <div data-testid="conversation-pane" />
  },
}))

it('returns failure to the pane rollback path and permits retrying the same conversation', async () => {
  const conversation = vi
    .fn()
    .mockRejectedValueOnce(new Error('creation unavailable'))
    .mockResolvedValueOnce({ deviceId: 'device', taskId: 'stand-in-chat-7-primary' })
  const api = {
    readTask: vi.fn(async () => ({ success: true })),
    conversation,
  } as unknown as StandInExecutorApi
  render(<StandInConversation api={api} userId={7} deviceId="device" />)
  await screen.findByTestId('conversation-pane')
  const onError = vi.fn()
  const options: RuntimeTaskComposerCreateOptions = {
    attachments: [],
    executionModel: {},
    optimisticUserMessage: createRuntimeUserMessage('请继续', []),
    onError,
    onRuntimeTaskOptimisticOpen: vi.fn(),
  }
  await expect(mocks.createTask!('请继续', options)).resolves.toBe(false)
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('creation unavailable'))
  await act(async () => {
    await expect(mocks.createTask!('请继续', options)).resolves.toMatchObject({
      deviceId: 'device',
    })
  })
  expect(conversation).toHaveBeenCalledTimes(2)
})
