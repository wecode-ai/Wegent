import { describe, expect, test } from 'vitest'
import type { DeviceInfo, RuntimeProjectWork, RuntimeWorkListResponse } from '@/types/api'
import { buildRuntimeRemoteProjectStateId } from '@/lib/runtime-project-identity'
import { mergeRuntimeWorkLists } from './runtimeWorkMerge'

const device: DeviceInfo = {
  id: 1,
  device_id: 'executor',
  socket_device_id: 'relay',
  runtime_instance_id: 'runtime',
  name: 'Remote executor',
  status: 'online',
  device_type: 'remote',
  is_default: false,
}
const context = { devices: [device] }
const list = (...projects: RuntimeProjectWork[]): RuntimeWorkListResponse => ({
  projects,
  chats: [],
  totalTasks: 0,
})
function project(key = 'project-a', deviceId = 'executor'): RuntimeProjectWork {
  return {
    project: {
      id: key === 'project-a' ? 1 : 2,
      key,
      name: key,
      source: 'local_project',
      stateDeviceId: deviceId,
    },
    deviceWorkspaces: [
      {
        deviceId,
        workspacePath: '/srv/work',
        workspaceKind: 'worktree',
        workspaceSource: 'local',
        mapped: true,
        available: true,
        tasks: [],
      },
    ],
  }
}
function reference(key: string | null = 'project-a'): RuntimeProjectWork {
  const stateKey = key ? buildRuntimeRemoteProjectStateId('relay', key) : 'external-sidebar-entry'
  return {
    project: {
      id: 10,
      key: stateKey,
      sidebarStateKey: stateKey,
      name: 'Saved label',
      source: 'remote_project',
      kind: 'remote',
      stateDeviceId: 'viewer',
      pinned: true,
      pinnedOrder: 0,
      sidebarOrder: 3,
    },
    deviceWorkspaces: [
      {
        deviceId: 'relay',
        remoteHostId: 'relay',
        workspacePath: '/srv/work',
        workspaceKind: 'workspace',
        workspaceSource: 'remote',
        mapped: true,
        available: false,
        tasks: [],
      },
    ],
  }
}

