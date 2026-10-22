import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { resolveHumanTaskDispatch } from './humanTaskDispatch'

describe('resolveHumanTaskDispatch', () => {
  it.each(['1', '0'])(
    'uses the manager round with the current local identity (%s)',
    async chatUserId => {
      const unsubscribe = vi.fn()
      const subscribe = vi.fn(async () => ({
        snapshot: {
          messages: [
            {
              metadata: {
                activity_type: 'manager_assignment',
                dispatch_id: 'dispatch',
                coordination_round_id: 'round',
                dispatch_assignments: [
                  {
                    assignee_type: 'human',
                    human_user_id: 1,
                    human_assignment_id: 'human-work',
                    assignment_id: 'assignment',
                    task_title: 'Check CPU',
                    instructions: 'Measure and deliver the readings.',
                  },
                ],
              },
            } as ProjectChatMessage,
          ],
          currentUserId: chatUserId,
          latestSequence: 1,
        },
        unsubscribe,
      }))
      const client = { subscribe } as unknown as ProjectChatClient
      expect(await resolveHumanTaskDispatch(client, 11, 'ISSUE-1', 1)).toEqual({
        dispatchId: 'dispatch',
        roundId: 'round',
        assignmentId: 'assignment',
        humanAssignmentId: 'human-work',
        taskTitle: 'Check CPU',
        instructions: 'Measure and deliver the readings.',
      })
      expect(subscribe).toHaveBeenCalledWith(
        '11',
        'ISSUE-1',
        0,
        expect.any(Function),
        expect.any(Function)
      )
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )

  it('does not invent a dispatch when the current user has no assignment', async () => {
    const unsubscribe = vi.fn()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], currentUserId: '1', latestSequence: 0 },
        unsubscribe,
      })),
    } as unknown as ProjectChatClient
    expect(await resolveHumanTaskDispatch(client, '11', 'ISSUE-1', 1)).toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('propagates a failed read instead of creating a task with a broken round binding', async () => {
    const client = {
      subscribe: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as ProjectChatClient
    await expect(resolveHumanTaskDispatch(client, '11', 'ISSUE-1', 1)).rejects.toThrow('offline')
  })
})
