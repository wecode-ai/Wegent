import { describe, expect, test } from 'vitest'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

describe('buildWorkItemRuntimeContext', () => {
  test('keeps the project store and private Issue boundary in the runtime context', () => {
    const context = buildWorkItemRuntimeContext(
      {
        id: 'project-1',
        name: 'Cloud project',
        project_store: 'backend',
      } as CloudProject,
      {
        id: 'ISSUE-1',
        title: 'Manual task',
      } as CloudLoopItem
    )

    expect(context.origin).toMatchObject({
      cloudProjectId: 'project-1',
      loopItemId: 'ISSUE-1',
      projectStore: 'backend',
    })
    expect(context.additionalContext?.projectSpaceIssue?.value).toContain('"id":"project-1"')
    expect(context.additionalContext?.projectSpaceIssue?.value).toContain('"id":"ISSUE-1"')
    expect(context.additionalContext?.projectSpaceIssue?.value).toContain(
      'must not advance its status or change its assignee'
    )
  })
})