describe('runtime project identity', () => {
  test.each([true, false])(
    'joins a sidebar reference in either input order (reference first: %s)',
    referenceFirst => {
      const bookmark = reference(null)
      const native = project()
      native.deviceWorkspaces[0].tasks = [
        { taskId: 'task', title: 'Task', runtime: 'codex', workspacePath: '/srv/work' },
      ]
      const inputs = referenceFirst
        ? [list(bookmark), list(native)]
        : [list(native), list(bookmark)]
      const merged = mergeRuntimeWorkLists(inputs[0], inputs[1], context)
      expect(merged.projects).toHaveLength(1)
      expect(merged.projects[0].project).toMatchObject({
        id: 10,
        key: 'project-a',
        name: 'Saved label',
        stateDeviceId: 'viewer',
        sidebarStateKey: bookmark.project.key,
        pinned: true,
        sidebarOrder: 3,
      })
      expect(merged.projects[0].deviceWorkspaces).toEqual([
        expect.objectContaining({
          deviceId: 'executor',
          remoteHostId: 'relay',
          workspaceKind: 'worktree',
          available: true,
          tasks: [expect.objectContaining({ taskId: 'task' })],
        }),
      ])
      expect(merged.totalTasks).toBe(1)
      expect(mergeRuntimeWorkLists(merged, list(native), context)).toEqual(merged)
    }
  )

  test('preserves different named projects sharing a directory and colliding UI ids', () => {
    const first = project('project-a')
    const second = project('project-b')
    second.project.id = first.project.id
    const merged = mergeRuntimeWorkLists(list(first), list(second), context)
    expect(merged.projects.map(work => work.project.key)).toEqual(['project-a', 'project-b'])
  })

  test('resolves an explicit target key when several projects share its path', () => {
    const merged = mergeRuntimeWorkLists(
      list(reference('project-b')),
      list(project(), project('project-b')),
      context
    )
    expect(merged.projects).toHaveLength(2)
    const linked = merged.projects.find(work => work.project.key === 'project-b')!
    expect(linked.project).toMatchObject({
      name: 'Saved label',
      pinned: true,
      sidebarStateKey: reference('project-b').project.key,
    })
    expect(merged.projects.find(work => work.project.key === 'project-a')?.project.source).toBe(
      'local_project'
    )
  })

  test('does not guess the target of an ambiguous external directory reference', () => {
    const merged = mergeRuntimeWorkLists(
      list(reference(null)),
      list(project(), project('project-b')),
      context
    )
    expect(merged.projects).toHaveLength(3)
    expect(
      merged.projects.find(work => work.project.source === 'remote_project')?.project.key
    ).toBe('external-sidebar-entry')
  })

  test('does not attach a missing explicit target to another project at the same path', () => {
    const merged = mergeRuntimeWorkLists(
      list(reference('deleted-project')),
      list(project()),
      context
    )
    expect(merged.projects).toHaveLength(2)
  })

  test('matches an explicit project reference after its directory changes', () => {
    const native = project()
    native.deviceWorkspaces[0].workspacePath = '/srv/moved'
    const merged = mergeRuntimeWorkLists(list(reference()), list(native), context)
    expect(merged.projects).toHaveLength(1)
    expect(merged.projects[0].deviceWorkspaces[0].workspacePath).toBe('/srv/moved')
  })

  test('keeps the same project key and path on different executors separate', () => {
    const merged = mergeRuntimeWorkLists(
      list(project()),
      list(project('project-a', 'other-executor')),
      context
    )
    expect(merged.projects).toHaveLength(2)
  })

  test.each([
    { runtimeId: 'runtime', expectedProjects: 1 },
    { runtimeId: 'other-runtime', expectedProjects: 2 },
  ])(
    'compares persisted executor identity for identical projects from separate routes ($runtimeId)',
    ({ runtimeId, expectedProjects }) => {
      const local = { ...device, device_id: 'local', device_type: 'local' as const }
      const remote = {
        ...device,
        device_id: 'cloud-route',
        socket_device_id: 'cloud-socket',
        runtime_instance_id: runtimeId,
      }
      const first = list(project('project-a', local.device_id))
      const second = list(project('project-a', remote.device_id))
      for (const [primary, secondary] of [
        [first, second],
        [second, first],
      ]) {
        const merged = mergeRuntimeWorkLists(primary, secondary, { devices: [local, remote] })
        expect(merged.projects).toHaveLength(expectedProjects)
        expect(merged.projects.every(work => work.deviceWorkspaces.length === 1)).toBe(true)
      }
    }
  )

  test('treats workspace kind as metadata when reconciling the same named project', () => {
    const first = project()
    const second = project()
    second.deviceWorkspaces[0].workspaceKind = 'workspace'
    second.deviceWorkspaces[0].workspacePath += '/'
    const merged = mergeRuntimeWorkLists(list(first), list(second), context)
    expect(merged.projects).toHaveLength(1)
    expect(merged.projects[0].deviceWorkspaces).toHaveLength(1)
  })

  test('preserves an external host reference without inventing an executor mapping', () => {
    const external = reference(null)
    external.deviceWorkspaces[0].remoteHostId = 'remote-ssh-codex-managed:host'
    external.deviceWorkspaces[0].deviceId = 'remote-ssh-codex-managed:host'
    const merged = mergeRuntimeWorkLists(list(external), list(project()), context)
    expect(merged.projects).toHaveLength(2)
    expect(
      merged.projects.find(work => work.project.source === 'remote_project')?.deviceWorkspaces[0]
    ).toMatchObject({
      remoteHostId: 'remote-ssh-codex-managed:host',
      available: false,
    })
  })
})
