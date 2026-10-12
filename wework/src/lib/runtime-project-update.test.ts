import { expect, test } from 'vitest'
import { updateRuntimeWorkProject } from './runtime-project-update'
import type { RuntimeWorkListResponse } from '@/types/api'

test('updates only the owning device while keeping existing conversation snapshots', () => {
  const work: RuntimeWorkListResponse = {
    projects: ['a', 'b'].map(deviceId => ({
      project: {
        key: 'same-key',
        name: deviceId,
        ownerDeviceId: deviceId,
        roots: [{ kind: 'local', path: '/old' }],
      },
      deviceWorkspaces: [
        {
          deviceId,
          workspacePath: '/old',
          available: true,
          mapped: true,
          tasks: [
            {
              taskId: deviceId,
              title: 'Existing',
              workspacePath: '/old',
              runtime: 'codex',
              projectPluginIds: ['old'],
            },
          ],
        },
      ],
    })),
    chats: [],
    totalTasks: 2,
  }
  const next = updateRuntimeWorkProject(work, {
    deviceId: 'b',
    projectKey: 'same-key',
    name: 'Updated',
    roots: ['/new', '/second'],
    defaultProjectSpace: null,
    aiSettings: { instructions: 'New' },
  })
  expect(next.projects[0]).toBe(work.projects[0])
  expect(next.projects[1].project.name).toBe('Updated')
  expect(next.projects[1].deviceWorkspaces[0].workspacePath).toBe('/new')
  expect(next.projects[1].deviceWorkspaces[0].tasks).toBe(
    work.projects[1].deviceWorkspaces[0].tasks
  )
  expect(next.projects[1].deviceWorkspaces[0].tasks[0].workspacePath).toBe('/old')
})

test('preserves a registered worktree workspace when the project primary root changes', () => {
  const worktree = {
    deviceId: 'device',
    workspacePath: '/trees/existing',
    workspaceKind: 'worktree',
    worktreeId: 'tree',
    available: true,
    tasks: [],
  }
  const work: RuntimeWorkListResponse = {
    projects: [
      {
        project: { key: 'project', name: 'Project', stateDeviceId: 'device' },
        deviceWorkspaces: [
          worktree,
          {
            deviceId: 'device',
            workspacePath: '/old',
            workspaceKind: 'workspace',
            available: true,
            tasks: [],
          },
        ],
      },
    ],
    chats: [],
    totalTasks: 0,
  }
  const next = updateRuntimeWorkProject(work, {
    deviceId: 'device',
    projectKey: 'project',
    name: 'Project',
    roots: ['/new'],
    defaultProjectSpace: null,
    aiSettings: null,
  })
  expect(next.projects[0].deviceWorkspaces[0]).toBe(worktree)
  expect(next.projects[0].deviceWorkspaces[1].workspacePath).toBe('/new')
})
