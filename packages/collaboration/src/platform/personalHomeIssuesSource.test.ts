// @vitest-environment jsdom

import { expect, it, vi } from 'vitest'
import type { WorkspaceMyWorkItem } from '../ports/SharedWorkspaceApi'
import {
  createPersonalHomeIssuesSource,
  type PersonalHomeIssueSource,
} from './personalHomeIssuesSource'
import { createPersonalIssuesApi } from './personalIssuesApi'

function issue(id: string): WorkspaceMyWorkItem {
  return {
    id,
    cloud_project_id: '',
    sequence_number: 0,
    parent_id: null,
    title: id,
    description: '',
    status: 'pending',
    priority: 'medium',
    due_at: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: '2026-11-24T00:00:00Z',
    updated_at: '2026-11-24T00:00:00Z',
    completed_at: null,
    project_key: '',
    project_name: '',
    has_active_task: false,
  }
}

it('loads unlinked Issues and task bindings from My Work', async () => {
  const get = vi.fn().mockResolvedValue({
    items: [
      {
        ...issue('unlinked'),
        task_bindings: [{ id: 'binding', device_id: 'device', task_id: 'task' }],
      },
      { ...issue('already-in-project'), cloud_project_id: '12', task_bindings: [] },
    ],
    next_cursor: 'remaining',
  })
  const api = createPersonalIssuesApi({ get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() })
  const page = await api.list('assigned', false, 'position')
  const [path, query] = get.mock.calls[0][0].split('?')
  expect(path).toBe('/v1/cloud-work-items/my-work')
  expect(Object.fromEntries(new URLSearchParams(query))).toMatchObject({
    unlinked: 'true',
    scope: 'assigned',
    include_completed: 'false',
    cursor: 'position',
  })
  expect(page.next_cursor).toBe('remaining')
  expect(page.items.map(item => item.id)).toEqual(['unlinked'])
  expect(page.items[0].task_bindings?.[0]).toMatchObject({
    projectId: '',
    deviceId: 'device',
    taskId: 'task',
  })
})

it('paginates Issues without a project while a project source is still loading', async () => {
  const projects = {
    myWork: { page: () => new Promise<never>(() => {}) },
  }
  const withoutProject = {
    myWork: {
      async page(input?: { cursor?: string }) {
        return input?.cursor
          ? { items: [issue('second')], nextCursor: null }
          : { items: [issue('first')], nextCursor: 'next' }
      },
    },
  }
  const source = createPersonalHomeIssuesSource<PersonalHomeIssueSource>(
    [projects, withoutProject],
    {
      scope: 'created',
      includeCompleted: true,
      order: 'activity',
      viewerIds: [1],
    }
  )
  const unsubscribe = source.subscribe(() => {})
  try {
    await expect.poll(() => source.getSnapshot().rows[1].nextCursor).toBe('next')
    expect(source.getSnapshot().rows[0].loading).toBe(true)

    await source.loadMore()

    const [pending, loaded] = source.getSnapshot().rows
    expect(pending.loading).toBe(true)
    expect(loaded.items.map(item => item.id)).toEqual(['first', 'second'])
    expect(loaded.nextCursor).toBeNull()
  } finally {
    unsubscribe()
  }
})
