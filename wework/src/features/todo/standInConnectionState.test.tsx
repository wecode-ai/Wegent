import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
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

const cloudDevice = (id: string, status: DeviceInfo['status'] = 'online'): DeviceInfo =>
  ({
    id: 1,
    device_id: id,
    name: id,
    device_type: 'cloud',
    status,
    is_default: id === 'cloud-1',
  }) as DeviceInfo

const makeAccount = (environmentId?: string, revision = 'rev-1'): PersonalAssistantAccount => ({
  defaultBotRef: { name: 'primary', namespace: 'personal-assistant' },
  revision,
  retiredRoleIds: [],
  definitions: [
    {
      roleId: '@primary',
      bot: {
        metadata: { name: 'primary', namespace: 'personal-assistant', displayName: '默认助理' },
        spec: {
          execution_policy: environmentId
            ? { mode: 'fixed', environment_id: environmentId }
            : { mode: 'user_select' },
        },
      },
      ghost: {
        metadata: { name: 'primary', namespace: 'personal-assistant', displayName: '默认助理' },
        spec: { systemPrompt: 'Prompt' },
      },
    },
  ],
})

const makeBindingStore = () => {
  const stoppingTargets = new Set<string>()
  return vi.fn<StandInExecutorApi['binding']>(
    async (_deviceId, operation = 'get', _version, target) => {
      if (operation === 'markStopping' && target) {
        stoppingTargets.add(`${target.userId}:${target.deviceId}`)
      } else if (operation === 'clearStopping' && target) {
        stoppingTargets.delete(`${target.userId}:${target.deviceId}`)
      }
      return {
        version: 0,
        status: 'unbound',
        target: null,
        stoppingTargets: [...stoppingTargets],
      } satisfies StandInInstanceBinding
    }
  )
}

