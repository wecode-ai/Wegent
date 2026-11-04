// @vitest-environment node
import { expect, it } from 'vitest'
import { interactionSource } from './runtimeInteractions'
import { interactionTask } from './runtimeInteractions.fixtures'

it.each(['board_comment', 'board_task', 'issue_dispatch', 'project_automation'])(
  'groups %s executions under Projects even without a comment reply binding',
  type => {
    const origin = { type, cloudProjectId: '12', loopItemId: 'ISSUE-1' }
    const item = {
      task: {
        ...interactionTask,
        task: { ...interactionTask.task, runtimeHandle: { origin } },
      },
    }
    expect(interactionSource(item)).toBe('project')
    expect(interactionSource(item, { ...origin, initiatedBy: 'stand_in' })).toBe('stand_in')
  }
)
