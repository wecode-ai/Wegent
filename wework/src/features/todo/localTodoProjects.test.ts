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

  it('assigns a stable UI id to local runtime projects without backend ids', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'local-project',
            stateDeviceId: 'local-device',
            name: 'Local project',
            kind: 'local',
          },
          deviceWorkspaces: [
            {
              id: 1,
              deviceId: 'local-device',
              deviceName: 'Local',
              deviceStatus: 'online',
              workspacePath: '/workspace/local-project',
              workspaceKind: 'workspace',
              workspaceSource: 'local',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }

    expect(resolveLocalTodoProjects([], runtimeWork)).toEqual([
      expect.objectContaining({
        id: expect.any(Number),
        name: 'Local project',
        config: expect.objectContaining({
          workspace: expect.objectContaining({ localPath: '/workspace/local-project' }),
        }),
      }),
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
