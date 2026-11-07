import { describe, expect, it, vi } from 'vitest'
import type { IssueHumanRequest } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { issueHumanInteraction, issueQuestionIdentity } from './issueHumanInteractions'
import { canReplyToInteraction } from './runtimeInteractions'
import { replyToInteractionProject } from './interactionProjectReply'

const request: IssueHumanRequest = {
  id: 'shared-question',
  project_id: '12',
  issue_id: 'ISSUE-1',
  root_comment_id: 'root',
  runtime_device_id: 'another-members-device',
  runtime_task_id: 'private-runtime',
  item_id: 'native-question',
  question: 'Approve the business scope?',
  recipient_user_id: 7,
  recipient_name: 'Recipient',
  blocks_progress: true,
  status: 'pending',
  version: 2,
  created_at: '2026-11-07T00:00:00Z',
  updated_at: '2026-11-07T00:00:00Z',
}

describe('shared Issue handoff', () => {
  it('matches durable questions despite a native request ID or local device alias', () => {
    const canonical = issueHumanInteraction(request, 'backend')
    const native = {
      ...canonical,
      sharedRequest: undefined,
      id: 'native-request-id',
      task: { ...canonical.task, address: { ...canonical.task.address, deviceId: 'local' } },
      payload: { ...canonical.payload, requestId: 91 },
    }
    expect(issueQuestionIdentity(native)).toBe(issueQuestionIdentity(canonical))
    expect(
      issueQuestionIdentity({ ...native, payload: { ...native.payload, itemId: 'another' } })
    ).not.toBe(issueQuestionIdentity(canonical))
    expect(
      issueQuestionIdentity({ ...native, project: { ...native.project!, store: 'local' } })
    ).not.toBe(issueQuestionIdentity(canonical))
  })
  it('preserves the structured native questions and suggested answers', () => {
    const questions = [
      { id: 'native-scope', question: 'Scope?', options: [{ label: 'Internal' }], is_other: true },
    ]
    expect(issueHumanInteraction({ ...request, questions }, 'backend').payload.questions).toEqual(
      questions
    )
    expect(
      canReplyToInteraction(
        issueHumanInteraction(
          { ...request, questions: [...questions, { id: 'second', question: 'Delivery date?' }] },
          'backend'
        )
      )
    ).toBe(false)
  })
  it('does not offer replies to unassigned or already delivering questions', () => {
    expect(canReplyToInteraction(issueHumanInteraction(request, 'backend'))).toBe(true)
    expect(
      canReplyToInteraction(
        issueHumanInteraction({ ...request, recipient_user_id: null }, 'backend')
      )
    ).toBe(false)
    expect(
      canReplyToInteraction(issueHumanInteraction({ ...request, status: 'answering' }, 'backend'))
    ).toBe(false)
  })

  it('persists the answer in the original thread without reading private runtime history', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'persisted-answer' })
    const executeTaskComment = vi.fn().mockResolvedValue([])
    const getRuntimeTranscript = vi.fn()
    const subscribe = vi.fn()
    const services = {
      projectChatClient: { send, executeTaskComment, subscribe },
      runtimeWorkApi: { getRuntimeTranscript },
    } as unknown as WorkbenchServices
    await replyToInteractionProject(
      issueHumanInteraction(request, 'backend'),
      'Keep scope',
      'answer-id',
      services,
      'Failed'
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: '12',
        taskId: 'ISSUE-1',
        replyToMessageId: 'root',
        clientMessageId: 'answer-id',
      })
    )
    expect(executeTaskComment).toHaveBeenCalledWith(
      expect.objectContaining({
        humanRequestId: 'shared-question',
        triggerMessageId: 'persisted-answer',
      })
    )
    expect(getRuntimeTranscript).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('does not turn a saved comment into a successful answer when execution rejects it', async () => {
    const services = {
      projectChatClient: {
        send: vi.fn().mockResolvedValue({ messageId: 'saved' }),
        executeTaskComment: vi.fn().mockRejectedValue(new Error('Question was transferred')),
      },
    } as unknown as WorkbenchServices
    await expect(
      replyToInteractionProject(
        issueHumanInteraction(request, 'backend'),
        'Answer',
        'id',
        services,
        'Failed'
      )
    ).rejects.toThrow('Question was transferred')
  })
})
