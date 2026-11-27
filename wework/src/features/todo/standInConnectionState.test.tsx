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
import { parseStandInEntry } from './standInEntry'
import { newStandInRole } from '@/api/personalStandIn'

const devices: DeviceInfo[] = []
const account = { userId: 1, backendUrl: 'https://current.example/api' }

it('matches account IDs and preserves the installation-local owner', () => {
  expect(isStandInBindingOwner(1, 1)).toBe(true)
  expect(isStandInBindingOwner(1, 2)).toBe(false)
  expect(isStandInBindingOwner(1, 0)).toBe(false)
  expect(isStandInBindingOwner(0, 0)).toBe(true)
  expect(isStandInBindingOwner(0, 2)).toBe(true)
})

it.each([true, false])(
  'preserves the binding behavior for requireSetupConfirmation=%s',
  async requireSetupConfirmation => {
    const settings: PersonalStandInSettings = {
      version: 1,
      executionDeviceId: 'local',
      userId: account.userId,
      roles: [],
    }
    const binding = vi
      .fn<StandInExecutorApi['binding']>()
      .mockResolvedValueOnce({ status: 'unbound', version: 2, target: null })
      .mockResolvedValueOnce({
        status: 'active',
        version: 3,
        target: { ...account, deviceId: 'local' },
      })
    const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>().mockResolvedValue(settings)
    const services = {
      standInApi: { binding, lifecycle, personalGet: async () => settings },
      getLocalRuntimeSidebarIdentity: async () =>
        ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useStandInInstance(services, account.userId, devices, true, true, account.backendUrl, {
        requireSetupConfirmation,
      })
    )

    if (requireSetupConfirmation) {
      await waitFor(() => expect(result.current.setupTarget?.deviceId).toBe('local'))
      expect(result.current.binding?.status).toBe('unbound')
      expect(binding.mock.calls).toEqual([['local']])
      expect(lifecycle).not.toHaveBeenCalled()
      await act(() => result.current.setup())
    }

    await waitFor(() => expect(result.current.binding?.status).toBe('active'))
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith(account.userId, 'local', 'start')
  }
)

it.each([
  ['deviceId=local', 'local', undefined],
  ['deviceId=cloud&profileId=%40primary&settingsRequest=1', 'cloud', undefined],
  ['deviceId=other', undefined, 'forbidden'],
  ['deviceId=cloud&userId=2&settingsRequest=1', undefined, 'forbidden'],
  ['deviceId=cloud&profileId=missing&settingsRequest=1', undefined, 'not_found'],
  ['deviceId=cloud&profileId=reviewer&settingsRequest=1', 'cloud', undefined],
  ['deviceId=cloud', undefined, 'ambiguous'],
])(
  'resolves legacy link %s before binding an unbound assistant',
  async (query, expected, error) => {
    const settings: PersonalStandInSettings = {
      version: 0,
      executionDeviceId: 'local',
      userId: account.userId,
      roles: [],
    }
    const binding = vi
      .fn<StandInExecutorApi['binding']>()
      .mockResolvedValueOnce({ status: 'unbound', version: 0, target: null })
      .mockImplementationOnce(async (_id, _action, _version, target) => ({
        status: 'active',
        version: 1,
        target: target ?? null,
      }))
    const lifecycle = vi.fn(async () => settings)
    const personalGet = vi.fn(async (_userId: number, deviceId: string) => ({
      ...settings,
      executionDeviceId: deviceId,
      roles: deviceId === 'cloud' ? [newStandInRole(deviceId, 'reviewer')] : [],
    }))
    const services = {
      standInApi: { binding, lifecycle, personalGet },
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
    } as unknown as WorkbenchServices
    const cloudDevices: DeviceInfo[] = [
      {
        id: 2,
        device_id: 'cloud',
        name: 'Cloud',
        device_type: 'cloud',
        bind_shell: 'claudecode',
        status: 'online',
        is_default: true,
      },
    ]
    const entry = parseStandInEntry(`/stand-in?${query}`)
    const { result } = renderHook(() =>
      useStandInInstance(services, account.userId, cloudDevices, true, true, account.backendUrl, {
        requireSetupConfirmation: false,
        entry,
      })
    )

    if (error) {
      await waitFor(() => expect(result.current.entryError).toBe(error))
      expect(result.current.binding?.status).toBe('unbound')
      expect(binding.mock.calls).toEqual([['local']])
      expect(lifecycle).not.toHaveBeenCalled()
      if (error === 'forbidden') expect(personalGet).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(result.current.binding?.status).toBe('active'))
      expect(result.current.binding?.target).toEqual({ ...account, deviceId: expected })
      expect(lifecycle).toHaveBeenCalledExactlyOnceWith(account.userId, expected, 'start')
    }
  }
)

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

it('reads legacy bindings without migration and only offers the stopped profile of the same user ID', async () => {
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
  const legacyTarget = {
    ...account,
    deviceId: 'first',
    username: 'previous-name',
    backendUrl: 'https://previous.example/api',
  }
  const original: StandInInstanceBinding = {
    status: 'stopped',
    version: 3,
    target: legacyTarget,
  }
  binding.mockResolvedValue(original)
  const services = {
    standInApi: { binding, personalGet } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
  } satisfies Partial<WorkbenchServices>
  const { result } = renderHook(() =>
    useStandInInstance(
      services as WorkbenchServices,
      account.userId,
      devices,
      true,
      true,
      account.backendUrl
    )
  )
  await waitFor(() => expect(result.current.stoppedProfile).toBe(first))
  expect(result.current.binding).toEqual(original)
  expect(binding.mock.calls).toEqual([['local']])

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
    target: { ...account, userId: 2, deviceId: 'first' },
  })
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.version).toBe(7))
  expect(result.current.stoppedProfile).toBeUndefined()
  expect(personalGet).toHaveBeenCalledTimes(3)
})
