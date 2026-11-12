// @vitest-environment node

import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { describe, expect, it, vi } from 'vitest'
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

  it('propagates a failed read instead of creating a task with a broken round binding', async () => {
    const client = {
      subscribe: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as ProjectChatClient
    await expect(resolveHumanTaskDispatch(client, '11', 'ISSUE-1', 1)).rejects.toThrow('offline')
  })

  it('subscribes explicitly to the Group container and matches canonical zero from its snapshot', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockResolvedValue({
      snapshot: {
        currentUserId: '0',
        messages: [
          {
            metadata: {
              activity_type: 'manager_assignment',
              dispatch_id: 'dispatch',
              coordination_round_id: 'round',
              dispatch_assignments: [
                {
                  assignee_type: 'human',
                  human_user_id: 0,
                  human_assignment_id: 'human',
                  assignment_id: 'assignment',
                  task_title: 'Review result',
                  instructions: 'Verify the delivery.',
                },
              ],
            },
          },
        ],
      },
      unsubscribe,
    })
    const client = { subscribe } as unknown as ProjectChatClient
    await expect(
      resolveHumanTaskDispatch(client, 'group', 'thread', '7', 'chat_group')
    ).resolves.toEqual({
      humanAssignmentId: 'human',
      dispatchId: 'dispatch',
      roundId: 'round',
      assignmentId: 'assignment',
      taskTitle: 'Review result',
      instructions: 'Verify the delivery.',
    })
    expect(subscribe).toHaveBeenCalledExactlyOnceWith(
      'group',
      'thread',
      0,
      expect.any(Function),
      expect.any(Function),
      { containerKind: 'chat_group' }
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('releases a Group subscription even when its dispatch metadata cannot be read', async () => {
    const unsubscribe = vi.fn()
    const failure = new Error('Unreadable snapshot')
    const client = {
      subscribe: vi.fn().mockResolvedValue({
        snapshot: {
          get messages() {
            throw failure
          },
          currentUserId: '0',
        },
        unsubscribe,
      }),
    } as unknown as ProjectChatClient
    await expect(resolveHumanTaskDispatch(client, 'group', 'thread', 0, 'chat_group')).rejects.toBe(
      failure
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
