import { describe, expect, test } from 'vitest'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { RuntimeWorkListResponse } from '@/types/api'
import {
  resolveRuntimeTaskWorkspaceBinding,
  runtimeTaskProjectUiId,
  withoutRuntimeTaskWorkspaceBinding,
} from './runtime-task-workspace-binding'

const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: {
        key: 'backend:91',
        id: 91,
        name: '中心项目',
      },
      deviceWorkspaces: [
        {
          id: 191,
          projectId: 91,
          deviceId: 'cloud-route',
          available: true,
          workspacePath: '/srv/backend',
          tasks: [],
        },
      ],
    },
    {
      project: {
        key: 'remote:docs',
        name: '文档',
        source: 'remote_project',
        stateDeviceId: 'state-device',
        roots: [{ kind: 'local', path: '/srv/docs' }],
      },
      deviceWorkspaces: [
        {
          id: null,
          projectId: null,
          deviceId: 'state-device',
          remoteHostId: 'cloud-executor',
          workspaceSource: 'remote',
          available: true,
          workspacePath: '/srv/docs',
          tasks: [],
        },
      ],
    },
  ],
  chats: [],
  totalTasks: 0,
}

describe('runtime task workspace binding', () => {
  test('builds a Backend project binding from a mapped workspace', () => {
    expect(
      resolveRuntimeTaskWorkspaceBinding({
        runtimeWork,
        projectUiId: 91,
        deviceWorkspaceId: 191,
      })
    ).toEqual({
      projectId: 91,
      deviceWorkspaceId: 191,
    })
  })

  test('builds a device project binding without persisting workspacePath', () => {
    const projectUiId = runtimeProjectUiId(runtimeWork.projects[1].project)

    expect(resolveRuntimeTaskWorkspaceBinding({ runtimeWork, projectUiId })).toEqual({
      deviceId: 'cloud-executor',
      runtimeProjectKey: 'remote:docs',
      runtimeProjectName: '文档',
      runtimeWorkspaceRoots: ['/srv/docs'],
    })
  })

  test('resolves the UI project from either stable binding', () => {
    expect(
      runtimeTaskProjectUiId(runtimeWork, {
        runtime: 'codex',
        message: 'backend',
        projectId: 91,
        deviceWorkspaceId: 191,
      })
    ).toBe(91)
    expect(
      runtimeTaskProjectUiId(runtimeWork, {
        runtime: 'codex',
        message: 'device',
        deviceId: 'cloud-executor',
        runtimeProjectKey: 'remote:docs',
      })
    ).toBe(runtimeProjectUiId(runtimeWork.projects[1].project))
  })

  test('removes an old binding before rebuilding a task request', () => {
    expect(
      withoutRuntimeTaskWorkspaceBinding({
        runtime: 'codex',
        message: 'task',
        projectId: 91,
        deviceWorkspaceId: 191,
        deviceId: 'stale-device',
        workspacePath: '/stale',
        runtimeProjectKey: 'stale',
        runtimeProjectName: 'Stale',
        runtimeWorkspaceRoots: ['/stale'],
      })
    ).toEqual({
      runtime: 'codex',
      message: 'task',
    })
  })
})
