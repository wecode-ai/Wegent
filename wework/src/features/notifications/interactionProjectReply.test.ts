import { expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { interactionQuestion, interactionTask } from './runtimeInteractions.fixtures'
import { replyToInteractionProject } from './interactionProjectReply'
import type { Attachment } from '@/types/api'

function setup(store: 'local' | 'backend' = 'backend') {
  const item: RuntimeInteraction = {
    id: 'question',
    requestKey: 'question',
    task: interactionTask,
    payload: interactionQuestion,
    question: 'Keep old behavior?',
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
    taskApi: {},
    deviceApi: { listDevices: vi.fn().mockResolvedValue([]) },
  } as unknown as WorkbenchServices
  return { item, send, execute, subscribe, unsubscribe, services, root, run, bareSend }
}

it.each(['local', 'backend'] as const)(
  'persists question files on the owning %s Issue before continuing',
  async store => {
    const h = setup(store)
    const attachment = {
      id: store === 'local' ? -1 : 42,
      filename: 'brief.txt',
      local_path: '/tmp/brief.txt',
      status: 'ready',
    } as Attachment
    const importFiles = vi
      .fn()
      .mockResolvedValue([{ display_name: 'brief.txt', markdown_url: 'attachment://brief' }])
    h.services.projectSpaceApis = {
      defaultLocation: 'cloud',
      [store === 'local' ? 'local' : 'cloud']: { importLoopItemAttachments: importFiles },
    } as WorkbenchServices['projectSpaceApis']
    await replyToInteractionProject(h.item, 'Review this', 'reply-file', h.services, 'Failed', [
      attachment,
    ])
    expect(importFiles).toHaveBeenCalledWith('issue', [
      expect.objectContaining({ filename: 'brief.txt' }),
    ])
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Review this\n\n[brief.txt](attachment://brief)' })
    )
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIds: store === 'local' ? [] : [42] })
    )
  }
)

it('leaves the question unanswered if Issue attachment import fails', async () => {
  const h = setup('local')
  h.services.projectSpaceApis = {
    defaultLocation: 'local',
    local: { importLoopItemAttachments: vi.fn().mockRejectedValue(new Error('Import failed')) },
  } as unknown as WorkbenchServices['projectSpaceApis']
  await expect(
    replyToInteractionProject(h.item, 'Review this', 'reply-file', h.services, 'Failed', [
      { id: -1 } as Attachment,
    ])
  ).rejects.toThrow('Import failed')
  expect(h.send).not.toHaveBeenCalled()
  expect(h.execute).not.toHaveBeenCalled()
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