it('matches account IDs and preserves the installation-local owner', () => {
  expect(isStandInBindingOwner(1, 1)).toBe(true)
  expect(isStandInBindingOwner(1, 2)).toBe(false)
  expect(isStandInBindingOwner(1, 0)).toBe(false)
  expect(isStandInBindingOwner(0, 0)).toBe(true)
  expect(isStandInBindingOwner(0, 2)).toBe(true)
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

it('shares cloud primary execution device across clients and falls back cleanly for foreign local desktop IDs', async () => {
  const foreignDesktopId = `electron-${'a'.repeat(64)}`
  const currentDesktopId = `electron-${'b'.repeat(64)}`
  const emptyLocal: PersonalStandInSettings = {
    version: 0,
    executionDeviceId: currentDesktopId,
    userId: 1,
    roles: [],
  }
  const activeCloud: PersonalStandInSettings = {
    version: 2,
    executionDeviceId: 'cloud-1',
    userId: 1,
    roles: [],
  }
  const personalGet = vi
    .fn<StandInExecutorApi['personalGet']>()
    .mockImplementation(async (_userId, deviceId) =>
      deviceId === 'cloud-1' ? activeCloud : emptyLocal
    )
  const updateDefinitions = vi.fn()
  const services = {
    standInApi: { personalGet, binding: makeBindingStore() } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: {
      updateDefinitions,
      get: async () => makeAccount(),
    } as unknown as NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
    getLocalRuntimeSidebarIdentity: async () =>
      ({
        deviceId: currentDesktopId,
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      }) as const,
  } satisfies Partial<WorkbenchServices>
  const devices = [cloudDevice('cloud-1'), cloudDevice('cloud-2')]

  const { result, rerender } = renderHook(
    ({ account, userId }) =>
      useStandInInstance(
        services as WorkbenchServices,
        userId,
        devices,
        true,
        true,
        'https://cloud.example/api',
        undefined,
        undefined,
        account
      ),
    { initialProps: { account: makeAccount('cloud-1'), userId: 1 } }
  )

  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-1'))
  expect(result.current.binding?.status).toBe('active')

  // When another desktop saved its private electron-* IPC ID (either current sha256 or legacy UUID),
  // this client resolves an available cloud device without overwriting the other desktop's setting.
  for (const desktopId of [foreignDesktopId, 'electron-11111111-1111-4111-8111-111111111111']) {
    const previousVersion = result.current.binding!.version
    rerender({ account: makeAccount(desktopId), userId: 1 })
    await waitFor(() => expect(result.current.binding?.version).toBeGreaterThan(previousVersion))
    expect(result.current.binding?.target?.deviceId).toBe('cloud-1')
    expect(updateDefinitions).not.toHaveBeenCalled()
  }

  // Switching accounts immediately resolves the new account without owner-mismatch lockouts.
  rerender({ account: makeAccount('cloud-2'), userId: 2 })
  await waitFor(() =>
    expect(result.current.binding?.target).toEqual({
      userId: 2,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-2',
    })
  )
})

it('switches primary execution device directly without stopping and allows switching away while an offline device stops', async () => {
  const localId = `electron-${'c'.repeat(64)}`
  let latestAccount = makeAccount('cloud-1', 'rev-1')
  const runningCloud: PersonalStandInSettings = {
    version: 1,
    executionDeviceId: 'cloud-1',
    userId: 1,
    roles: [],
  }
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue(runningCloud)
  const lifecycle = vi
    .fn<StandInExecutorApi['lifecycle']>()
    .mockResolvedValueOnce(runningCloud)
    .mockRejectedValueOnce(new Error('executor-offline:cloud-2'))
    .mockResolvedValueOnce({ ...runningCloud, executionDeviceId: localId })
  const updateDefinitions = vi.fn(async (_revision, definitions) => {
    const nextDevice = definitions.find(
      (entry: { roleId: string }) => entry.roleId === '@primary'
    )?.executionDeviceId
    latestAccount = {
      ...makeAccount(nextDevice, 'rev-2'),
      stopIntents: latestAccount.stopIntents,
      stopIntentGenerations: latestAccount.stopIntentGenerations,
    }
    return latestAccount
  })
  const publishAccount = vi.fn((next: PersonalAssistantAccount) => {
    latestAccount = next
  })
  const binding = makeBindingStore()
  const getAccount = vi.fn(async () => latestAccount)
  const updateStopIntent = vi.fn(
    async (
      deviceId: string,
      operation: 'mark' | 'clear',
      requestId: string,
      expectedRequestId?: string | null
    ) => {
      const intents = latestAccount.stopIntents ?? []
      if (operation === 'mark') {
        expect(expectedRequestId).toBe(latestAccount.stopIntentGenerations?.[deviceId] ?? null)
      }
      latestAccount = {
        ...latestAccount,
        stopIntentGenerations:
          operation === 'mark'
            ? { ...latestAccount.stopIntentGenerations, [deviceId]: requestId }
            : latestAccount.stopIntentGenerations,
        stopIntents:
          operation === 'mark'
            ? [...intents.filter(intent => intent.deviceId !== deviceId), { deviceId, requestId }]
            : intents.filter(intent => intent.deviceId !== deviceId),
      }
      return latestAccount
    }
  )
  const services = {
    standInApi: { personalGet, lifecycle, binding } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: {
      updateDefinitions,
      get: getAccount,
      updateStopIntent,
    } as unknown as NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
    getLocalRuntimeSidebarIdentity: async () =>
      ({
        deviceId: localId,
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      }) as const,
  } satisfies Partial<WorkbenchServices>
  const devices = [cloudDevice('cloud-1'), cloudDevice('cloud-2')]

  const { result } = renderHook(() =>
    useStandInInstance(
      services as WorkbenchServices,
      1,
      devices,
      true,
      true,
      'https://cloud.example/api',
      undefined,
      undefined,
      latestAccount,
      publishAccount,
      () => latestAccount
    )
  )

  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-1'))

  // Switch directly from cloud-1 to cloud-2 without stopping cloud-1.
  await act(() =>
    result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-2',
    })
  )
  expect(lifecycle).toHaveBeenCalledWith(1, 'cloud-2', 'start')
  expect(lifecycle).not.toHaveBeenCalledWith(1, 'cloud-1', 'stop')
  expect(result.current.binding?.target?.deviceId).toBe('cloud-2')

  // A failed local persistence operation cannot create a falsely recorded stop intent.
  const persistenceFailure = new Error('Stop marker storage unavailable')
  binding.mockRejectedValueOnce(persistenceFailure)
  await act(() => result.current.stop())
  expect(result.current.errorCause).toBe(persistenceFailure)
  expect(result.current.binding?.status).toBe('active')
  expect(lifecycle).not.toHaveBeenCalledWith(1, 'cloud-2', 'stop')

  // Offline stop failure keeps cloud-2 in stopping, while allowing switching to localId.
  await act(() => result.current.stop())
  expect(result.current.binding?.status).toBe('stopping')
  expect(result.current.binding?.target?.deviceId).toBe('cloud-2')

  await act(() =>
    result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: localId,
    })
  )
  expect(result.current.binding).toMatchObject({
    status: 'active',
    target: { userId: 1, deviceId: localId },
  })

  // The local Executor can still stop its own assistant during an account-service outage.
  const localIntent = { deviceId: localId, requestId: 'peer-stop-local' }
  latestAccount = {
    ...latestAccount,
    stopIntents: [...(latestAccount.stopIntents ?? []), localIntent],
    stopIntentGenerations: {
      ...latestAccount.stopIntentGenerations,
      [localId]: localIntent.requestId,
    },
  }
  getAccount.mockRejectedValue(new Error('Account service unavailable'))
  const stoppedLocal: PersonalStandInSettings = {
    ...runningCloud,
    executionDeviceId: localId,
    lifecycle: { status: 'stopped', primaryEnabled: true, enabledRoles: [] },
  }
  lifecycle.mockImplementationOnce(async () => {
    personalGet.mockImplementation(async (_user, deviceId) =>
      deviceId === localId ? stoppedLocal : runningCloud
    )
    return stoppedLocal
  })
  await act(() => result.current.stop())
  expect(result.current.binding?.status).toBe('stopped')
  expect(lifecycle).toHaveBeenLastCalledWith(1, localId, 'stop')
  expect(latestAccount.stopIntents).toContainEqual(localIntent)
  getAccount.mockImplementation(async () => latestAccount)
  act(() => result.current.reload())
  await waitFor(() => expect(latestAccount.stopIntents).not.toContainEqual(localIntent))

  // Selecting cloud-2 again cannot resume a device with an unconfirmed stop.
  lifecycle.mockClear()
  await act(() =>
    result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-2',
    })
  )
  expect(result.current.binding).toMatchObject({
    status: 'stopping',
    target: { userId: 1, deviceId: 'cloud-2' },
  })
  expect(lifecycle).not.toHaveBeenCalled()

  // A failed local read must retain the known stopping state and expose its error.
  binding.mockRejectedValueOnce(persistenceFailure)
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.errorCause).toBe(persistenceFailure))
  expect(result.current.binding?.status).toBe('stopping')
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.error).toBeNull())
  expect(result.current.binding?.status).toBe('stopping')
})

