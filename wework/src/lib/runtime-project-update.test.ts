import { expect, test } from 'vitest'
import { updateRuntimeWorkProject } from './runtime-project-update'
import { qualifyLocalRuntimeWork } from './local-runtime-sidebar-identity'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'

const ownerDevices = ['a', 'b'].map(
  (deviceId, index): DeviceInfo => ({
    id: index + 1,
    device_id: deviceId,
    socket_device_id: `socket-${deviceId}`,
    runtime_instance_id: `runtime-${deviceId}`,
    device_type: 'remote',
    name: deviceId,
    status: 'online',
    is_default: false,
  })
)

test('keeps an unrelated proven local owner with the same project key when projecting remote defaults', () => {
  const identity = {
    deviceId: 'shared-address',
    runtimeInstanceId: 'local-current',
    provenance: 'local-ipc' as const,
  }
  const work = qualifyLocalRuntimeWork(
    {
      projects: [
        {
          project: {
            key: 'shared-key',
            name: 'Local',
            source: 'local_project',
            stateDeviceId: identity.deviceId,
            ownerDeviceId: identity.deviceId,
          },
          deviceWorkspaces: [
            { deviceId: identity.deviceId, workspacePath: '/local', available: true, tasks: [] },
          ],
        },
        ...ownerDevices.map(device => ({
          project: {
            key: 'shared-key',
            name: device.name,
            source: 'local_project',
            stateDeviceId: device.device_id,
            ownerDeviceId: device.device_id,
          },
          deviceWorkspaces: [
            { deviceId: device.device_id, workspacePath: '/remote', available: true, tasks: [] },
          ],
        })),
      ],
      chats: [],
      totalTasks: 0,
    },
    identity
  )
  const devices: DeviceInfo[] = [
    {
      id: 3,
      device_id: identity.deviceId,
      runtime_instance_id: identity.runtimeInstanceId,
      device_type: 'local',
      name: 'Local',
      status: 'online',
      is_default: true,
    },
    {
      id: 4,
      device_id: 'historical-remote',
      app_device_id: identity.deviceId,
      runtime_instance_id: 'historical',
      device_type: 'remote',
      name: 'Historical',
      status: 'offline',
      is_default: false,
    },
    ...ownerDevices,
  ]
  const next = updateRuntimeWorkProject(
    work,
    {
      deviceId: 'socket-b',
      projectKey: 'shared-key',
      name: 'Saved remote',
      roots: ['/remote'],
      aiSettings: { modelSelection: { modelName: 'remote-model' } },
      defaultProjectSpace: null,
    },
    devices
  )
  expect(next.projects[0]).toBe(work.projects[0])
  expect(next.projects[1]).toBe(work.projects[1])
  expect(next.projects[2].project.aiSettings).toEqual({
    modelSelection: { modelName: 'remote-model' },
  })
  const mirror = qualifyLocalRuntimeWork(
    {
      ...work,
      projects: [
        {
          ...work.projects[0],
          project: { ...work.projects[0].project, source: 'remote_project', kind: 'remote' },
          deviceWorkspaces: [
            {
              ...work.projects[0].deviceWorkspaces[0],
              remoteHostId: 'a',
              workspaceSource: 'remote',
            },
          ],
        },
        ...work.projects.slice(1),
      ],
    },
    identity
  )
  expect(() =>
    updateRuntimeWorkProject(
      mirror,
      {
        deviceId: 'socket-b',
        projectKey: 'shared-key',
        name: 'Saved remote',
        roots: ['/remote'],
        aiSettings: null,
        defaultProjectSpace: null,
      },
      devices
    )
  ).toThrow('ambiguous-executor-identity:shared-address')
})

test('projects confirmed defaults across proven owner aliases without rewriting execution addresses', () => {
  const work: RuntimeWorkListResponse = {
    projects: ownerDevices.map(device => ({
      project: {
        key: 'shared-key',
        name: device.name,
        source: 'remote_project',
        ownerDeviceId: device.device_id,
        ownerProjectKey: 'shared-key',
        sidebarStateKey: `mirror-${device.device_id}`,
      },
      deviceWorkspaces: [
        {
          deviceId: device.device_id,
          remoteHostId: device.device_id,
          workspacePath: '/old',
          available: true,
          tasks: [],
        },
      ],
    })),
    chats: [],
    totalTasks: 0,
  }
  const settings = {
    modelSelection: { modelName: 'project-model', modelType: 'runtime' as const },
    quickPhrases: [
      {
        id: 'review',
        title: 'Review project',
        content: 'Review this project',
        mode: 'normal' as const,
      },
    ],
  }
  const next = updateRuntimeWorkProject(
    work,
    {
      deviceId: 'socket-b',
      projectKey: 'shared-key',
      name: 'Edited',
      roots: ['/new'],
      defaultProjectSpace: null,
      aiSettings: settings,
      source: 'local_project',
    },
    ownerDevices
  )
  expect(next.projects[0]).toBe(work.projects[0])
  expect(next.projects[1].project.aiSettings).toEqual(settings)
  expect(next.projects[1].project.ownerDeviceId).toBe('b')
  expect(next.projects[1].deviceWorkspaces[0].remoteHostId).toBe('b')
  expect(next.projects[1].project.source).toBe('remote_project')
  expect(next.projects[1].project.sidebarStateKey).toBe('mirror-b')
})

