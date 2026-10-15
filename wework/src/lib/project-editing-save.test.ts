import { expect, test } from 'vitest'
import type { DeviceInfo, RuntimeProjectWork, RuntimeWorkListResponse } from '@/types/api'
import { qualifyLocalRuntimeSource } from './local-runtime-sidebar-identity'
import { findOwnedRuntimeProject } from './project-editing-save'

const identity = {
  deviceId: 'native-ipc',
  runtimeInstanceId: 'native-runtime',
  provenance: 'local-ipc' as const,
}
const native = qualifyLocalRuntimeSource<DeviceInfo>(
  {
    id: 0,
    device_id: identity.deviceId,
    runtime_instance_id: identity.runtimeInstanceId,
    name: 'Native',
    status: 'online',
    device_type: 'local',
    is_default: true,
  },
  identity
)
const remote: DeviceInfo = {
  id: 1,
  device_id: 'canonical-remote',
  socket_device_id: identity.deviceId,
  runtime_instance_id: 'remote-runtime',
  name: 'Remote',
  status: 'online',
  device_type: 'remote',
  is_default: false,
}

function project(owner: DeviceInfo, id: number): RuntimeProjectWork {
  const local = owner.device_type === 'local'
  const work: RuntimeProjectWork = {
    project: {
      id,
      key: 'same-project-key',
      name: owner.name,
      source: 'local_project',
      ownerDeviceId: owner.device_id,
      ownerProjectKey: 'same-project-key',
    },
    deviceWorkspaces: [
      {
        deviceId: owner.device_id,
        workspacePath: `/workspace/${owner.name.toLowerCase()}`,
        workspaceSource: local ? 'local' : 'remote',
        mapped: true,
        available: true,
        tasks: [],
      },
    ],
    totalTasks: 0,
  }
  if (local) work.project = qualifyLocalRuntimeSource(work.project, identity)
  return work
}

function runtimeWork(projects: RuntimeProjectWork[]): RuntimeWorkListResponse {
  return { projects, chats: [], totalTasks: 0 }
}

test('selects the canonical remote owner instead of a same-key native project sharing its alias', () => {
  const nativeProject = project(native, 7)
  const remoteProject = project(remote, 8)
  const work = runtimeWork([nativeProject, remoteProject])

  expect(findOwnedRuntimeProject(work, remote, 'same-project-key', [native, remote])).toBe(
    remoteProject
  )
})

test('rejects duplicate same-key projects on the same owning runtime', () => {
  const work = runtimeWork([project(remote, 7), project(remote, 8)])

  expect(
    findOwnedRuntimeProject(work, remote, 'same-project-key', [native, remote])
  ).toBeUndefined()
})

test('does not trust native provenance attached to a remote project', () => {
  const remoteProject = project(remote, 8)
  remoteProject.project = qualifyLocalRuntimeSource(remoteProject.project, identity)
  remoteProject.project.source = 'remote_project'

  expect(
    findOwnedRuntimeProject(runtimeWork([remoteProject]), remote, 'same-project-key', [
      native,
      remote,
    ])
  ).toBe(remoteProject)
})