it('shares offline stopping state across clients, guards stale stops, and recovers from revision conflicts', async () => {
  const localId = 'electron-22222222-2222-4222-8222-222222222222'
  let latestAccount = makeAccount('cloud-1', 'rev-1')
  const clearFailure = new Error('Stop marker cleanup unavailable')
  let failClear = false
  const binding = makeBindingStore()
  const updateStopIntent = vi.fn(
    async (
      deviceId: string,
      operation: 'mark' | 'clear',
      requestId: string,
      expectedRequestId?: string | null
    ) => {
      const intents = latestAccount.stopIntents ?? []
      const previous = intents.find(intent => intent.deviceId === deviceId)
      if (operation === 'clear' && failClear) throw clearFailure
      if (operation === 'mark') {
        expect(expectedRequestId).toBe(latestAccount.stopIntentGenerations?.[deviceId] ?? null)
      }
      latestAccount = {
        ...latestAccount,
        stopIntentGenerations:
          operation === 'mark'
            ? {
                ...latestAccount.stopIntentGenerations,
                [deviceId]: previous?.requestId ?? requestId,
              }
            : latestAccount.stopIntentGenerations,
        stopIntents:
          operation === 'mark'
            ? [
                ...intents.filter(intent => intent.deviceId !== deviceId),
                previous ?? { deviceId, requestId },
              ]
            : intents.filter(
                intent => intent.deviceId !== deviceId || intent.requestId !== requestId
              ),
      }
      return latestAccount
    }
  )
  const runningProfile: PersonalStandInSettings = {
    version: 1,
    executionDeviceId: 'cloud-1',
    userId: 1,
    roles: [],
  }
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue(runningProfile)
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>()
  const getAccount = vi.fn(async () => latestAccount)
  let conflictOnce = true
  const updateDefinitions = vi.fn(async (revision: string, definitions) => {
    if (conflictOnce && revision !== latestAccount.revision) {
      conflictOnce = false
      throw Object.assign(new Error('Conflict'), { status: 409, code: 'version_conflict' })
    }
    const nextDevice = definitions.find(
      (entry: { roleId: string }) => entry.roleId === '@primary'
    )?.executionDeviceId
    latestAccount = makeAccount(nextDevice, `${latestAccount.revision}-next`)
    return latestAccount
  })
  const publishAccount = vi.fn((next: PersonalAssistantAccount) => {
    latestAccount = next
  })
  const services = {
    standInApi: { personalGet, lifecycle, binding } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: {
      get: getAccount,
      updateDefinitions,
      updateStopIntent,
    } as unknown as NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
    getLocalRuntimeSidebarIdentity: async () =>
      ({
        deviceId: localId,
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      }) as const,
  } satisfies Partial<WorkbenchServices>

  const onlineDevices = [cloudDevice('cloud-1', 'online'), cloudDevice('cloud-2', 'online')]
  const offlineCloud2Devices = [cloudDevice('cloud-1', 'online'), cloudDevice('cloud-2', 'offline')]
  const firstMount = renderHook(
    ({ account, devices }) =>
      useStandInInstance(
        services as WorkbenchServices,
        1,
        devices,
        true,
        true,
        'https://cloud.example/api',
        undefined,
        undefined,
        account,
        publishAccount,
        () => latestAccount
      ),
    {
      initialProps: {
        account: latestAccount,
        devices: onlineDevices,
      },
    }
  )
  await waitFor(() => expect(firstMount.result.current.binding?.target?.deviceId).toBe('cloud-1'))

  // Another client switches @primary to cloud-2 before stop is confirmed on this client.
  const staleStopTarget = firstMount.result.current.binding!.target!
  latestAccount = makeAccount('cloud-2', 'rev-2')
  await act(() => firstMount.result.current.stop(staleStopTarget))
  expect(lifecycle).not.toHaveBeenCalled()
  await waitFor(() => expect(firstMount.result.current.binding?.target?.deviceId).toBe('cloud-2'))

  // Both clients keep their independent local binding stores while cloud-2 is offline.
  firstMount.rerender({
    account: latestAccount,
    devices: offlineCloud2Devices,
  })
  const peerServices = {
    ...services,
    standInApi: {
      personalGet,
      lifecycle,
      binding: makeBindingStore(),
    } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'electron-peer', runtimeInstanceId: 'peer', provenance: 'local-ipc' }) as const,
  }
  const afterReload = renderHook(
    ({ account, devices }) =>
      useStandInInstance(
        peerServices as WorkbenchServices,
        1,
        devices,
        true,
        true,
        'https://cloud.example/api',
        undefined,
        undefined,
        account,
        publishAccount,
        () => latestAccount
      ),
    {
      initialProps: {
        account: latestAccount,
        devices: offlineCloud2Devices,
      },
    }
  )
  await waitFor(() => expect(afterReload.result.current.binding?.status).toBe('active'))
  // The offline stop persists account state before delivery. Refreshing only the
  // account on an already-open peer must reveal it without changing definitions.
  lifecycle.mockRejectedValueOnce(new Error('executor-offline:cloud-2'))
  await act(() => firstMount.result.current.stop(firstMount.result.current.binding!.target!))
  expect(firstMount.result.current.binding?.status).toBe('stopping')
  const intent = latestAccount.stopIntents?.[0]
  expect(intent).toMatchObject({ deviceId: 'cloud-2', requestId: expect.any(String) })
  expect(binding).not.toHaveBeenCalledWith(localId, 'markStopping', undefined, expect.anything())
  expect(lifecycle).toHaveBeenLastCalledWith(1, 'cloud-2', 'stop', runningProfile.version)
  firstMount.unmount()
  afterReload.rerender({ account: latestAccount, devices: offlineCloud2Devices })
  await waitFor(() => expect(afterReload.result.current.binding?.status).toBe('stopping'))

  // Cloud-2 comes back online before receiving stop: status must remain 'stopping' until stop completes.
  afterReload.rerender({
    account: latestAccount,
    devices: onlineDevices,
  })
  await waitFor(() =>
    expect(personalGet).toHaveBeenCalledWith(1, 'cloud-2', { deviceSettingsOnly: true })
  )
  expect(afterReload.result.current.binding?.status).toBe('stopping')

  const stoppedProfile: PersonalStandInSettings = {
    ...runningProfile,
    executionDeviceId: 'cloud-2',
    lifecycle: { status: 'stopped', primaryEnabled: true, enabledRoles: [] },
  }
  lifecycle.mockResolvedValueOnce(stoppedProfile)
  failClear = true
  await act(() => afterReload.result.current.stop(afterReload.result.current.binding!.target!))
  expect(afterReload.result.current.binding?.status).toBe('stopped')
  expect(afterReload.result.current.errorCause).toBe(clearFailure)
  expect(latestAccount.stopIntents).toEqual([intent])

  // A verified remote stop remains stopped even if cleanup failed; reload retries the account cleanup.
  failClear = false
  personalGet.mockResolvedValueOnce(stoppedProfile)
  act(() => afterReload.result.current.reload())
  await waitFor(() => expect(latestAccount.stopIntents).toEqual([]))
  expect(afterReload.result.current.binding?.status).toBe('stopped')
  expect(afterReload.result.current.error).toBeNull()
  afterReload.unmount()

  // Simulate another client advancing revision to rev-3; first bind fails with 409 and refreshes latestAccount,
  // so retrying bind immediately succeeds with rev-3.
  const staleAccountSnapshot = latestAccount
  latestAccount = makeAccount('cloud-2', 'rev-3')
  publishAccount.mockClear()
  const conflictMount = renderHook(() =>
    useStandInInstance(
      services as WorkbenchServices,
      1,
      onlineDevices,
      true,
      true,
      'https://cloud.example/api',
      undefined,
      undefined,
      staleAccountSnapshot,
      publishAccount,
      () => staleAccountSnapshot
    )
  )
  await waitFor(() =>
    expect(conflictMount.result.current.binding?.target?.deviceId).toBe('cloud-2')
  )
  await expect(
    act(() =>
      conflictMount.result.current.bind({
        userId: 1,
        backendUrl: 'https://cloud.example/api',
        deviceId: 'cloud-1',
      })
    )
  ).rejects.toMatchObject({ status: 409 })
  expect(publishAccount).toHaveBeenCalledWith(expect.objectContaining({ revision: 'rev-3' }))
})
