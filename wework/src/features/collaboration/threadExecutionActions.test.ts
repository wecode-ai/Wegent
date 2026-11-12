// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'

vi.mock('@/features/notifications/issueDispatch', () => ({ requestIssueDispatch: vi.fn() }))
import { requestIssueDispatch } from '@/features/notifications/issueDispatch'

import { activityFixture } from './threadExecutionActivity.test-support'

describe('Group execution authority and commands', () => {
  it('accepts using fresh server version and the group-owned issue', async () => {
    const { actions, api, onChanged } = activityFixture()
    await actions.accept()
    expect(api.issues.update).toHaveBeenCalledWith('T-1', { version: 12, status: 'completed' })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it.each(['membership', 'actor', 'groupRole', 'permission', 'ownership', 'scope'] as const)(
    'rejects revoked %s before any write',
    async reason => {
      const { actions, item, participation, group, api, isCurrent } = activityFixture()
      if (reason === 'membership') participation.joined = false
      if (reason === 'actor')
        vi.mocked(api.issues.get).mockImplementation(async () => {
          participation.current_user_id = 8
          return item
        })
      if (reason === 'groupRole') group.role = 'Viewer'
      if (reason === 'permission') item.permissions!.execute = false
      if (reason === 'ownership') item.cloud_project_id = 'another-group'
      if (reason === 'scope') isCurrent.mockReturnValue(false)
      await expect(actions.accept()).rejects.toThrow('Unavailable')
      expect(api.issues.update).not.toHaveBeenCalled()
    }
  )

  it('requires current approval authority rather than trusting the displayed creator', async () => {
    const { actions, item, api } = activityFixture()
    item.execution_state = 'waiting_approval'
    item.can_approve = false
    await expect(actions.approve()).rejects.toThrow('Unavailable')
    expect(api.issues.approveRun).not.toHaveBeenCalled()
    item.can_approve = true
    await actions.approve()
    await actions.reject('  reason  ')
    expect(api.issues.approveRun).toHaveBeenCalledWith('group', 'T-1', 12)
    expect(api.issues.rejectRun).toHaveBeenCalledWith('group', 'T-1', 12, 'reason')
  })

  it('stops the persisted execution through its actual group owner', async () => {
    const { actions, api, message } = activityFixture()
    await actions.stop(message)
    expect(api.executions!.stop).toHaveBeenCalledWith('group', 15)
    expect(api.issues.get).toHaveBeenCalledTimes(2)
  })

  it('rejects an execution ID from a different issue', async () => {
    const { actions, api, message } = activityFixture()
    vi.mocked(api.executions!.list).mockResolvedValue([{ id: 15, loop_item_id: 'other' }] as never)
    await expect(actions.stop(message)).rejects.toThrow('Unavailable')
    expect(api.executions!.stop).not.toHaveBeenCalled()
  })

  it('uses current group subscription and exact agent for a real comment continuation', async () => {
    const { actions, chat, unsubscribe } = activityFixture()
    await actions.rerun()
    expect(chat.subscribe).toHaveBeenCalledWith(
      'group',
      'T-1',
      0,
      expect.any(Function),
      undefined,
      { containerKind: 'chat_group' }
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(chat.send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'group',
        taskId: 'T-1',
        containerKind: 'chat_group',
        replyToMessageId: 'run',
      })
    )
    expect(chat.executeTaskComment).toHaveBeenCalledWith({
      projectId: 'group',
      taskId: 'T-1',
      triggerMessageId: 'trigger',
    })
  })

  it.each(['crew', 'source', 'manager'] as const)(
    'cannot continue historical %s after reassignment',
    async changed => {
      const { actions, message, chat, crew } = activityFixture('B')
      const provenance = message.metadata.collaboration_group as Record<string, unknown>
      if (changed === 'crew') provenance.id = 'A'
      if (changed === 'source') provenance.binding_owner_id = 'old-project'
      if (changed === 'manager')
        crew.leader = { kind: 'agent', id: 'new-manager', responsibility: 'Coordinate review' }
      await expect(actions.rerun()).rejects.toThrow('Unavailable')
      expect(chat.send).not.toHaveBeenCalled()
      expect(chat.executeTaskComment).not.toHaveBeenCalled()
    }
  )

  it.each(['rerun', 'startHumanTask'] as const)(
    'rejects A to B during the %s snapshot wait',
    async action => {
      const { actions, api, item, chat, unsubscribe, message } = activityFixture('A')
      let finish!: (value: Awaited<ReturnType<ProjectChatClient['subscribe']>>) => void
      vi.mocked(chat.subscribe).mockReturnValue(
        new Promise(resolve => {
          finish = resolve
        })
      )
      const pending = actions[action]()
      await vi.waitFor(() => expect(chat.subscribe).toHaveBeenCalledOnce())
      vi.mocked(api.issues.get).mockResolvedValue({ ...item, assignee_group_id: 'B' })
      finish({
        snapshot: { currentUserId: '7', messages: [message], latestSequence: 1 },
        unsubscribe,
      })
      await expect(pending).rejects.toThrow('Unavailable')
      expect(chat.send).not.toHaveBeenCalled()
      expect(chat.executeTaskComment).not.toHaveBeenCalled()
      expect(requestIssueDispatch).not.toHaveBeenCalled()
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )

  it.each(['rerun', 'startHumanTask'] as const)(
    'rejects a changed crew definition during the %s snapshot wait',
    async action => {
      const { actions, chat, unsubscribe, message, crew } = activityFixture('crew')
      let finish!: (value: Awaited<ReturnType<ProjectChatClient['subscribe']>>) => void
      vi.mocked(chat.subscribe).mockReturnValue(
        new Promise(resolve => {
          finish = resolve
        })
      )
      const pending = actions[action]()
      await vi.waitFor(() => expect(chat.subscribe).toHaveBeenCalledOnce())
      crew.leader = { kind: 'agent', id: 'new-manager', responsibility: 'Coordinate review' }
      crew.version += 1
      finish({
        snapshot: { currentUserId: '7', messages: [message], latestSequence: 1 },
        unsubscribe,
      })
      await expect(pending).rejects.toThrow('Unavailable')
      expect(chat.send).not.toHaveBeenCalled()
      expect(chat.executeTaskComment).not.toHaveBeenCalled()
      expect(requestIssueDispatch).not.toHaveBeenCalled()
    }
  )

  it('preserves the configured automation prompt when continuing a run', async () => {
    const { actions, item, chat } = activityFixture()
    item.automation = { prompt: 'Use the approved automation instructions' }
    await actions.rerun()
    expect(chat.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: item.automation.prompt })
    )
  })

  it('resumes the assigned crew manager without changing assignment or inventing an agent', async () => {
    const { actions, api, chat } = activityFixture('crew')
    await actions.rerun()
    expect(chat.executeTaskComment).toHaveBeenCalledOnce()
    expect(api.issues.update).not.toHaveBeenCalled()
  })

  it('rechecks revoked authority between persisting the request and executing it', async () => {
    const { actions, chat, item } = activityFixture()
    vi.mocked(chat.send).mockImplementation(async () => {
      item.permissions!.execute = false
      return { messageId: 'trigger' } as ProjectChatMessage
    })
    await expect(actions.rerun()).rejects.toThrow('Unavailable')
    expect(chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('does not dispatch a stale human assignment after the latest manager round changed', async () => {
    const { actions } = activityFixture()
    await expect(actions.startHumanTask()).rejects.toThrow('Unavailable')
    expect(requestIssueDispatch).not.toHaveBeenCalled()
  })

  it('opens the exact current human work through the existing dispatch bridge', async () => {
    const { actions, message } = activityFixture('crew')
    message.metadata = {
      ...message.metadata,
      activity_type: 'manager_assignment',
      dispatch_id: 'dispatch',
      coordination_round_id: 'round',
      dispatch_assignments: [
        {
          assignee_type: 'human',
          human_user_id: 7,
          human_assignment_id: 'human',
          assignment_id: 'assignment',
          task_title: 'Review result',
        },
      ],
    }
    await actions.startHumanTask()
    expect(requestIssueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'group',
        itemId: 'T-1',
        humanAssignmentId: 'human',
        roundId: 'round',
        assignmentId: 'assignment',
        taskTitle: 'Review result',
      })
    )
  })
})
