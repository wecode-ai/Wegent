import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskComposerCreateOptions } from '@/types/workbench'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { StandInConversation } from './StandInConversation'
import type { RuntimeTaskAddress } from '@/types/api'

const mocks = vi.hoisted(() => ({
  initialAddress: undefined as RuntimeTaskAddress | null | undefined,
  hideProcessing: false,
  crossProviderSwitchBehavior: undefined as 'new-session' | undefined,
  createTask: undefined as
    | undefined
    | ((message: string, options: RuntimeTaskComposerCreateOptions) => Promise<unknown>),
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: {
    createTask: typeof mocks.createTask
    initialAddress?: RuntimeTaskAddress | null
    hideProcessing?: boolean
    crossProviderSwitchBehavior?: 'new-session'
  }) => {
    mocks.createTask = props.createTask
    mocks.initialAddress = props.initialAddress
    mocks.hideProcessing = props.hideProcessing ?? false
    mocks.crossProviderSwitchBehavior = props.crossProviderSwitchBehavior
    return <div data-testid="conversation-pane" />
  },
}))

it('retains the persisted owner workspace when reopening the primary conversation', async () => {
  const task = {
    taskId: 'stand-in-chat-7-primary',
    runtime: 'codex',
    workspacePath: '/fixture/dots',
    workspaceKind: 'workspace',
    threadId: 'primary-thread',
    runtimeHandle: { source: 'primary' },
  }
  const api = {
    readTask: vi.fn(async () => ({ success: true, task })),
  } as unknown as StandInExecutorApi
  render(<StandInConversation api={api} userId={7} deviceId="device" />)
  await screen.findByTestId('conversation-pane')
  expect(mocks.initialAddress).toEqual({ deviceId: 'device', ...task })
  expect(mocks.hideProcessing).toBe(true)
  expect(mocks.crossProviderSwitchBehavior).toBe('new-session')
})

it('uses internal execution sessions for role conversations too', async () => {
  const api = { readTask: vi.fn(async () => ({ success: true })) } as unknown as StandInExecutorApi
  render(<StandInConversation api={api} userId={7} deviceId="device" roleId="reviewer" />)
  await screen.findByTestId('conversation-pane')
  expect(api.readTask).toHaveBeenCalledWith('device', 'stand-in-chat-7-role-reviewer')
  expect(mocks.crossProviderSwitchBehavior).toBe('new-session')
})

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
  expect(onError).toHaveBeenCalledWith('暂时无法完成此操作。请保留当前修改，重新加载后再试。')
  await act(async () => {
    await expect(mocks.createTask!('请继续', options)).resolves.toMatchObject({
      deviceId: 'device',
    })
  })
  expect(conversation).toHaveBeenCalledTimes(2)
})

it('clears a previous read failure when the executor API is replaced', async () => {
  const failed = {
    readTask: vi.fn().mockRejectedValue(new Error('network changed')),
  } as unknown as StandInExecutorApi
  const { rerender } = render(<StandInConversation api={failed} userId={7} deviceId="device" />)
  await screen.findByRole('alert')
  let resolveRead!: (value: { success: boolean }) => void
  const recovered = {
    readTask: vi.fn(() => new Promise(resolve => (resolveRead = resolve))),
  } as unknown as StandInExecutorApi
  rerender(<StandInConversation api={recovered} userId={7} deviceId="device" />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toBeInTheDocument()
  await act(async () => resolveRead({ success: true }))
  expect(await screen.findByTestId('conversation-pane')).toBeInTheDocument()
  expect(recovered.readTask).toHaveBeenCalledWith('device', 'stand-in-chat-7-primary')
})

it('ignores a late read failure from the replaced executor API', async () => {
  let rejectRead!: (error: Error) => void
  const pending = {
    readTask: vi.fn(() => new Promise((_resolve, reject) => (rejectRead = reject))),
  } as unknown as StandInExecutorApi
  const recovered = {
    readTask: vi.fn(async () => ({ success: true })),
  } as unknown as StandInExecutorApi
  const { rerender } = render(<StandInConversation api={pending} userId={7} deviceId="device" />)
  rerender(<StandInConversation api={recovered} userId={7} deviceId="device" />)
  await screen.findByTestId('conversation-pane')
  await act(async () => rejectRead(new Error('previous connection closed')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByTestId('conversation-pane')).toBeInTheDocument()
})

it('recovers an initial read failure through the existing reload action', async () => {
  const readTask = vi
    .fn()
    .mockRejectedValueOnce(new Error('network changed'))
    .mockResolvedValueOnce({ success: true })
  const api = { readTask } as unknown as StandInExecutorApi
  render(<StandInConversation api={api} userId={7} deviceId="device" />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByTestId('stand-in-conversation-retry'))
  await screen.findByTestId('conversation-pane')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(readTask).toHaveBeenCalledTimes(2)
})