test('promotes a legacy directory only with confirmed owner source while preserving its sidebar identity', () => {
  const projectWork: RuntimeWorkListResponse['projects'][number] = {
    project: {
      id: 7,
      key: 'project-key',
      name: 'Directory',
      source: 'legacy_root',
      stateDeviceId: 'b',
      ownerDeviceId: 'b',
      pinned: true,
      sidebarOrder: 3,
    },
    deviceWorkspaces: [
      {
        deviceId: 'b',
        workspacePath: '/old',
        available: true,
        tasks: [
          {
            taskId: 'existing',
            title: 'Existing',
            workspacePath: '/old',
            runtime: 'codex',
            modelSelection: { modelName: 'old-model' },
          },
        ],
      },
    ],
  }
  const work = { projects: [projectWork], chats: [], totalTasks: 1 }
  const update = {
    deviceId: 'socket-b',
    projectKey: 'project-key',
    name: 'Project',
    roots: ['/old'],
    aiSettings: { modelSelection: { modelName: 'project-model' } },
    defaultProjectSpace: null,
  }
  expect(updateRuntimeWorkProject(work, update, ownerDevices).projects[0].project.source).toBe(
    'legacy_root'
  )
  const next = updateRuntimeWorkProject(work, { ...update, source: 'local_project' }, ownerDevices)
  expect(next.projects[0].project).toMatchObject({
    id: 7,
    key: 'project-key',
    stateDeviceId: 'b',
    pinned: true,
    sidebarOrder: 3,
    source: 'local_project',
  })
  expect(next.projects[0].deviceWorkspaces[0].tasks).toBe(projectWork.deviceWorkspaces[0].tasks)
})

test('rejects an ambiguous update alias instead of projecting unproven defaults', () => {
  const devices = ownerDevices.map(device => ({ ...device, socket_device_id: 'shared-alias' }))
  expect(() =>
    updateRuntimeWorkProject(
      { projects: [], chats: [], totalTasks: 0 },
      {
        deviceId: 'shared-alias',
        projectKey: 'shared-key',
        name: 'Edited',
        roots: ['/new'],
        defaultProjectSpace: null,
        aiSettings: null,
      },
      devices
    )
  ).toThrow('ambiguous-executor-identity:shared-alias')
})

test('updates only the owning device while keeping existing conversation snapshots', () => {
  const work: RuntimeWorkListResponse = {
    projects: ['a', 'b'].map(deviceId => ({
      project: {
        key: 'same-key',
        name: deviceId,
        ownerDeviceId: deviceId,
        roots: [{ kind: 'local', path: '/old' }],
      },
      deviceWorkspaces: [
        {
          deviceId,
          workspacePath: '/old',
          available: true,
          mapped: true,
          tasks: [
            {
              taskId: deviceId,
              title: 'Existing',
              workspacePath: '/old',
              runtime: 'codex',
              projectPluginIds: ['old'],
            },
          ],
        },
      ],
    })),
    chats: [],
    totalTasks: 2,
  }
  const next = updateRuntimeWorkProject(work, {
    deviceId: 'b',
    projectKey: 'same-key',
    name: 'Updated',
    roots: ['/new', '/second'],
    defaultProjectSpace: null,
    aiSettings: { instructions: 'New' },
  })
  expect(next.projects[0]).toBe(work.projects[0])
  expect(next.projects[1].project.name).toBe('Updated')
  expect(next.projects[1].deviceWorkspaces[0].workspacePath).toBe('/new')
  expect(next.projects[1].deviceWorkspaces[0].tasks).toBe(
    work.projects[1].deviceWorkspaces[0].tasks
  )
  expect(next.projects[1].deviceWorkspaces[0].tasks[0].workspacePath).toBe('/old')
})

test('preserves a registered worktree workspace when the project primary root changes', () => {
  const worktree = {
    deviceId: 'device',
    workspacePath: '/trees/existing',
    workspaceKind: 'worktree',
    worktreeId: 'tree',
    available: true,
    tasks: [],
  }
  const work: RuntimeWorkListResponse = {
    projects: [
      {
        project: { key: 'project', name: 'Project', stateDeviceId: 'device' },
        deviceWorkspaces: [
          worktree,
          {
            deviceId: 'device',
            workspacePath: '/old',
            workspaceKind: 'workspace',
            available: true,
            tasks: [],
          },
        ],
      },
    ],
    chats: [],
    totalTasks: 0,
  }
  const next = updateRuntimeWorkProject(work, {
    deviceId: 'device',
    projectKey: 'project',
    name: 'Project',
    roots: ['/new'],
    defaultProjectSpace: null,
    aiSettings: null,
  })
  expect(next.projects[0].deviceWorkspaces[0]).toBe(worktree)
  expect(next.projects[0].deviceWorkspaces[1].workspacePath).toBe('/new')
})
