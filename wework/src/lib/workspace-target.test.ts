import { describe, expect, test, vi } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { resolveWorkspaceTarget } from './workspace-target'

function createApi() {
  return {
    getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
  }
}

describe('resolveWorkspaceTarget', () => {
  test('prefers latest active task file-change workspace', async () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-12T00:00:00.000Z',
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'turn-file-changes/1/2',
          device_id: 'device-a',
          workspace_path: '/workspace/worktrees/1/Wegent',
          file_count: 0,
          additions: 0,
          deletions: 0,
          files: [],
        },
      },
    ]

    await expect(
      resolveWorkspaceTarget({
        currentTask: { id: 1, title: 'Task', status: 'RUNNING', created_at: 'now' },
        currentProject: null,
        messages,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-a',
      path: '/workspace/worktrees/1/Wegent',
      source: 'task',
    })
  })

  test('ignores newer active task file-change workspaces from other tasks', async () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        taskId: 1,
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-12T00:00:00.000Z',
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'turn-file-changes/1/2',
          device_id: 'device-a',
          workspace_path: '/workspace/worktrees/1/Wegent',
          file_count: 0,
          additions: 0,
          deletions: 0,
          files: [],
        },
      },
      {
        id: 'assistant-2',
        taskId: 2,
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-12T00:01:00.000Z',
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'turn-file-changes/2/3',
          device_id: 'device-b',
          workspace_path: '/workspace/worktrees/2/Other',
          file_count: 0,
          additions: 0,
          deletions: 0,
          files: [],
        },
      },
    ]

    await expect(
      resolveWorkspaceTarget({
        currentTask: { id: 1, title: 'Task', status: 'RUNNING', created_at: 'now' },
        currentProject: null,
        messages,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-a',
      path: '/workspace/worktrees/1/Wegent',
      source: 'task',
      taskId: 1,
    })
  })

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
        messages: [],
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/projects/abc/Wegent',
      source: 'project',
    })
  })

  test('uses the explicit project workspace before stale task file-change workspaces', async () => {
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
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        taskId: 99,
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-12T00:00:00.000Z',
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'turn-file-changes/99/100',
          device_id: 'device-a',
          workspace_path: '/Users/me/outside-workspace',
          file_count: 0,
          additions: 0,
          deletions: 0,
          files: [],
        },
      },
    ]

    await expect(
      resolveWorkspaceTarget({
        currentTask: { id: 99, title: 'Task', status: 'RUNNING', created_at: 'now' },
        currentProject: project,
        messages,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/projects/abc/Wegent',
      source: 'project',
    })
  })

  test('uses current task execution workspace path before project and task file-change workspace', async () => {
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
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        taskId: 8,
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-12T00:00:00.000Z',
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'turn-file-changes/8/9',
          device_id: 'device-b',
          workspace_path: '/workspace/worktrees/stale/Wegent',
          file_count: 0,
          additions: 0,
          deletions: 0,
          files: [],
        },
      },
    ]

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
        messages,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/worktrees/8/Wegent',
      source: 'task',
      taskId: 8,
    })
  })
})
