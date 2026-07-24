import { describe, expect, it } from 'vitest'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import { resolveLocalTodoProjects } from './localTodoProjects'

describe('resolveLocalTodoProjects', () => {
  it('includes local projects discovered from runtime work', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'local:11',
            id: 11,
            name: 'Wegent',
            kind: 'local',
            source: 'local_project',
          },
          deviceWorkspaces: [],
        },
      ],
      chats: [],
      totalTasks: 0,
    }

    expect(resolveLocalTodoProjects([], runtimeWork)).toEqual([
      expect.objectContaining({ id: 11, name: 'Wegent' }),
    ])
  })

  it('keeps stored metadata and excludes remote project descriptors', () => {
    const stored: ProjectWithTasks = {
      id: 11,
      name: 'Stored name',
      config: { mode: 'workspace' },
      tasks: [],
    }
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'local:11', id: 11, name: 'Runtime name', kind: 'local' },
          deviceWorkspaces: [],
        },
        {
          project: { key: 'remote:12', id: 12, name: 'Remote', kind: 'remote' },
          deviceWorkspaces: [],
        },
      ],
      chats: [],
      totalTasks: 0,
    }

    expect(resolveLocalTodoProjects([stored], runtimeWork)).toEqual([
      expect.objectContaining({
        id: 11,
        name: 'Runtime name',
        config: stored.config,
      }),
    ])
  })
})
