import { describe, expect, test, vi } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import { resolveWorkspaceTarget } from './workspace-target'

function createApi() {
  return {
    getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
  }
}

describe('resolveWorkspaceTarget', () => {
  test('resolves relative git project paths under the executor workspace root', async () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: { targetType: 'local', deviceId: 'device-b' },
        workspace: { source: 'git', checkoutPath: 'projects/abc/Wegent' },
      },
    }

    await expect(
      resolveWorkspaceTarget({
        currentTask: null,
        currentProject: project,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/projects/abc/Wegent',
      source: 'project',
    })
  })

  test('uses the explicit project workspace when the task has no execution workspace', async () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: { targetType: 'local', deviceId: 'device-b' },
        workspace: { source: 'git', checkoutPath: 'projects/abc/Wegent' },
      },
    }

    await expect(
      resolveWorkspaceTarget({
        currentTask: { id: 99, title: 'Task', status: 'RUNNING', created_at: 'now' },
        currentProject: project,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/projects/abc/Wegent',
      source: 'project',
    })
  })

  test('uses current task execution workspace path before project workspace', async () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: { targetType: 'local', deviceId: 'device-b' },
        workspace: { source: 'git', checkoutPath: 'projects/abc/Wegent' },
      },
    }

    await expect(
      resolveWorkspaceTarget({
        currentTask: {
          id: 8,
          title: 'Task',
          status: 'RUNNING',
          device_id: 'device-b',
          execution_workspace_path: '/workspace/worktrees/8/Wegent',
          created_at: 'now',
        },
        currentProject: project,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/worktrees/8/Wegent',
      source: 'task',
      taskId: 8,
    })
  })

  test('does not infer an active workspace from task messages', async () => {
    await expect(
      resolveWorkspaceTarget({
        currentTask: { id: 1, title: 'Task', status: 'RUNNING', created_at: 'now' },
        currentProject: null,
        api: createApi(),
      })
    ).resolves.toBeNull()
  })
})
