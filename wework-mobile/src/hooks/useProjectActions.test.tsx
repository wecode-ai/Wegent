import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RuntimeProjectWork } from '@/types/runtime'
import {
  projectMetadataWorkspace,
  projectMutationTargets,
  useProjectActions,
} from './useProjectActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const workspace = {
  deviceId: 'computer',
  deviceName: 'Computer',
  deviceStatus: 'online',
  available: true,
  workspacePath: '/repo',
  tasks: [],
}
const project: RuntimeProjectWork = {
  project: {
    key: 'project-key',
    name: 'Project',
    source: 'local_project',
    stateDeviceId: 'computer',
    roots: [{ kind: 'local', path: '/repo' }],
  },
  deviceWorkspaces: [workspace],
}
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(() => renderer?.unmount())
})
async function setup() {
  const api = {
    setProjectPinned: vi.fn(async () => ({ accepted: true })),
    renameWorkspace: vi.fn(async () => ({ accepted: true })),
    removeWorkspace: vi.fn(async () => ({ accepted: true })),
  }
  const reloadWork = vi.fn(async (_deviceId: string) => {})
  let actions!: ReturnType<typeof useProjectActions>
  function Harness() {
    actions = useProjectActions({ api: api as unknown as RuntimeApi, reloadWork })
    return null
  }
  await act(() => {
    renderer = create(<Harness />)
  })
  return { api, reloadWork, actions }
}
describe('PC project management parity', () => {
  it('pins metadata on its state owner with the sidebar key', async () => {
    const { api, actions, reloadWork } = await setup()
    await actions.setProjectPinned(
      {
        ...project,
        project: {
          ...project.project,
          stateDeviceId: 'state-owner',
          sidebarStateKey: 'sidebar-key',
        },
      },
      true
    )
    expect(api.setProjectPinned).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'state-owner',
      projectKey: 'sidebar-key',
      pinned: true,
    })
    expect(reloadWork).toHaveBeenCalledWith('state-owner')
  })
  it('renames and removes the exact project without deleting files or tasks', async () => {
    const { api, actions } = await setup()
    await actions.renameProject(project, 'Renamed')
    await actions.removeProject(project)
    const target = {
      deviceId: 'computer',
      projectKey: 'project-key',
      workspacePath: '/repo',
      runtime: 'codex',
    }
    expect(api.renameWorkspace).toHaveBeenCalledExactlyOnceWith({ ...target, name: 'Renamed' })
    expect(api.removeWorkspace).toHaveBeenCalledExactlyOnceWith(target)
  })
  it('retains PC primary and sidebar mirror identities', () => {
    const remote = {
      ...project,
      project: { ...project.project, stateDeviceId: 'state-owner', sidebarStateKey: 'sidebar-key' },
    }
    expect(projectMutationTargets(remote).mirror).toEqual({
      deviceId: 'state-owner',
      projectKey: 'sidebar-key',
      workspacePath: '/repo',
      runtime: 'codex',
    })
    expect(
      projectMetadataWorkspace({
        ...project,
        deviceWorkspaces: [{ ...workspace, workspacePath: '/worktree' }, workspace],
      })
    ).toBe(workspace)
  })
  it('rejects ambiguous roots across hosts', () => {
    expect(() =>
      projectMetadataWorkspace({
        project: { key: 'ambiguous', name: 'Ambiguous' },
        deviceWorkspaces: [workspace, { ...workspace, deviceId: 'other' }],
      })
    ).toThrow('无法确定项目所属设备')
  })
  it('does not refresh on rejected writes or repeat accepted writes after read failure', async () => {
    const { api, actions, reloadWork } = await setup()
    api.setProjectPinned.mockResolvedValueOnce({ accepted: false })
    await expect(actions.setProjectPinned(project, true)).rejects.toThrow('置顶')
    expect(reloadWork).not.toHaveBeenCalled()
    reloadWork.mockRejectedValue(new Error('Read failed'))
    await expect(actions.removeProject(project)).resolves.toBeUndefined()
    expect(api.removeWorkspace).toHaveBeenCalledTimes(1)
  })
})
