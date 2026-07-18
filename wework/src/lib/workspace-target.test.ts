import { describe, expect, test, vi } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import {
  createLocalAttachmentWorkspaceTarget,
  createLocalFileWorkspaceTarget,
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
  test('creates a local file target with the real local device id', () => {
    expect(
      createLocalFileWorkspaceTarget('/Users/me/.agents/skills/gmail/SKILL.md', [
        {
          id: 1,
          device_id: 'device-local-real',
          name: 'Local Mac',
          status: 'online',
          is_default: true,
          device_type: 'local',
        },
      ])
    ).toEqual({
      deviceId: 'device-local-real',
      path: '/Users/me/.agents/skills/gmail',
      source: 'runtime',
      workspaceSource: 'local',
    })
  })

  test('rejects relative local file paths', () => {
    expect(createLocalFileWorkspaceTarget('skills/gmail/SKILL.md', [])).toBeNull()
  })

  test('creates a local target only for Wework attachment paths', () => {
    const devices = [
      {
        id: 1,
        device_id: 'device-local-real',
        name: 'Local Mac',
        status: 'online' as const,
        is_default: true,
        device_type: 'local' as const,
      },
    ]

    expect(
      createLocalAttachmentWorkspaceTarget(
        '/Users/me/.wegent-executor/workspace/attachments/draft/42/result.png',
        devices
      )
    ).toMatchObject({
      deviceId: 'device-local-real',
      path: '/Users/me/.wegent-executor/workspace/attachments/draft/42',
      workspaceSource: 'local',
    })
    expect(
      createLocalAttachmentWorkspaceTarget('/workspace/project/result.png', devices)
    ).toBeNull()
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
                  tasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
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
                  tasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
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
          taskId: 'runtime-1',
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
                  tasks: [
                    {
                      taskId: 'runtime-1',
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
          totalTasks: 1,
        },
      })
    ).toEqual({
      project,
      workspaceTarget: {
        deviceId: 'device-b',
        path: '/workspace/worktrees/8/project-alpha',
        source: 'runtime',
        taskId: 'runtime-1',
      },
    })
  })
})
