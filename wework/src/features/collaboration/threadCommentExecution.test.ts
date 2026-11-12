// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { executeThreadComment, threadCommentRequestsExecution } from './threadCommentExecution'
import { activityFixture } from './threadExecutionActivity.test-support'

function setup(crewId?: string) {
  const fixture = activityFixture(crewId)
  const trigger: ProjectChatMessage = {
    ...fixture.message,
    messageId: 'human-trigger',
    sender: { id: '7', name: 'Me', type: 'user' },
    metadata: { mentions: [{ type: 'agent', id: 'agent', label: 'Reviewer' }] },
    replyToMessageId: null,
  }
  vi.mocked(fixture.chat.subscribe).mockResolvedValue({
    snapshot: { currentUserId: '7', latestSequence: 2, messages: [fixture.message, trigger] },
    unsubscribe: fixture.unsubscribe,
  })
  const input = {
    context: fixture.context,
    groups: fixture.groups,
    chat: fixture.chat,
    trigger,
    unavailable: 'Unavailable',
    isCurrent: fixture.isCurrent,
  }
  return { ...fixture, trigger, input }
}

describe('Thread structured mentions reach the real chat execution port', () => {
  it('executes the saved mention in its actual group and thread without posting another message', async () => {
    const { input, chat, unsubscribe } = setup()
    await executeThreadComment(input)
    expect(chat.executeTaskComment).toHaveBeenCalledExactlyOnceWith({
      projectId: 'group',
      taskId: 'T-1',
      triggerMessageId: 'human-trigger',
    })
    expect(chat.send).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['author', 'group', 'thread'] as const)(
    'rejects a saved trigger with mismatched %s',
    async field => {
      const { input, trigger, chat } = setup()
      if (field === 'author') trigger.sender.id = '8'
      if (field === 'group') trigger.projectId = 'another-group'
      if (field === 'thread') trigger.taskId = 'another-thread'
      await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
      expect(chat.executeTaskComment).not.toHaveBeenCalled()
    }
  )

  it('denies execution after participation is revoked between persistence and admission', async () => {
    const { input, participation, chat } = setup()
    participation.joined = false
    await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
    expect(chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('cannot resume crew A through a quoted manager after reassignment to crew B', async () => {
    const { input, trigger, message, chat } = setup('B')
    trigger.replyToMessageId = message.messageId
    ;(message.metadata.collaboration_group as Record<string, unknown>).id = 'A'
    await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
    expect(chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('continues a member reply only with the current source-qualified crew proof', async () => {
    const { input, trigger, message, chat } = setup('B')
    trigger.replyToMessageId = message.messageId
    message.metadata.dispatch_role = 'member'
    message.sender.id = 'worker'
    await executeThreadComment(input)
    expect(chat.executeTaskComment).toHaveBeenCalledOnce()
  })

  it.each(['crew', 'source', 'leader'] as const)(
    'cannot resume a historical member after its %s changed',
    async field => {
      const { input, trigger, message, chat } = setup('B')
      trigger.replyToMessageId = message.messageId
      message.metadata.dispatch_role = 'member'
      message.sender.id = 'worker'
      const provenance = message.metadata.collaboration_group as Record<string, unknown>
      if (field === 'crew') provenance.id = 'A'
      if (field === 'source') provenance.binding_owner_id = 'former-project'
      if (field === 'leader') provenance.leader = { kind: 'agent', id: 'former-leader' }
      await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
      expect(chat.executeTaskComment).not.toHaveBeenCalled()
    }
  )

  it('rejects a changed crew definition while final permissions are being loaded', async () => {
    const { input, trigger, message, chat, api, item, crew } = setup('B')
    trigger.replyToMessageId = message.messageId
    vi.mocked(api.issues.get)
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce(item)
      .mockImplementation(async () => {
        crew.version += 1
        return item
      })
    await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
    expect(chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('rechecks current permission immediately before invoking execution', async () => {
    const { input, item, api, chat } = setup()
    vi.mocked(api.issues.get)
      .mockResolvedValueOnce(item)
      .mockResolvedValue({ ...item, permissions: { ...item.permissions!, execute: false } })
    await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
    expect(chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('releases the subscription when the source changes during the snapshot wait', async () => {
    const { input, chat, isCurrent, unsubscribe, trigger } = setup()
    vi.mocked(chat.subscribe).mockImplementation(async () => {
      isCurrent.mockReturnValue(false)
      return {
        unsubscribe,
        snapshot: { messages: [trigger], currentUserId: '7', latestSequence: 1 },
      }
    })
    await expect(executeThreadComment(input)).rejects.toThrow('Unavailable')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('distinguishes human discussion, shared agent replies and independent public stand-in replies', () => {
    const { trigger, message } = setup()
    expect(threadCommentRequestsExecution(trigger, [message])).toBe(true)
    trigger.metadata = {}
    expect(threadCommentRequestsExecution(trigger, [message])).toBe(false)
    trigger.replyToMessageId = message.messageId
    expect(threadCommentRequestsExecution(trigger, [message])).toBe(true)
    message.metadata = { execution_dispatch: 'comment_only', stand_in: { user_id: 7 } }
    expect(threadCommentRequestsExecution(trigger, [message])).toBe(false)
  })
})
