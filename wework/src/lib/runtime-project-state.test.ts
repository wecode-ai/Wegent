import {
  buildRuntimeRemoteProjectStateId,
  parseRuntimeRemoteProjectStateId,
} from './runtime-project-identity'
import { describe, expect, test } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import {
  findActiveRuntimeProjectId,
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectActivation,
  getRuntimeProjectReorderRequest,
  getRuntimeRemoteProjectRegistrations,
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

describe('remote project sync identity', () => {
  test('removing one remote project does not suppress the same path on another device or project', () => {
    const remote = structuredClone(runtimeWork.projects[1])
    remote.project.stateDeviceId = 'viewer'
    const otherDevice = structuredClone(remote)
    otherDevice.project.sidebarStateKey = 'other-device-entry'
    otherDevice.deviceWorkspaces[0].deviceId = 'other-device'
    otherDevice.deviceWorkspaces[0].remoteHostId = 'other-device'
    const otherProject = structuredClone(remote)
    otherProject.project.key = 'another-project'
    otherProject.project.sidebarStateKey = 'another-project-entry'
    const work = { projects: [remote, otherDevice, otherProject], chats: [], totalTasks: 0 }
    const registrations = getRuntimeRemoteProjectRegistrations(work, 'viewer', {
      excludedTargets: [{ deviceId: 'remote-device', projectKey: '/srv/remote' }],
    })
    expect(registrations.map(item => item.id)).toEqual([
      'other-device-entry',
      'another-project-entry',
    ])
    expect(registrations.every(item => item.remotePath === '/srv/remote')).toBe(true)
  })

  test('matches a removed project through a known device alias while preserving the external host value', () => {
    const work = structuredClone(runtimeWork)
    work.projects[1].deviceWorkspaces[0].remoteHostId = 'relay'
    const devices = [
      {
        id: 1,
        device_id: 'remote-device',
        socket_device_id: 'relay',
        status: 'online' as const,
        name: 'Remote',
        is_default: false,
        device_type: 'remote' as const,
      },
    ]
    expect(
      getRuntimeRemoteProjectRegistrations(work, 'local-device', {
        devices,
        excludedTargets: [{ deviceId: 'remote-device', projectKey: '/srv/remote' }],
      })
    ).toEqual([])
    expect(getRuntimeRemoteProjectRegistrations(work, 'local-device', { devices })[0].hostId).toBe(
      'relay'
    )
  })

  test('does not register another connection to the local executor as a remote project', () => {
    const work = structuredClone(runtimeWork)
    work.projects = [work.projects[0]]
    work.projects[0].deviceWorkspaces[0].deviceId = 'local-relay'
    const devices = [
      {
        id: 1,
        device_id: 'local-device',
        socket_device_id: 'local-relay',
        status: 'online' as const,
        name: 'Local',
        is_default: false,
        device_type: 'local' as const,
      },
    ]
    expect(getRuntimeRemoteProjectRegistrations(work, 'local-device', { devices })).toEqual([])
    expect(
      getRuntimeProjectActivation(work, 1, 'local-device', devices)?.remoteHostId
    ).toBeUndefined()
  })
})
