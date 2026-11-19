import React, { createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'
import { useMobileProjectCreation } from './useMobileProjectCreation'
vi.mock('expo-crypto', () => ({ randomUUID: () => 'project-uuid' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(() => renderer?.unmount())
})
async function setup() {
  const devices = { current: [] as DeviceInfo[] }
  devices.current = [
    {
      id: 1,
      device_id: 'same-host',
      execution_target_id: 'app-record-11',
      name: 'Computer',
      status: 'online',
      device_type: 'app',
      bind_shell: 'claudecode',
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
      },
    },
  ]
  const workspace = {
    deviceId: 'app-record-11',
    deviceName: 'Computer',
    deviceStatus: 'online',
    available: true,
    workspacePath: '/repo',
    tasks: [],
  }
  const api = {
    upsertLocalProject: vi.fn(async () => ({
      accepted: true,
      deviceId: 'app-record-11',
      projectKey: 'project-uuid',
      name: 'Project',
      roots: ['/repo'],
    })),
  }
  const reloadWork = vi.fn(async (): Promise<RuntimeWorkListResponse> => ({
    projects: [
      { project: { key: 'project-uuid', name: 'Project' }, deviceWorkspaces: [workspace] },
    ],
    chats: [],
    totalTasks: 0,
  }))
  const publishSelectedDevice = vi.fn(),
    startNewConversation = vi.fn(),
    setError = vi.fn(),
    setLoading = vi.fn()
  let createProject!: ReturnType<typeof useMobileProjectCreation>
  function Harness() {
    createProject = useMobileProjectCreation({
      api: api as unknown as RuntimeApi,
      devices,
      reloadWork,
      publishSelectedDevice,
      startNewConversation,
      setError,
      setLoading,
    })
    return null
  }
  await act(() => {
    renderer = create(<Harness />)
  })
  return {
    createProject,
    devices,
    api,
    reloadWork,
    startNewConversation,
    setError,
    setLoading,
    workspace,
  }
}
describe('mobile uses PC atomic project creation', () => {
  it('creates and names a project on the exact opted-in computer installation', async () => {
    const state = await setup()
    await state.createProject({
      deviceId: 'app-record-11',
      workspacePath: ' /repo ',
      name: ' Project ',
    })
    expect(state.api.upsertLocalProject).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'app-record-11',
      projectKey: 'project-uuid',
      roots: ['/repo'],
      name: 'Project',
      runtime: 'codex',
    })
    expect(state.startNewConversation).toHaveBeenCalledWith(state.workspace)
  })
  it('rejects another installation and revoked consent before any write', async () => {
    const state = await setup()
    await expect(
      state.createProject({ deviceId: 'app-record-22', workspacePath: '/repo', name: '' })
    ).rejects.toThrow('设备')
    state.devices.current![0]!.runtime_features!.remoteTaskAccess!.enabled = false
    await expect(
      state.createProject({ deviceId: 'app-record-11', workspacePath: '/repo', name: '' })
    ).rejects.toThrow('设备')
    expect(state.api.upsertLocalProject).not.toHaveBeenCalled()
  })
  it('keeps accepted creation successful when the subsequent list read fails', async () => {
    const state = await setup()
    state.reloadWork.mockRejectedValue(new Error('List failed'))
    await expect(
      state.createProject({ deviceId: 'app-record-11', workspacePath: '/repo', name: '' })
    ).resolves.toBeUndefined()
    expect(state.api.upsertLocalProject).toHaveBeenCalledTimes(1)
    expect(state.startNewConversation).not.toHaveBeenCalled()
    expect(state.setError).toHaveBeenCalledExactlyOnceWith(null)
    expect(state.setLoading).toHaveBeenLastCalledWith(false)
  })
})
