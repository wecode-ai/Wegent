import { describe, expect, test } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import {
  buildRuntimeRemoteProjectStateId,
  findActiveRuntimeProjectId,
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectActivation,
  getRuntimeProjectReorderRequest,
  getRuntimeRemoteProjectRegistrations,
  parseRuntimeRemoteProjectStateId,
} from './runtime-project-state'

const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: { key: '/repo/local', id: 1, name: 'Local', active: false },
      deviceWorkspaces: [
        {
          id: null,
          projectId: null,
          deviceId: 'local-device',
          workspacePath: '/repo/local',
          available: true,
          mapped: true,
          tasks: [],
        },
      ],
    },
    {
      project: {
        key: '/srv/remote',
        sidebarStateKey: 'remote-project-id',
        id: 2,
        name: 'Remote',
        kind: 'remote',
        source: 'remote_project',
        active: true,
      },
      deviceWorkspaces: [
        {
          id: null,
          projectId: null,
          deviceId: 'remote-device',
          remoteHostId: 'remote-device',
          workspacePath: '/srv/remote',
          workspaceSource: 'remote',
          available: true,
          mapped: true,
          tasks: [],
        },
      ],
    },
  ],
  chats: [],
  totalTasks: 0,
}

describe('runtime project state', () => {
  test('round-trips a remote project state identity', () => {
    const stateId = buildRuntimeRemoteProjectStateId(
      'remote:device',
      'local:/srv/project with spaces'
    )

    expect(stateId).toBe('wegent-remote:remote%3Adevice:local%3A%2Fsrv%2Fproject%20with%20spaces')
    expect(parseRuntimeRemoteProjectStateId(stateId)).toEqual({
      hostId: 'remote:device',
      projectKey: 'local:/srv/project with spaces',
    })
    expect(parseRuntimeRemoteProjectStateId('wegent-remote:remote-device:%E0%A4%A')).toBeNull()
  })

  test('uses only the local executor as the Codex global state owner', () => {
    expect(
      getLocalRuntimeStateDeviceId([
        {
          id: 2,
          device_id: 'remote-device',
          name: 'Remote',
          status: 'online',
          is_default: true,
          device_type: 'remote',
          bind_shell: 'claudecode',
        },
      ])
    ).toBeNull()
  })

  test('registers remote projects using their Codex sidebar identity', () => {
    expect(getRuntimeRemoteProjectRegistrations(runtimeWork, 'local-device')).toEqual([
      {
        id: 'remote-project-id',
        hostId: 'remote-device',
        remotePath: '/srv/remote',
        label: 'Remote',
      },
    ])
  })

  test('routes remote activation through the local Codex state owner', () => {
    expect(getRuntimeProjectActivation(runtimeWork, 2, 'local-device')).toEqual({
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/remote',
      remoteHostId: 'remote-device',
    })
    expect(findActiveRuntimeProjectId(runtimeWork)).toBe(2)
  })

  test('prefers an active remote project over retained local active roots', () => {
    const work = structuredClone(runtimeWork)
    work.projects[0].project.active = true

    expect(findActiveRuntimeProjectId(work)).toBe(2)
  })

  test('reorders remote and local projects through the local Codex state owner', () => {
    expect(
      getRuntimeProjectReorderRequest(
        runtimeWork.projects[1],
        runtimeWork.projects[0],
        'local-device'
      )
    ).toEqual({
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      beforeProjectKey: '/repo/local',
      insertAtEnd: false,
    })
  })
})
