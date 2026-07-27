import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TODO_WORKFLOW,
  loadLocalWorkItems,
  loadTodoWorkflow,
  saveTodoWorkflow,
} from './todoModel'

describe('todoModel', () => {
  beforeEach(() => window.localStorage.clear())

  it('migrates legacy drafts to root work items once', () => {
    window.localStorage.setItem(
      'wework:todo:drafts:1',
      JSON.stringify([
        {
          id: 'draft-1',
          projectId: 7,
          state: 'backlog',
          title: 'Legacy item',
          markdown: 'Legacy context',
          goal: 'Ship safely',
          priority: 'high',
          assignee: 'ai',
          attachments: [],
          createdAt: '2026-07-16T00:00:00Z',
          updatedAt: '2026-07-16T00:00:00Z',
        },
      ])
    )

    expect(loadLocalWorkItems(1)).toEqual([
      expect.objectContaining({
        id: 'draft-1',
        description: 'Legacy context',
        objective: 'Ship safely',
        assignee: { type: 'ai' },
      }),
    ])
    expect(window.localStorage.getItem('wework:todo:drafts:1')).toBeNull()
    expect(window.localStorage.getItem('wework:todo:work-items:1')).toContain('Legacy item')
  })

  it('stores workflow configuration per project', () => {
    const config = {
      ...DEFAULT_TODO_WORKFLOW,
      workTypes: [
        ...DEFAULT_TODO_WORKFLOW.workTypes,
        {
          key: 'security',
          name: 'Security',
          dependsOn: [],
          defaultAssignee: { type: 'human' as const, name: 'Security owner' },
        },
      ],
    }
    saveTodoWorkflow(7, config)
    expect(loadTodoWorkflow(7)).toEqual(config)
    expect(loadTodoWorkflow(9)).toEqual(DEFAULT_TODO_WORKFLOW)
  })
})
