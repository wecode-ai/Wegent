import { ApiError } from '@/api/http'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { publishPersonalStandIn, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInInstanceBinding } from '@/api/standIn'
import type { DeviceInfo } from '@/types/api'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useAssistantSourceState } from './useAssistantSources'

const mocks = vi.hoisted(() => ({ workbench: {} as Record<string, unknown> }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))

const userId = 7
const localDeviceId = 'electron-local'
const reference = { name: 'assistant', namespace: 'default' }

function account(deviceId: string): PersonalAssistantAccount {
  return {
    defaultBotRef: reference,
    revision: 'current',
    retiredRoleIds: [],
    definitions: [
      {
        roleId: '@primary',
        bot: {
          metadata: reference,
          spec: { execution_policy: { mode: 'fixed', environment_id: deviceId } },
        },
        ghost: { spec: { systemPrompt: '' } },
      },
    ],
  }
}

function cloudDevice(deviceId: string): DeviceInfo {
  return {
    id: Number(deviceId.split('-').at(-1)),
    device_id: deviceId,
    name: deviceId,
    status: 'online',
    device_type: 'cloud',
    bind_shell: 'claudecode',
    is_default: deviceId === 'cloud-1',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(firstAccount: () => Promise<PersonalAssistantAccount>, devices: DeviceInfo[] = []) {
  const get = vi.fn<() => Promise<PersonalAssistantAccount>>().mockImplementationOnce(firstAccount)
  const localBinding: StandInInstanceBinding = {
    version: 1,
    status: 'active',
    target: { userId, deviceId: localDeviceId },
  }
  const binding = vi.fn(async () => localBinding)
  const personalGet = vi.fn(
    async (ownerId: number, deviceId: string): Promise<PersonalStandInSettings> => ({
      userId: ownerId,
      executionDeviceId: deviceId,
      version: 1,
      roles: [],
    })
  )
  const inbox = vi.fn(async () => ({ items: [], sourceErrors: [] }))
  const services = {
    personalAssistantAccountApi: { get },
    standInApi: { binding, personalGet, inbox },
    getLocalRuntimeSidebarIdentity: async () => ({
      deviceId: localDeviceId,
      runtimeInstanceId: 'runtime',
      provenance: 'local-ipc',
    }),
  }
  const workbench = (nextDevices: DeviceInfo[]) => ({
    services,
    state: { user: { id: userId }, devices: nextDevices },
  })
  mocks.workbench = workbench(devices)
  const hook = renderHook(() => useAssistantSourceState(true, false))
  return {
    ...hook,
    get,
    binding,
    personalGet,
    changeDevices(nextDevices: DeviceInfo[]) {
      mocks.workbench = workbench(nextDevices)
      hook.rerender()
    },
  }
}

test('a cloud outage keeps the authorized local inbox available, but a later access denial invalidates it', async () => {
  const { result, get, personalGet, binding } = setup(() =>
    Promise.reject(new TypeError('Failed to fetch'))
  )
  await waitFor(() => expect(result.current.inboxReady).toBe(true))
  expect(result.current.deviceId).toBe(localDeviceId)
  expect(result.current.error).toBeTruthy()
  expect(personalGet.mock.calls).toEqual([[userId, localDeviceId]])
  const bindingReads = binding.mock.calls.length
  get.mockRejectedValue(new ApiError('Forbidden', 403))
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.deviceId).toBeUndefined())
  expect(result.current.error).toBeTruthy()
  expect(personalGet.mock.calls).toEqual([[userId, localDeviceId]])
  expect(binding).toHaveBeenCalledTimes(bindingReads)
})

test('a cloud outage never substitutes the native binding for a known remote source', async () => {
  const { result, get, personalGet, binding } = setup(
    () => Promise.resolve(account('cloud-1')),
    [cloudDevice('cloud-1')]
  )
  await waitFor(() => expect(result.current.inboxReady).toBe(true))
  get.mockRejectedValue(new ApiError('Offline', 503))
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.error).toBeTruthy())
  expect(result.current.deviceId).toBe('cloud-1')
  expect(personalGet.mock.calls).toEqual([[userId, 'cloud-1']])
  expect(binding).not.toHaveBeenCalled()
})

test('catalog updates keep the verified inbox visible until a new source is resolved', async () => {
  const first = cloudDevice('cloud-1')
  const second = cloudDevice('cloud-2')
  const third = cloudDevice('cloud-3')
  const { result, get, changeDevices } = setup(
    () => Promise.resolve(account(first.device_id)),
    [first]
  )
  await waitFor(() => expect(result.current.inboxReady).toBe(true))
  const slow = deferred<PersonalAssistantAccount>()
  get.mockImplementationOnce(() => slow.promise)
  changeDevices([first, second])
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(result.current.deviceId).toBe(first.device_id)
  expect(result.current.inboxReady).toBe(true)
  get.mockResolvedValueOnce(account(third.device_id))
  changeDevices([first, second, third])
  await waitFor(() => expect(result.current.deviceId).toBe(third.device_id))
  await act(async () => {
    slow.resolve(account(second.device_id))
    await slow.promise
  })
  expect(result.current.deviceId).toBe(third.device_id)
})

test('settings changes on another device for this account re-resolve the primary source', async () => {
  const first = cloudDevice('cloud-1')
  const second = cloudDevice('cloud-2')
  const { result, get, personalGet } = setup(
    () => Promise.resolve(account(first.device_id)),
    [first, second]
  )
  await waitFor(() => expect(result.current.inboxReady).toBe(true))
  const changed = { userId, executionDeviceId: second.device_id, version: 1, roles: [] }
  act(() => publishPersonalStandIn({ ...changed, userId: userId + 1 }))
  expect(get).toHaveBeenCalledTimes(1)

  get.mockResolvedValueOnce(account(second.device_id))
  act(() => publishPersonalStandIn(changed))
  await waitFor(() => {
    expect(result.current.deviceId).toBe(second.device_id)
    expect(result.current.inboxReady).toBe(true)
  })
  expect(personalGet.mock.calls).toEqual([
    [userId, first.device_id],
    [userId, second.device_id],
  ])
})
