// @vitest-environment node

import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { describe, expect, test, vi } from 'vitest'
import {
  createLocalFileWorkspaceTarget,
  resolveRuntimeWorkspaceContext,
  resolveWorkspaceTarget,
} from './workspace-target'

function createApi() {
  return {
    getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
  }
}

describe('resolveWorkspaceTarget', () => {
  const localDevices: DeviceInfo[] = [
    {
      id: 1,
      device_id: 'fixture-local',
      name: 'Fixture',
      status: 'online',
      is_default: true,
      device_type: 'local',
    },
  ]
  const root: WorkspaceTarget = {
    deviceId: 'fixture-local',
    path: '/fixture/repo',
    source: 'runtime',
    workspaceSource: 'local',
  }
  test('requires a complete UNC root when resolving an absolute Windows file', () => {
    expect(createLocalFileWorkspaceTarget(String.raw`\\report.md`, localDevices)).toBeNull()
    expect(
      createLocalFileWorkspaceTarget(String.raw`\\server\share\report.md`, localDevices, {
        pathStyleSource: 'C:/workspace',
      })?.path
    ).toBe('//server/share')
  })

  test('does not confuse path prefixes, other devices, or remote filesystem roots', () => {
    expect(
      createLocalFileWorkspaceTarget('/fixture/repository/src/a.ts', localDevices, {
        workspaceTargets: [
          root,
          { ...root, path: '/fixture', deviceId: 'other-device' },
          { ...root, path: '/fixture', workspaceSource: 'remote' },
        ],
      })?.path
    ).toBe('/fixture/repository/src')
    expect(
      createLocalFileWorkspaceTarget('/fixture/repo/../external/a.ts', localDevices, {
        workspaceTargets: [root],
      })?.path
    ).toBe('/fixture/external')
  })

  test('matches Windows roots case-insensitively without rewriting their identity', () => {
    const windowsRoot = { ...root, path: 'C:\\Fixture\\Repo' }
    expect(
      createLocalFileWorkspaceTarget('c:\\fixture\\repo\\src\\a.ts', localDevices, {
        workspaceTargets: [windowsRoot],
      })
    ).toEqual(windowsRoot)
  })

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

  test('creates a local file target for Windows drive-letter absolute paths', () => {
    const devices = [
      {
        id: 1,
        device_id: 'device-local-real',
        name: 'Local Windows',
        status: 'online' as const,
        is_default: true,
        device_type: 'local' as const,
      },
    ]

    expect(createLocalFileWorkspaceTarget('C:\\projects\\example-app\\wegent', devices)).toEqual({
      deviceId: 'device-local-real',
      path: 'C:/projects/example-app',
      source: 'runtime',
      workspaceSource: 'local',
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
        currentProject: project,
        api: createApi(),
      })
    ).resolves.toEqual({
      deviceId: 'device-b',
      path: '/workspace/projects/abc/Wegent',
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

  test('does not expose a queued independent workspace path to file data planes', () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
    }

    expect(
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask: {
          deviceId: 'device-b',
          workspacePath: '/workspace/worktrees/runtime-1/project-alpha',
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
                      workspacePath: '/workspace/worktrees/runtime-1/project-alpha',
                      workspaceKind: 'workspace',
                      title: 'Queued Worktree task',
                      runtime: 'codex',
                      status: 'queued',
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
      workspaceTarget: null,
    })
  })

  test('does not use an unprojected Worktree task path as a workspace target', () => {
    expect(
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask: {
          deviceId: 'device-b',
          workspacePath: '/workspace/worktrees/runtime-1/project-alpha',
          workspaceKind: 'worktree',
          taskId: 'runtime-1',
        },
        projects: [],
        runtimeWork: {
          projects: [],
          chats: [],
          totalTasks: 0,
        },
      })
    ).toBeNull()
  })

  test('uses the final remote Worktree path for historical task tools', () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
    }

    expect(
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask: {
          deviceId: 'logical-cloud-device',
          workspacePath: '/executor/worktrees/runtime-1/project-alpha',
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
                  deviceId: 'logical-cloud-device',
                  remoteHostId: 'runtime-cloud-device',
                  workspacePath: '/executor/worktrees/runtime-1/project-alpha',
                  workspaceSource: 'remote',
                  workspaceKind: 'worktree',
                  worktreeId: 'runtime-1',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-1',
                      workspacePath: '/executor/worktrees/runtime-1/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: 'runtime-1',
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
        deviceId: 'runtime-cloud-device',
        path: '/executor/worktrees/runtime-1/project-alpha',
        source: 'runtime',
        taskId: 'runtime-1',
        workspaceSource: 'remote',
      },
    })
  })
})
