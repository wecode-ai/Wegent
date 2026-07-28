import { describe, expect, test } from 'vitest'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { emptyTaskSearchFilters, searchTasks } from './taskSearch'

const items: CloudLoopItem[] = [
  {
    id: 'PROJ-1',
    cloud_project_id: 'project-1',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: 2,
    title: 'Fix login',
    description: 'OAuth callback fails',
    status: 'in_progress',
    priority: 'high',
    due_at: '2026-07-20T00:00:00Z',
    tags: ['bug'],
    sort_order: 1,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    completed_at: null,
  },
  {
    id: 'PROJ-2',
    cloud_project_id: 'project-1',
    sequence_number: 2,
    parent_id: 'PROJ-1',
    created_by_user_id: 2,
    assignee_user_id: null,
    title: 'Document deployment',
    description: '',
    status: 'pending',
    priority: 'none',
    due_at: null,
    tags: ['docs'],
    sort_order: 2,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    completed_at: null,
  },
]

const members: CloudProjectMember[] = [
  { id: 1, user_id: 1, user_name: 'Micro66', email: null, role: 'Owner' },
  { id: 2, user_id: 2, user_name: 'Admin', email: null, role: 'Developer' },
]

describe('searchTasks', () => {
  test('ranks exact ids and searches member names and nested tasks', () => {
    expect(searchTasks(items, 'PROJ-1', emptyTaskSearchFilters, members)[0].item.id).toBe('PROJ-1')
    expect(searchTasks(items, 'Micro66', emptyTaskSearchFilters, members)[0].item.id).toBe('PROJ-1')
    expect(searchTasks(items, 'deployment', emptyTaskSearchFilters, members)[0]).toMatchObject({
      item: { id: 'PROJ-2' },
      parentPath: ['Fix login'],
    })
  })

  test('combines structured filters', () => {
    expect(
      searchTasks(
        items,
        '',
        {
          ...emptyTaskSearchFilters,
          status: 'in_progress',
          tag: 'bug',
          creatorUserId: 1,
          due: 'overdue',
          children: 'with_children',
        },
        members,
        new Date('2026-07-28T00:00:00Z')
      ).map(result => result.item.id)
    ).toEqual(['PROJ-1'])
  })
})
