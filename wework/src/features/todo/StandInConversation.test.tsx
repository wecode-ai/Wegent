import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskComposerCreateOptions } from '@/types/workbench'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { StandInConversation } from './StandInConversation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ConversationModelControls } from '@/components/layout/workspace-panels/conversationModelControls'

const mocks = vi.hoisted(() => ({
  initialAddress: undefined as RuntimeTaskAddress | null | undefined,
  controlledAddress: undefined as RuntimeTaskAddress | null | undefined,
  hideProcessing: false,
  assistantMessageStyle: undefined as string | undefined,
  markReadWhenActive: false,
  nativeConversation: false,
  modelControls: undefined as ConversationModelControls | undefined,
  createTask: undefined as
    | undefined
    | ((message: string, options: RuntimeTaskComposerCreateOptions) => Promise<unknown>),
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: {
    createTask: typeof mocks.createTask
    initialAddress?: RuntimeTaskAddress | null
    controlledAddress?: RuntimeTaskAddress | null
    hideProcessing?: boolean
    assistantMessageStyle?: string
    markReadWhenActive?: boolean
    nativeConversation?: boolean
    modelControls?: ConversationModelControls
  }) => {
    mocks.createTask = props.createTask
    mocks.initialAddress = props.initialAddress
    mocks.controlledAddress = props.controlledAddress
    mocks.hideProcessing = props.hideProcessing ?? false
    mocks.assistantMessageStyle = props.assistantMessageStyle
    mocks.markReadWhenActive = props.markReadWhenActive ?? false
    mocks.nativeConversation = props.nativeConversation ?? false
    mocks.modelControls = props.modelControls
    return <div data-testid="conversation-pane" />
  },
}))

it('loads and creates collaboration history separately using the same assistant identity', async () => {
  const conversation = vi.fn(async () => ({
    deviceId: 'device',
    taskId: 'stand-in-chat-7-primary-collaboration',
  }))
  const readTask = vi.fn(async () => ({ success: true }))
  const api = { readTask, conversation } as unknown as StandInExecutorApi
  render(<StandInConversation api={api} userId={7} deviceId="device" scope="collaboration" />)
  await screen.findByTestId('conversation-pane')
  expect(readTask).toHaveBeenCalledWith('device', 'stand-in-chat-7-primary-collaboration')
  const message = 'Discuss collaboration'
  const options: RuntimeTaskComposerCreateOptions = {
    attachments: [],
    executionModel: {},
    optimisticUserMessage: createRuntimeUserMessage(message, []),
    onError: vi.fn(),
    onRuntimeTaskOptimisticOpen: vi.fn(),
  }
  await act(async () => {
    await mocks.createTask!(message, options)
  })
  expect(conversation).toHaveBeenCalledWith(
    7,
    'device',
    message,
    undefined,
    expect.objectContaining({ conversationScope: 'collaboration' })
  )
  expect(options.onRuntimeTaskOptimisticOpen).toHaveBeenCalledWith({
    deviceId: 'device',
    taskId: 'stand-in-chat-7-primary-collaboration',
  })
})

it('loads the model catalogs only when the mounted conversation becomes active', async () => {
  const catalog = vi.fn(async () => ({
    models: [
      {
        runtime: 'codex',
        provider: 'openai',
        model_id: 'native-sol',
        label: 'Native Sol',
        is_default: true,
      },
    ],
  }))
  const listModels = vi.fn(async () => ({ data: [] }))
  const services = {
    standInApi: { catalog },
    modelApi: { listModels },
  } as unknown as WorkbenchServices
  const api = { readTask: vi.fn(async () => ({ success: true })) } as unknown as StandInExecutorApi
  const pane = (active: boolean) => (
    <StandInConversation
      api={api}
      userId={7}
      deviceId="device"
      services={services}
      active={active}
    />
  )
  const { rerender } = render(pane(false))
  await screen.findByTestId('conversation-pane')
  expect(catalog).not.toHaveBeenCalled()
  expect(listModels).not.toHaveBeenCalled()
  rerender(pane(true))
  await waitFor(() => expect(mocks.modelControls?.loading).toBe(false))
  expect(mocks.modelControls?.unavailable).toBe(false)
  expect(mocks.modelControls?.selectedModel?.modelId).toBe('native-sol')
  expect(catalog).toHaveBeenCalledOnce()
  expect(listModels).toHaveBeenCalledOnce()
})

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
  expect(mocks.assistantMessageStyle).toBe('bubble')
  expect(mocks.markReadWhenActive).toBe(true)
  expect(mocks.nativeConversation).toBe(true)
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

it('attaches an externally created identity absent from the ordinary task inventory', async () => {
  const { WorkbenchContext } = await import('@/features/workbench/useWorkbench')
  const task = {
    taskId: 'stand-in-chat-7-primary',
    runtime: 'codex',
    workspacePath: '/im',
    threadId: 'im-thread',
  }
  const readTask = vi.fn().mockResolvedValueOnce({ task: null }).mockResolvedValue({ task })
  const api = { readTask } as unknown as StandInExecutorApi
  const provider = (items: unknown[]) => (
    <WorkbenchContext.Provider
      value={
        {
          state: { devices: [], runtimeWork: { chats: [], projects: [] } },
          runtimeTaskReminders: { items },
        } as unknown as import('@/features/workbench/workbenchContextTypes').WorkbenchContextValue
      }
    >
      <StandInConversation api={api} userId={7} deviceId="device" />
    </WorkbenchContext.Provider>
  )
  const view = render(provider([]))
  await screen.findByTestId('conversation-pane')
  expect(mocks.initialAddress).toBeNull()
  view.rerender(provider([{ address: { deviceId: 'other-device', taskId: task.taskId }, task }]))
  expect(readTask).toHaveBeenCalledTimes(1)
  view.rerender(provider([{ address: { deviceId: 'device', taskId: task.taskId }, task }]))
  await vi.waitFor(() => expect(mocks.initialAddress?.taskId).toBe(task.taskId))
  expect(readTask).toHaveBeenCalledTimes(2)
  expect(mocks.initialAddress?.workspacePath).toBe('/im')
  expect(mocks.controlledAddress?.workspacePath).toBe('/im')
})

it('keeps the mounted conversation through a background read failure and retry', async () => {
  const task = { taskId: 'stand-in-chat-7-primary', runtime: 'codex', workspacePath: '/im' }
  const initial = {
    readTask: vi.fn().mockResolvedValue({ task }),
  } as unknown as StandInExecutorApi
  const view = render(<StandInConversation api={initial} userId={7} deviceId="device" />)
  const pane = await screen.findByTestId('conversation-pane')
  const recovered = {
    readTask: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ task }),
  } as unknown as StandInExecutorApi
  view.rerender(<StandInConversation api={recovered} userId={7} deviceId="device" />)
  await screen.findByRole('alert')
  expect(screen.getByTestId('conversation-pane')).toBe(pane)
  expect(mocks.controlledAddress?.workspacePath).toBe('/im')
  fireEvent.click(screen.getByTestId('stand-in-conversation-retry'))
  await vi.waitFor(() => expect(recovered.readTask).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByTestId('conversation-pane')).toBe(pane)
})
