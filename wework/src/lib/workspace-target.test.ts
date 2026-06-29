import { describe, expect, test, vi } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import {
  resolveProjectRuntimeWorkspaceTarget,
  resolveRuntimeWorkspaceContext,
  resolveWorkspaceTarget,
} from './workspace-target'

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
        currentProject: project,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/projects/abc/Wegent',
      source: 'project',
    })
  })

  test('does not infer an active workspace without a project or runtime task', async () => {
    await expect(
      resolveWorkspaceTarget({
        currentProject: null,
        api: createApi(),
      })
    ).resolves.toBeNull()
  })

  test('resolves a selected project workspace from runtime work', () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
    }

    expect(
      resolveProjectRuntimeWorkspaceTarget({
        currentProject: project,
        selectedDeviceWorkspaceId: 22,
        runtimeWork: {
          projects: [
            {
              project: { id: 12, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  deviceId: 'device-b',
                  workspacePath: '/Users/me/Wegent',
                  workspaceSource: 'local',
                  available: true,
                  localTasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalLocalTasks: 0,
        },
      })
    ).toEqual({
      deviceId: 'device-b',
      path: '/Users/me/Wegent',
      source: 'project',
      workspaceSource: 'local',
    })
  })

  test('uses the only available project workspace when none is explicitly selected', () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
    }

    expect(
      resolveProjectRuntimeWorkspaceTarget({
        currentProject: project,
        runtimeWork: {
          projects: [
            {
              project: { id: 12, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  deviceId: 'device-b',
                  workspacePath: '/Users/me/Wegent',
                  workspaceSource: 'local',
                  available: true,
                  localTasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalLocalTasks: 0,
        },
      })
    ).toMatchObject({
      deviceId: 'device-b',
      path: '/Users/me/Wegent',
      source: 'project',
    })
  })

  test('resolves runtime task project and workspace from runtime work', () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: { targetType: 'local', deviceId: 'device-b' },
      },
    }

    expect(
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask: {
          deviceId: 'device-b',
          workspacePath: '/workspace/project-alpha',
          localTaskId: 'runtime-1',
        },
        projects: [project],
        runtimeWork: {
          projects: [
            {
              project: { id: 12, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  deviceId: 'device-b',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  localTasks: [
                    {
                      localTaskId: 'runtime-1',
                      workspacePath: '/workspace/worktrees/8/project-alpha',
                      title: 'Runtime task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalLocalTasks: 1,
        },
      })
    ).toEqual({
      project,
      workspaceTarget: {
        deviceId: 'device-b',
        path: '/workspace/worktrees/8/project-alpha',
        source: 'runtime',
      },
    })
  })
})
