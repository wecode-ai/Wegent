// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { humanTaskDispatchInput } from '@/features/todo/humanTaskDispatch'
import { requireThreadHumanTaskStart } from './threadHumanTaskStart'
import { activityFixture } from './threadExecutionActivity.test-support'

function setup() {
  const fixture = activityFixture('crew')
  fixture.message.metadata = {
    ...fixture.message.metadata,
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
        instructions: 'Review the exact delivery',
        workflow_stage_id: 'review',
      },
    ],
  }
  const dispatch = humanTaskDispatchInput({
    humanAssignmentId: 'human',
    dispatchId: 'dispatch',
    roundId: 'round',
    assignmentId: 'assignment',
    taskTitle: 'Review result',
    instructions: 'Review the exact delivery',
    workflowStageId: 'review',
  })
  const input = {
    context: fixture.context,
    groups: fixture.groups,
    chat: fixture.chat,
    dispatch,
    unavailable: 'Unavailable',
    isCurrent: fixture.isCurrent,
  }
  return { ...fixture, dispatch, input }
}

describe('Exact crew human-work authorization', () => {
  it('allows the currently assigned human work while the issue remains assigned to the crew', async () => {
    const { input } = setup()
    const issue = await requireThreadHumanTaskStart(input)
    expect(issue.assignee_group_id).toBe('crew')
    expect(issue.assignee_user_id).not.toBe(7)
  })

  it.each([
    'humanAssignmentId',
    'dispatchId',
    'roundId',
    'assignmentId',
    'taskTitle',
    'instructions',
    'workflowStageId',
  ] as const)('rejects changed %s rather than reusing stale instructions', async field => {
    const { input, dispatch } = setup()
    dispatch[field] = 'old-value'
    await expect(requireThreadHumanTaskStart(input)).rejects.toThrow('Unavailable')
  })

  it('allows independent private assistance without claiming a crew human assignment', async () => {
    const { input, chat } = setup()
    const issue = await requireThreadHumanTaskStart({ ...input, dispatch: undefined })
    expect(issue.assignee_group_id).toBe('crew')
    expect(chat.subscribe).not.toHaveBeenCalled()
  })

  it('rejects a manager assignment addressed to somebody else', async () => {
    const { input, message } = setup()
    ;(message.metadata.dispatch_assignments as Array<Record<string, unknown>>)[0].human_user_id = 8
    await expect(requireThreadHumanTaskStart(input)).rejects.toThrow('Unavailable')
  })

  it('rejects a revoked resource grant before opening the private composer', async () => {
    const { input, api } = setup()
    vi.mocked(api.projects.listCollaborationGroups).mockRejectedValue(new Error('Revoked'))
    await expect(requireThreadHumanTaskStart(input)).rejects.toThrow('Revoked')
  })

  it('rejects a member who has left the thread', async () => {
    const { input, participation } = setup()
    participation.joined = false
    await expect(requireThreadHumanTaskStart(input)).rejects.toThrow('Unavailable')
  })
})
