import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInInboxWork, StandInInstanceBinding } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useStandInInbox } from './useStandInInbox'
import { useStandInInstance } from './useStandInInstance'

const devices: DeviceInfo[] = []

it('keeps old inbox items hidden while the same owner and device load on a new connection', async () => {
  const item: StandInInboxWork = {
    id: 'work',
    taskId: 'task',
    roleId: 'role',
    title: 'First connection only',
    source: {
      providerId: 'test',
      id: 'source',
      profile: 'profile',
      name: 'Source',
      kind: 'message',
      policy: { automatic: false, askBeforeAct: true },
    },
    status: 'pending',
    updatedAt: '2026-11-18T00:00:00Z',
    messageCount: 0,
    latestMessage: null,
  }
  const inbox = vi
    .fn<StandInExecutorApi['inbox']>()
    .mockResolvedValueOnce({ items: [item], sourceErrors: [] })
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValueOnce({ items: [], sourceErrors: [] })
  const api = { inbox } as unknown as StandInExecutorApi
  const { result, rerender } = renderHook(
    ({ connection }) => useStandInInbox(api, 1, 'device', true, connection),
    { initialProps: { connection: 'https://first.example' } }
  )
  await waitFor(() => expect(result.current.items).toEqual([item]))

  rerender({ connection: 'https://second.example' })
  expect(result.current.items).toEqual([])
  expect(result.current.scope).toBeUndefined()

  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.scope).toBeDefined())
  expect(result.current.items).toEqual([])
})

it('only offers the stopped profile belonging to the current binding', async () => {
  const first: PersonalStandInSettings = {
    version: 1,
    executionDeviceId: 'first',
    userId: 1,
    roles: [],
    lifecycle: { status: 'stopped' },
  }
  const binding = vi.fn<StandInExecutorApi['binding']>()
  const personalGet = vi
    .fn<StandInExecutorApi['personalGet']>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(first)
  const original: StandInInstanceBinding = {
    status: 'stopped',
    version: 3,
    target: { userId: 1, deviceId: 'first' },
  }
  binding.mockResolvedValue(original)
  const services = {
    standInApi: { binding, personalGet } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
  } satisfies Partial<WorkbenchServices>
  const { result } = renderHook(() =>
    useStandInInstance(services as WorkbenchServices, 1, devices, true, true)
  )
  await waitFor(() => expect(result.current.stoppedProfile).toBe(first))

  act(() => result.current.reload())
  expect(result.current.stoppedProfile).toBe(first)
  await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))

  binding.mockResolvedValueOnce({
    status: 'stopped',
    version: 6,
    target: { userId: 1, deviceId: 'second' },
  })
  personalGet.mockRejectedValueOnce(new Error('Second device unavailable'))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('second'))
  expect(result.current.stoppedProfile).toBeUndefined()
  await waitFor(() => expect(result.current.error).toBeTruthy())
})
