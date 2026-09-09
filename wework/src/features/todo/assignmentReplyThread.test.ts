import { describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { assignmentReplyRootId } from './assignmentReplyThread'

function question(
  id: string,
  assignmentId: string,
  rootMessageId: string | null = null
): ProjectChatMessage {
  return {
    messageId: id,
    rootMessageId,
    sender: { type: 'system', id: 'issue_assignment', name: 'AI' },
    metadata: { issue_assignment: { id: assignmentId, status: 'waiting_human' } },
  } as ProjectChatMessage
}

describe('assignment reply discussion', () => {
  it('locates the original question instead of unrelated AI activity', () => {
    expect(
      assignmentReplyRootId(
        [question('old', 'old-assignment'), question('ask', 'current')],
        'current'
      )
    ).toBe('ask')
  })
  it('keeps a follow-up question in the same discussion', () => {
    expect(
      assignmentReplyRootId(
        [question('ask', 'first'), question('follow-up', 'second', 'ask')],
        'second'
      )
    ).toBe('ask')
  })
  it('does not redirect an expired assignment to the latest question', () => {
    expect(assignmentReplyRootId([question('ask', 'current')], 'expired')).toBeNull()
  })
})
