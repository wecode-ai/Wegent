import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  bindProjectStandInApi,
  type StandInExecutorApi,
  type StandInProjectSettings,
} from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useStandInProjects } from './useStandInProjects'

const row: StandInProjectSettings = {
  projectId: 'project',
  projectStore: 'cloud',
  userId: 7,
  enabled: true,
  prompt: '',
  executionDeviceId: 'mac',
  version: 1,
}
function fixture(list = vi.fn<StandInExecutorApi['list']>().mockResolvedValue([row])) {
  const transport: StandInExecutorApi = {
    list,
    get: vi.fn().mockResolvedValue(row),
    save: vi.fn(async (_project, _user, _store, settings) => settings),
  }
  const identity = async () => ({ deviceId: 'mac' })
  const services = {
    standInApi: transport,
    getLocalRuntimeSidebarIdentity: identity,
  } as unknown as WorkbenchServices
  return { services, transport, api: bindProjectStandInApi(transport, 7, 'cloud', identity) }
}

describe('Stand-in sidebar indicators', () => {
  it('retains the project mask while another Stand-in on the same device remains enabled', async () => {
    const { services, api } = fixture(
      vi.fn<StandInExecutorApi['list']>().mockResolvedValue([
        { ...row, id: 'default' },
        { ...row, id: 'review', tags: ['review'] },
      ])
    )
    const { result } = renderHook(() => useStandInProjects(services, undefined, 7))
    await waitFor(() => expect(result.current.has('cloud:project')).toBe(true))
    await act(async () => {
      await api.save('project', { ...row, id: 'default', enabled: false })
    })
    expect(result.current.has('cloud:project')).toBe(true)
    await act(async () => {
      await api.save('project', { ...row, id: 'review', enabled: false })
    })
    expect(result.current.has('cloud:project')).toBe(false)
  })
  it('loads saved device settings and updates immediately after disabling or enabling', async () => {
    const { services, api } = fixture()
    const { result } = renderHook(() => useStandInProjects(services, undefined, 7))
    await waitFor(() => expect(result.current.has('cloud:project')).toBe(true))
    await act(async () => {
      await api.save('project', { ...row, enabled: false })
    })
    expect(result.current.has('cloud:project')).toBe(false)
    await act(async () => {
      await api.save('project', row)
    })
    expect(result.current.has('cloud:project')).toBe(true)
  })

  it('merges a cloud device without losing local configuration if another device fails', async () => {
    const list = vi.fn<StandInExecutorApi['list']>().mockImplementation(async (_user, device) => {
      if (device === 'broken') throw new Error('Offline')
      return [{ ...row, executionDeviceId: device, projectId: device }]
    })
    const { services, transport } = fixture(list)
    const devices = [
      { device_id: 'cloud', status: 'online' },
      { device_id: 'broken', status: 'online' },
    ] as DeviceInfo[]
    const { result } = renderHook(() => useStandInProjects(services, devices, 7))
    await waitFor(() => expect([...result.current].sort()).toEqual(['cloud:cloud', 'cloud:mac']))
    expect(transport.list).toHaveBeenCalledTimes(3)
  })

  it('does not overwrite a recent save with an earlier in-flight device response', async () => {
    let resolve!: (rows: StandInProjectSettings[]) => void
    const list = vi.fn<StandInExecutorApi['list']>().mockImplementation(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const { services, api } = fixture(list)
    const { result } = renderHook(() => useStandInProjects(services, undefined, 7))
    await waitFor(() => expect(list).toHaveBeenCalled())
    await act(async () => {
      await api.save('project', { ...row, enabled: false })
    })
    await act(async () => {
      resolve([row])
    })
    expect(result.current.has('cloud:project')).toBe(false)
  })
})
