import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import {
  isStandInBindingOwner,
  type StandInExecutorApi,
  type StandInInboxWork,
  type StandInInstanceBinding,
} from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useStandInInbox } from './useStandInInbox'
import { useStandInInstance } from './useStandInInstance'

const devices: DeviceInfo[] = []
const account = { userId: 1, username: 'alice', backendUrl: 'https://current.example/api' }

it('matches ordinary accounts across addresses and keeps admin and legacy bindings at their original address', () => {
  const target = { ...account, deviceId: 'device' }
  const alias = { ...account, backendUrl: 'https://alias.example/api' }
  expect(isStandInBindingOwner(target, alias)).toBe(true)
  expect(isStandInBindingOwner(target, { ...account, username: 'other' })).toBe(false)
  expect(isStandInBindingOwner(target, { ...account, userId: 2 })).toBe(false)
  expect(
    isStandInBindingOwner({ ...target, username: 'admin' }, { ...account, username: 'admin' })
  ).toBe(true)
  expect(
    isStandInBindingOwner({ ...target, username: 'admin' }, { ...alias, username: 'admin' })
  ).toBe(false)
  expect(isStandInBindingOwner({ ...target, username: undefined }, account)).toBe(true)
  expect(isStandInBindingOwner({ ...target, username: undefined }, alias)).toBe(false)
})

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
    target: { ...account, deviceId: 'first', backendUrl: 'https://previous.example/api' },
  }
  binding.mockResolvedValue(original)
  const services = {
    standInApi: { binding, personalGet } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
  } satisfies Partial<WorkbenchServices>
  const { result } = renderHook(() =>
    useStandInInstance(services as WorkbenchServices, account, devices, true, true)
  )
  await waitFor(() => expect(result.current.stoppedProfile).toBe(first))

  act(() => result.current.reload())
  expect(result.current.stoppedProfile).toBe(first)
  await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))

  binding.mockResolvedValueOnce({
    status: 'stopped',
    version: 6,
    target: { ...account, deviceId: 'second' },
  })
  personalGet.mockRejectedValueOnce(new Error('Second device unavailable'))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('second'))
  expect(result.current.stoppedProfile).toBeUndefined()
  await waitFor(() => expect(result.current.error).toBeTruthy())

  binding.mockResolvedValueOnce({
    status: 'stopped',
    version: 7,
    target: { ...account, username: 'different-account', deviceId: 'first' },
  })
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.version).toBe(7))
  expect(result.current.stoppedProfile).toBeUndefined()
  expect(personalGet).toHaveBeenCalledTimes(3)
})
