import { describe, expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

describe('workbenchReducer', () => {
  test('selects a project and keeps current task empty', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })

    expect(state.currentProject?.id).toBe(7)
    expect(state.currentTask).toBeNull()
  })

  test('opens task and leaves selected project unchanged', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(selected, {
      type: 'task_opened',
      task: {
        id: 3,
        title: '历史会话',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })

    expect(opened.currentProject?.id).toBe(7)
    expect(opened.currentTask?.id).toBe(3)
  })

  test('opens task with explicit project context', () => {
    const opened = workbenchReducer(initialWorkbenchState, {
      type: 'task_opened',
      task: {
        id: 3,
        title: '历史会话',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
      project: { id: 9, name: 'sina-sso', tasks: [] },
    })

    expect(opened.currentProject?.id).toBe(9)
    expect(opened.currentProject?.name).toBe('sina-sso')
    expect(opened.currentTask?.id).toBe(3)
  })
})
