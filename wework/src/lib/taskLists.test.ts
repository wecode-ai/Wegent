import { describe, expect, test } from 'vitest'
import type { Task } from '@/types/api'
import { selectStandaloneConversations, sortTasksByTime } from './taskLists'

function task(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'RUNNING',
    task_type: 'code',
    created_at: '2026-05-25T00:00:00.000Z',
    ...overrides,
  } as Task
}

describe('taskLists', () => {
  test('sortTasksByTime orders by most recent activity first', () => {
    const sorted = sortTasksByTime([
      task({ id: 1, updated_at: '2026-05-25T00:00:00.000Z' }),
      task({ id: 2, updated_at: '2026-05-27T00:00:00.000Z' }),
      task({ id: 3, updated_at: '2026-05-26T00:00:00.000Z' }),
    ])

    expect(sorted.map(item => item.id)).toEqual([2, 3, 1])
  })

  test('selectStandaloneConversations excludes tasks that belong to a project', () => {
    const result = selectStandaloneConversations([
      task({ id: 1, project_id: 0, updated_at: '2026-05-25T00:00:00.000Z' }),
      task({ id: 2, project_id: 7, updated_at: '2026-05-27T00:00:00.000Z' }),
      task({ id: 3, updated_at: '2026-05-26T00:00:00.000Z' }),
    ])

    expect(result.map(item => item.id)).toEqual([3, 1])
  })
})
