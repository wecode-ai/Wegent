import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { DeviceInfo } from '@/types/devices'
import { useCurrentAgentDevice } from './useCurrentAgentDevice'

type DeviceApi = Parameters<typeof useCurrentAgentDevice>[0]
type PluginApi = Parameters<typeof useCurrentAgentDevice>[1]
const device = (id: string) =>
  ({
    device_id: id,
    name: id,
    device_type: 'local',
    status: 'online',
    is_default: true,
  }) as DeviceInfo

test('loads capabilities only after choosing a device and refreshes plugins without rediscovering devices', async () => {
  let finish!: (devices: DeviceInfo[]) => void
  const listDevices = vi.fn(
    () =>
      new Promise<DeviceInfo[]>(resolve => {
        finish = resolve
      })
  )
  const listSkills = vi.fn().mockResolvedValue([{}, {}])
  const api = { listDevices, listSkills } as unknown as DeviceApi
  const first = {
    listPlugins: vi.fn().mockResolvedValue([{ pluginName: 'first' }]),
  } as unknown as PluginApi
  const second = {
    listPlugins: vi.fn().mockResolvedValue([{ pluginName: 'second' }]),
  } as unknown as PluginApi
  const { result, rerender } = renderHook(({ plugins }) => useCurrentAgentDevice(api, plugins), {
    initialProps: { plugins: first },
  })
  expect(listSkills).not.toHaveBeenCalled()
  expect(first!.listPlugins).not.toHaveBeenCalled()
  await act(async () => finish([device('local')]))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.currentDevice?.id).toBe('local')
  expect(result.current.capabilityItems).toContain('first')
  rerender({ plugins: second })
  await waitFor(() => expect(result.current.capabilityItems).toContain('second'))
  expect(result.current.capabilityItems).not.toContain('first')
  expect(listDevices).toHaveBeenCalledTimes(1)
})

test('isolates an API replacement and rejects the previous device response', async () => {
  let finish!: (devices: DeviceInfo[]) => void
  const oldSkills = vi.fn().mockResolvedValue([])
  const oldApi = {
    listDevices: vi.fn(
      () =>
        new Promise<DeviceInfo[]>(resolve => {
          finish = resolve
        })
    ),
    listSkills: oldSkills,
  } as unknown as DeviceApi
  const nextApi = {
    listDevices: vi.fn().mockResolvedValue([device('new')]),
    listSkills: vi.fn().mockResolvedValue([]),
  } as unknown as DeviceApi
  const { result, rerender } = renderHook(({ api }) => useCurrentAgentDevice(api), {
    initialProps: { api: oldApi },
  })
  rerender({ api: nextApi })
  await waitFor(() => expect(result.current.currentDevice?.id).toBe('new'))
  await act(async () => finish([device('old')]))
  expect(result.current.currentDevice?.id).toBe('new')
  expect(oldSkills).not.toHaveBeenCalled()
})

test('does not read catalogs until the feature is enabled', async () => {
  const api = {
    listDevices: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn(),
  } as unknown as DeviceApi
  const { result, rerender } = renderHook(
    ({ enabled }) => useCurrentAgentDevice(api, undefined, enabled),
    { initialProps: { enabled: false } }
  )
  expect(api!.listDevices).not.toHaveBeenCalled()
  rerender({ enabled: true })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.currentDevice).toBeNull()
  expect(api!.listSkills).not.toHaveBeenCalled()
})
