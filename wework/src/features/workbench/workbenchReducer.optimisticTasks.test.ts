import { describe, expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

const project = { id: 7, name: 'Repo', tasks: [] }
const root = '/workspace/repo'
const worktree = '/workspace/worktrees/task/repo'

function workspace(path: string): RuntimeDeviceWorkspace {
  return {
    deviceId: 'device-1',
    workspacePath: path,
    workspaceKind: path === root ? 'workspace' : 'worktree',
    available: true,
    mapped: true,
    tasks: [],
  }
}

function task(path: string, optimistic = true): RuntimeTaskSummary {
  return {
    taskId: 'task-1',
    title: 'Run from main',
    runtime: 'codex',
    workspacePath: path,
    status: 'running',
    optimistic,
    updatedAt: new Date().toISOString(),
  }
}

describe('optimistic sidebar task identity', () => {
  test.each([true, false])(
    'keeps one task when the create response changes workspace (project: %s)',
    inProject => {
      const upsert = (path: string) =>
        ({
          type: 'runtime_task_optimistic_upserted',
          project: inProject ? project : null,
          workspace: workspace(path),
          task: task(path),
        }) as const
      const pending = workbenchReducer(initialWorkbenchState, upsert(root))
      const accepted = workbenchReducer(pending, upsert(worktree))
      const workspaces = inProject
        ? accepted.runtimeWork!.projects[0].deviceWorkspaces
        : accepted.runtimeWork!.chats

      expect(workspaces.flatMap(item => item.tasks)).toEqual([
        expect.objectContaining({ taskId: 'task-1', workspacePath: worktree }),
      ])
      expect(accepted.runtimeWork?.totalTasks).toBe(1)
      expect(workspaces.find(item => item.tasks.length)?.workspacePath).toBe(worktree)
    }
  )

  test.each([root, worktree])('keeps an executor snapshot ahead of a late response at %s', path => {
    const confirmedTask = {
      ...task(worktree, false),
      status: 'done',
      running: false,
      completedAt: 1,
    }
    const confirmedWorkspace = { ...workspace(root), tasks: [confirmedTask] }
    const refreshed = workbenchReducer(initialWorkbenchState, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [
          {
            project: { ...project, key: 'repo' },
            deviceWorkspaces: [confirmedWorkspace],
            totalTasks: 1,
          },
        ],
        chats: [],
        totalTasks: 1,
      },
    })
    const accepted = workbenchReducer(refreshed, {
      type: 'runtime_task_optimistic_upserted',
      project,
      workspace: workspace(path),
      task: task(worktree),
    })

    expect(accepted.runtimeWork).toEqual(refreshed.runtimeWork)
    expect(accepted.runtimeWork?.totalTasks).toBe(1)
  })

  test('reconciles workspace kind metadata without duplicating the task', () => {
    const action = {
      type: 'runtime_task_optimistic_upserted',
      project,
      workspace: workspace(root),
      task: task(root),
    } as const
    const pending = workbenchReducer(initialWorkbenchState, action)
    const accepted = workbenchReducer(pending, {
      ...action,
      workspace: { ...action.workspace, workspaceKind: 'worktree' },
    })

    expect(accepted.runtimeWork?.totalTasks).toBe(1)
    expect(accepted.runtimeWork?.projects[0].deviceWorkspaces.flatMap(item => item.tasks)).toEqual([
      action.task,
    ])
  })

  test('preserves other tasks and the same task id on another device', () => {
    const first = workbenchReducer(initialWorkbenchState, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        projects: [],
        chats: [
          { ...workspace(root), tasks: [task(root), { ...task(root), taskId: 'other-task' }] },
          { ...workspace(root), deviceId: 'device-2', tasks: [task(root, false)] },
        ],
        totalTasks: 3,
      },
    })
    const accepted = workbenchReducer(first, {
      type: 'runtime_task_optimistic_upserted',
      project: null,
      workspace: workspace(worktree),
      task: task(worktree),
    })

    expect(accepted.runtimeWork?.totalTasks).toBe(3)
    expect(accepted.runtimeWork?.chats.find(item => item.deviceId === 'device-2')).toEqual(
      first.runtimeWork?.chats[1]
    )
    expect(accepted.runtimeWork?.chats.find(item => item.workspacePath === root)?.tasks).toEqual([
      expect.objectContaining({ taskId: 'other-task' }),
    ])
  })
})
