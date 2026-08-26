import { describe, expect, test } from 'vitest'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

describe('buildWorkItemRuntimeContext', () => {
  test('keeps the project store in the runtime task origin', () => {
    const context = buildWorkItemRuntimeContext(
      {
        id: 'project-1',
        name: 'Cloud project',
        project_store: 'backend',
      } as CloudProject,
      {
        id: 'ISSUE-1',
        title: 'Manual task',
      } as CloudLoopItem,
      'stage-2'
    )

    expect(context.origin).toMatchObject({
      cloudProjectId: 'project-1',
      loopItemId: 'ISSUE-1',
      projectStore: 'backend',
    })
  })
})
