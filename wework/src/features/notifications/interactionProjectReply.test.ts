import { expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { interactionQuestion, interactionTask } from './runtimeInteractions.fixtures'
import { replyToInteractionProject } from './interactionProjectReply'

function setup(store: 'local' | 'backend' = 'backend') {
  const item: RuntimeInteraction = {
    id: 'question',
    requestKey: 'question',
    task: interactionTask,
    payload: interactionQuestion,
    question: 'Keep old behavior?',
    context: '',
    createdAt: 1,
    answered: false,
    project: { projectId: 'project', issueId: 'issue', rootCommentId: 'root', store },
  }
  const root = {
    messageId: 'root',
    metadata: {},
    sender: { type: 'user', id: '1', name: 'Me' },
  } as ProjectChatMessage
  const run = {
    ...root,
    messageId: 'run',
    rootMessageId: 'root',
    sender: { type: 'agent', id: 'review', name: 'Review' },
    runtimeAddress: interactionTask.address,
  } as ProjectChatMessage
  const send = vi.fn().mockResolvedValue({ ...root, messageId: 'persisted-reply' })
  const execute = vi.fn().mockResolvedValue([run])
  const unsubscribe = vi.fn()
  const subscribe = vi.fn().mockResolvedValue({ snapshot: { messages: [root, run] }, unsubscribe })
  const client = { send, executeTaskComment: execute, subscribe } as unknown as ProjectChatClient
  const bareSend = vi.fn()
  const services = {
    [store === 'local' ? 'localProjectChatClient' : 'projectChatClient']: client,
    runtimeWorkApi: { sendRuntimeMessage: bareSend },
    deviceApi: { listDevices: vi.fn().mockResolvedValue([]) },
  } as unknown as WorkbenchServices
  return { item, send, execute, subscribe, unsubscribe, services, root, run, bareSend }
}

it('recognizes authenticated transport aliases of the same runtime without loosening task ownership', async () => {
  const h = setup()
  h.subscribe.mockResolvedValue({
    snapshot: {
      messages: [
        h.root,
        {
          ...h.run,
          runtimeAddress: { deviceId: 'app-record-70', taskId: interactionTask.address.taskId },
        },
      ],
    },
    unsubscribe: h.unsubscribe,
  })
  vi.mocked(h.services.deviceApi.listDevices).mockResolvedValue([
    {
      id: 70,
      device_id: 'app-record-70',
      app_device_id: interactionTask.address.deviceId,
      name: 'Executor',
      status: 'online',
      device_type: 'app',
      is_default: false,
      runtime_instance_id: 'same-runtime',
    },
  ])
  await replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
  expect(h.send).toHaveBeenCalledOnce()
  expect(h.execute).toHaveBeenCalledOnce()
})

it('rejects an unknown runtime identity even when a task id is reused', async () => {
  const h = setup()
  h.subscribe.mockResolvedValue({
    snapshot: {
      messages: [
        h.root,
        {
          ...h.run,
          runtimeAddress: { deviceId: 'other-device', taskId: interactionTask.address.taskId },
        },
      ],
    },
    unsubscribe: h.unsubscribe,
  })
  await expect(
    replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
  ).rejects.toThrow('interaction_issue_owner_mismatch')
  expect(h.send).not.toHaveBeenCalled()
})

it('rejects ambiguous authenticated aliases instead of selecting an executor by guesswork', async () => {
  const h = setup()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.subscribe.mockResolvedValue({
    snapshot: {
      messages: [
        h.root,
        {
          ...h.run,
          runtimeAddress: { deviceId: 'app-record-70', taskId: interactionTask.address.taskId },
        },
      ],
    },
    unsubscribe: h.unsubscribe,
  })
  vi.mocked(h.services.deviceApi.listDevices).mockResolvedValue(
    [70, 71].map(id => ({
      id,
      device_id: `app-record-${id}`,
      app_device_id: interactionTask.address.deviceId,
      name: 'Executor',
      status: 'online' as const,
      device_type: 'app' as const,
      is_default: false,
      runtime_instance_id: `different-runtime-${id}`,
    }))
  )
  try {
    await expect(
      replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
    ).rejects.toThrow('ambiguous-executor-identity')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  } finally {
    warning.mockRestore()
  }
})

it.each(['local', 'backend'] as const)(
  'persists the reply in its original %s Issue thread before continuation',
  async store => {
    const h = setup(store)
    await replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        taskId: 'issue',
        replyToMessageId: 'root',
        clientMessageId: 'reply-once',
      })
    )
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({ triggerMessageId: 'persisted-reply' })
    )
    expect(h.send.mock.invocationCallOrder[0]).toBeLessThan(h.execute.mock.invocationCallOrder[0])
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.bareSend).not.toHaveBeenCalled()
  }
)

it('rejects an Issue thread whose current execution no longer owns the question', async () => {
  const h = setup()
  h.subscribe.mockResolvedValue({
    snapshot: {
      messages: [h.root, { ...h.run, runtimeAddress: { deviceId: 'other', taskId: 'other' } }],
    },
    unsubscribe: h.unsubscribe,
  })
  await expect(
    replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
  ).rejects.toThrow('Failed')
  expect(h.send).not.toHaveBeenCalled()
  expect(h.execute).not.toHaveBeenCalled()
  expect(h.unsubscribe).toHaveBeenCalledOnce()
})

it('preserves the idempotency key when a persisted reply needs continuation retry', async () => {
  const h = setup()
  h.execute.mockRejectedValueOnce(new Error('Execution unavailable'))
  await expect(
    replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
  ).rejects.toThrow('Execution unavailable')
  await replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
  expect(h.send.mock.calls.map(([request]) => request.clientMessageId)).toEqual([
    'reply-once',
    'reply-once',
  ])
  expect(h.execute.mock.calls.map(([request]) => request.triggerMessageId)).toEqual([
    'persisted-reply',
    'persisted-reply',
  ])
})

it('never falls back to bare runtime sending when the Issue write is denied', async () => {
  const h = setup()
  h.send.mockRejectedValue(new Error('Permission denied'))
  await expect(
    replyToInteractionProject(h.item, 'Keep old behavior', 'reply-once', h.services, 'Failed')
  ).rejects.toThrow('Permission denied')
  expect(h.execute).not.toHaveBeenCalled()
  expect(h.bareSend).not.toHaveBeenCalled()
  expect(h.unsubscribe).toHaveBeenCalledOnce()
})
