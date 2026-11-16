// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient } from '@wegent/chat-core'
import { experienceMessageFixture } from '@/features/collaboration-exp/model/fixtures'
import { createProjectChatComments } from './projectChatComments'

describe('canonical project chat comments adapter', () => {
  it('preserves explicit request ids while ordinary equal-body comments remain distinct intents', async () => {
    const send = vi.fn().mockResolvedValue(experienceMessageFixture())
    const comments = createProjectChatComments(
      { send } as unknown as ProjectChatClient,
      async () => 'project-1'
    )
    await comments.create('EXP-1', 'Same text')
    await comments.create('EXP-1', 'Same text')
    expect(send.mock.calls[0][0].clientMessageId).not.toBe(send.mock.calls[1][0].clientMessageId)
    await comments.create('EXP-1', 'Same text', { clientMessageId: 'explicit-native-request' })
    await comments.create('EXP-1', 'Same text', { clientMessageId: 'explicit-native-request' })
    expect(send.mock.calls[2][0].clientMessageId).toBe('explicit-native-request')
    expect(send.mock.calls[3][0].clientMessageId).toBe('explicit-native-request')
  })

  it('keeps comment creation a plain Issue-scoped send with the edited text only', async () => {
    const message = experienceMessageFixture({ content: 'Confirmed conclusion' })
    const send = vi.fn().mockResolvedValue(message)
    const resolveProject = vi.fn().mockResolvedValue('project-1')
    const comments = createProjectChatComments(
      { send } as unknown as ProjectChatClient,
      resolveProject
    )
    expect(await comments.create('EXP-1', 'Confirmed conclusion')).toEqual({
      id: message.messageId,
      body: 'Confirmed conclusion',
      author: message.sender.name,
      web_url: null,
      created_at: message.createdAt,
      updated_at: message.updatedAt,
    })
    expect(send.mock.calls).toEqual([
      [
        {
          projectId: 'project-1',
          taskId: 'EXP-1',
          clientMessageId: expect.any(String),
          text: 'Confirmed conclusion',
        },
      ],
    ])
    expect(resolveProject).toHaveBeenCalledWith('EXP-1')
  })

  it('reads the exact canonical Issue snapshot and immediately releases the subscription', async () => {
    const unsubscribe = vi.fn()
    const message = experienceMessageFixture()
    const subscribe = vi.fn().mockResolvedValue({ snapshot: { messages: [message] }, unsubscribe })
    const comments = createProjectChatComments(
      { subscribe } as unknown as ProjectChatClient,
      async () => 'project-1'
    )
    expect(await comments.list('EXP-1')).toEqual([
      expect.objectContaining({ id: message.messageId, body: message.content }),
    ])
    expect(subscribe).toHaveBeenCalledWith('project-1', 'EXP-1', 0, expect.any(Function))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
