import type {
  PersonalAssistantAccount,
  PersonalAssistantStopIntent,
} from '@/api/personalAssistantAccount'
import { ApiError } from '@/api/http'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type {
  StandInBindingTarget,
  StandInExecutorApi,
  StandInInstanceBinding,
} from '@/api/standIn'
import { LOCAL_USER } from '@/api/local/localSession'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { isCloudDevice, isRemoteDevice, isRemoteTaskDevice } from '@/lib/device-capabilities'
import {
  findWorkbenchDevice,
  getWorkbenchDeviceIds,
  isLocalWorkbenchDeviceAlias,
} from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'
import { migrateStandIn, StandInMigrationError } from './migrateStandIn'
import { availableStandInDevices } from './standInDevices'

interface InstanceSnapshot {
  binding?: StandInInstanceBinding
  stoppedProfile?: PersonalStandInSettings
  localDeviceId: string
  busy: boolean
  error: { cause: unknown; fallback: 'load_settings_failed' | 'save_settings_failed' } | null
}

interface InstanceObservation {
  account?: PersonalAssistantAccount
  publishAccount?: (account: PersonalAssistantAccount) => void
  readAccount?: () => PersonalAssistantAccount | undefined
  devices: DeviceInfo[]
  connected: boolean
  active: boolean
  entryRequestKey?: number
}

export const hasSavedStandIn = (settings: PersonalStandInSettings) =>
  Boolean(
    settings.version > 0 ||
    settings.roles.some(
      role =>
        role.version > 0 || role.enabled || role.name || role.prompt || role.connections?.length
    ) ||
    settings.primary?.prompt ||
    settings.primary?.preferences
  )

const sameTarget = (
  left: StandInBindingTarget | null | undefined,
  right: StandInBindingTarget | null | undefined
) => left?.userId === right?.userId && left?.deviceId === right?.deviceId

const hasPendingStop = (saved: StandInInstanceBinding, target: StandInBindingTarget) =>
  saved.stoppingTargets?.includes(`${target.userId}:${target.deviceId}`) === true ||
  (saved.status === 'stopping' && sameTarget(saved.target, target))

export const isLocalDesktopDeviceId = (deviceId: string) =>
  isLocalWorkbenchDeviceAlias(deviceId) || deviceId.trim().startsWith('electron-')

export const normalizeStandInBindingTarget = (
  target: StandInBindingTarget,
  localDeviceId: string,
  devices: DeviceInfo[] = []
): StandInBindingTarget =>
  !localDeviceId ||
  target.deviceId === localDeviceId ||
  (target.userId !== LOCAL_USER.id &&
    (!isLocalDesktopDeviceId(target.deviceId) ||
      Boolean(findWorkbenchDevice(devices, target.deviceId))))
    ? target
    : { ...target, deviceId: localDeviceId }

export function resolveReachableStandInDevice(
  candidate: string | undefined,
  localDeviceId: string,
  devices: DeviceInfo[]
): string | undefined {
  const trimmed = candidate?.trim()
  if (!trimmed) return undefined
  if (localDeviceId && (trimmed === localDeviceId || isLocalWorkbenchDeviceAlias(trimmed))) {
    return localDeviceId
  }
  const matched = findWorkbenchDevice(devices, trimmed)
  if (!matched) {
    return !isLocalDesktopDeviceId(trimmed) ? trimmed : undefined
  }
  if (matched.device_type === 'local') return localDeviceId || matched.device_id
  if (isCloudDevice(matched) || isRemoteDevice(matched) || isRemoteTaskDevice(matched)) {
    return matched.device_id
  }
  return undefined
}

export function configuredPrimaryStandInDevice(
  account: PersonalAssistantAccount | undefined
): string | undefined {
  return account?.definitions
    .find(entry => entry.roleId === '@primary')
    ?.bot.spec?.execution_policy?.environment_id?.trim()
}

export async function resolvePrimaryStandInDevice({
  api,
  account,
  userId,
  localDeviceId,
  devices,
  connected,
  initialDeviceId,
}: {
  api: StandInExecutorApi
  account?: PersonalAssistantAccount
  userId: number
  localDeviceId: string
  devices: DeviceInfo[]
  connected: boolean
  initialDeviceId?: string
}): Promise<string> {
  const configured = configuredPrimaryStandInDevice(account)
  const reachable = resolveReachableStandInDevice(configured, localDeviceId, devices)
  if (reachable) return reachable
  const routeDevice = resolveReachableStandInDevice(initialDeviceId, localDeviceId, devices)
  if (routeDevice) return routeDevice
  const owned = await api.personalGet(userId, localDeviceId, { deviceSettingsOnly: true })
  if (hasSavedStandIn(owned)) return localDeviceId
  const available = connected ? availableStandInDevices(devices) : []
  const preferred = available.find(device => device.is_default) ?? available[0]
  return preferred?.device_id ?? localDeviceId
}

/** Resolve the account's primary execution device and manage per-device stand-in lifecycle. */
export function createStandInInstanceSource({
  services,
  api,
  userId,
  backendUrl,
  initialDeviceId,
}: {
  services: WorkbenchServices
  api: StandInExecutorApi | undefined
  userId: number
  backendUrl: string
  initialDeviceId?: string
}) {
  let snapshot: InstanceSnapshot = { localDeviceId: '', busy: false, error: null }
  const listeners = new Set<() => void>()
  let observation: InstanceObservation | undefined
  let pinnedSelection: { userId: number; scope: string; deviceId: string } | undefined
  let version = 0
  let readRevision = 0
  let activation = 0
  let lifetime = 0
  let refreshStopState = false
  const publish = (patch: Partial<InstanceSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const publishBinding = (binding: StandInInstanceBinding) =>
    publish({
      binding,
      ...(binding.status !== 'stopped' || !sameTarget(snapshot.binding?.target, binding.target)
        ? { stoppedProfile: undefined }
        : {}),
    })
  const observed = (revision: number, deviceId?: string) =>
    listeners.size > 0 &&
    lifetime === revision &&
    (!deviceId || snapshot.localDeviceId === deviceId)
  const assertObserved = (revision: number, deviceId: string) => {
    if (!observed(revision, deviceId))
      throw new DOMException('Stand-in instance owner changed', 'AbortError')
  }
  const updateCloudPrimaryDevice = async (deviceId: string) => {
    const currentAccount = observation?.readAccount?.() ?? observation?.account
    const publishNextAccount = observation?.publishAccount
    const cloud = services.personalAssistantAccountApi
    if (!currentAccount || !publishNextAccount || !cloud) return
    if (configuredPrimaryStandInDevice(currentAccount) === deviceId) return
    const definitions = currentAccount.definitions.map(entry => ({
      roleId: entry.roleId,
      name: entry.bot.metadata.displayName ?? '',
      prompt: entry.ghost.spec.systemPrompt,
      executionDeviceId:
        entry.roleId === '@primary' ? deviceId : entry.bot.spec?.execution_policy?.environment_id,
    }))
    try {
      publishNextAccount(await cloud.updateDefinitions(currentAccount.revision, definitions))
    } catch (cause) {
      const latest = await cloud.get?.().catch(() => null)
      if (latest) {
        publishNextAccount(latest)
        if (configuredPrimaryStandInDevice(latest) === deviceId) return
      }
      throw cause
    }
  }
  const persistStoppingTarget = async (
    localDeviceId: string,
    target: StandInBindingTarget,
    stopping: boolean
  ) => {
    if (!api) throw new Error('Executor identity is unavailable')
    await api.binding(localDeviceId, stopping ? 'markStopping' : 'clearStopping', undefined, target)
  }
  const stopDeviceIds = (deviceId: string) => {
    const device = findWorkbenchDevice(observation?.devices ?? [], deviceId)
    return device ? getWorkbenchDeviceIds(device) : [deviceId]
  }
  const sharedStopIntent = (account: PersonalAssistantAccount | undefined, deviceId: string) => {
    const ids = stopDeviceIds(deviceId)
    return account?.stopIntents?.find(intent => ids.includes(intent.deviceId))
  }
  const loadStopAccount = async () => {
    const cloud = services.personalAssistantAccountApi
    if (userId === LOCAL_USER.id || !cloud || !observation?.account) return undefined
    const account = await cloud.get()
    if (!account) throw new Error('Personal assistant account is unavailable')
    return account
  }
  const clearStopIntent = async (
    localDeviceId: string,
    target: StandInBindingTarget,
    localPending: boolean,
    sharedPending?: PersonalAssistantStopIntent
  ) => {
    if (localPending) await persistStoppingTarget(localDeviceId, target, false)
    if (sharedPending) {
      await services.personalAssistantAccountApi!.updateStopIntent(
        sharedPending.deviceId,
        'clear',
        sharedPending.requestId
      )
    }
  }
  const read = async () => {
    const owner = observation
    if (!owner?.active || !listeners.size || snapshot.busy) return
    const revision = ++readRevision
    const epoch = activation
    const ownerRevision = lifetime
    const current = () =>
      observed(ownerRevision) &&
      observation?.active &&
      epoch === activation &&
      revision === readRevision
    try {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity || !api) throw new Error('Executor identity is unavailable')
      if (current()) {
        publish({
          localDeviceId: identity.deviceId,
          ...(snapshot.localDeviceId && snapshot.localDeviceId !== identity.deviceId
            ? { binding: undefined, stoppedProfile: undefined }
            : {}),
        })
      }
      const activeAccount = owner.readAccount?.() ?? owner.account
      const configured = configuredPrimaryStandInDevice(activeAccount)
      const scope = JSON.stringify([userId, configured ?? ''])
      let targetDeviceId: string
      if (pinnedSelection?.userId === userId && pinnedSelection.scope === scope) {
        targetDeviceId = pinnedSelection.deviceId
      } else {
        targetDeviceId = await resolvePrimaryStandInDevice({
          api,
          account: activeAccount,
          userId,
          localDeviceId: identity.deviceId,
          devices: owner.devices,
          connected: owner.connected,
          initialDeviceId,
        })
        if (!current()) return
        pinnedSelection = { userId, scope, deviceId: targetDeviceId }
      }
      const target: StandInBindingTarget = {
        userId,
        backendUrl: userId === LOCAL_USER.id ? '' : backendUrl,
        deviceId: targetDeviceId,
      }
      const localPending = hasPendingStop(await api.binding(identity.deviceId, 'get'), target)
      let accountError: InstanceSnapshot['error'] = null
      const stopAccount = await loadStopAccount().catch(cause => {
        if (targetDeviceId !== identity.deviceId) throw cause
        accountError = { cause, fallback: 'load_settings_failed' }
        return undefined
      })
      const sharedPending = sharedStopIntent(stopAccount, targetDeviceId)
      const pendingStop =
        localPending ||
        Boolean(sharedPending) ||
        (accountError !== null &&
          snapshot.binding?.status === 'stopping' &&
          sameTarget(snapshot.binding.target, target))
      if (!current()) return
      if (findWorkbenchDevice(owner.devices, targetDeviceId)?.status === 'offline') {
        if (current()) {
          publishBinding({
            version: ++version,
            status: pendingStop ? 'stopping' : 'active',
            target,
          })
          publish({ error: accountError })
        }
        return
      }
      let profile: PersonalStandInSettings
      try {
        profile = await api.personalGet(userId, targetDeviceId, { deviceSettingsOnly: true })
      } catch (cause) {
        if (current()) {
          publishBinding({
            version: ++version,
            status: pendingStop ? 'stopping' : 'active',
            target,
          })
          publish({ error: { cause, fallback: 'load_settings_failed' } })
        }
        return
      }
      if (!current()) return
      const lifecycleStatus = profile.lifecycle?.status
      if (lifecycleStatus === 'stopped') {
        publishBinding({ version: ++version, status: 'stopped', target })
        publish({ stoppedProfile: profile, error: accountError })
        if (pendingStop && current())
          await clearStopIntent(identity.deviceId, target, localPending, sharedPending)
        return
      }
      const status = lifecycleStatus === 'stopping' || pendingStop ? 'stopping' : 'active'
      publishBinding({ version: ++version, status, target })
      publish({ error: accountError })
    } catch (cause) {
      if (current()) publish({ error: { cause, fallback: 'load_settings_failed' } })
    }
  }
  const mutate = async (
    operation: 'stop' | 'bind' | 'migrate',
    input: {
      target?: StandInBindingTarget
      roleId?: string
      primaryName?: string
      targetApi?: StandInExecutorApi
    }
  ) => {
    if (!listeners.size || !observation?.active || snapshot.busy) return
    const binding = snapshot.binding
    const localDeviceId = snapshot.localDeviceId
    const revision = lifetime
    readRevision++
    activation++
    publish({ busy: true, error: null })
    try {
      if (operation === 'stop') {
        const expectedTarget = input.target ?? binding?.target
        if (!api || !binding?.target || !expectedTarget || !localDeviceId) return
        if (!sameTarget(binding.target, expectedTarget)) {
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        }
        const latest = await loadStopAccount().catch(cause => {
          if (expectedTarget.deviceId !== localDeviceId) throw cause
          return undefined
        })
        if (latest && binding.status !== 'stopping') {
          assertObserved(revision, localDeviceId)
          const latestReachable = resolveReachableStandInDevice(
            configuredPrimaryStandInDevice(latest),
            localDeviceId,
            observation?.devices ?? []
          )
          if (latestReachable && latestReachable !== expectedTarget.deviceId) {
            observation?.publishAccount?.(latest)
            pinnedSelection = undefined
            queueMicrotask(() => void read())
            throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
          }
        }
        const target = expectedTarget
        let localPending = hasPendingStop(await api.binding(localDeviceId, 'get'), target)
        assertObserved(revision, localDeviceId)
        let sharedPending = sharedStopIntent(latest, target.deviceId)
        const remoteStop = Boolean(latest && target.deviceId !== localDeviceId)
        if (remoteStop) {
          const expectedRequestId =
            stopDeviceIds(target.deviceId)
              .map(id => latest?.stopIntentGenerations?.[id])
              .find(id => id !== undefined) ?? null
          const marked = await services
            .personalAssistantAccountApi!.updateStopIntent(
              target.deviceId,
              'mark',
              sharedPending?.requestId ?? crypto.randomUUID(),
              expectedRequestId
            )
            .catch(cause => {
              if (cause instanceof ApiError && cause.status === 409)
                queueMicrotask(() => void read())
              throw cause
            })
          sharedPending = sharedStopIntent(marked, target.deviceId)
          if (!sharedPending) {
            queueMicrotask(() => void read())
            throw new Error('Personal assistant stop request is no longer pending')
          }
        } else {
          await persistStoppingTarget(localDeviceId, target, true)
          localPending = true
        }
        assertObserved(revision, localDeviceId)
        publishBinding({ version: ++version, status: 'stopping', target })
        let stopped: PersonalStandInSettings
        if (remoteStop && sharedPending) {
          const profile = await api.personalGet(target.userId, target.deviceId, {
            deviceSettingsOnly: true,
          })
          const confirmed = sharedStopIntent(await loadStopAccount(), target.deviceId)
          assertObserved(revision, localDeviceId)
          if (confirmed?.requestId !== sharedPending.requestId) {
            queueMicrotask(() => void read())
            throw Object.assign(new Error('Stop request changed'), { code: 'version_conflict' })
          }
          // The target validates this version under its lifecycle lock. Another
          // client's completed stop followed by a start invalidates a delayed retry.
          stopped =
            profile.lifecycle?.status === 'stopped'
              ? profile
              : await api.lifecycle(target.userId, target.deviceId, 'stop', profile.version)
        } else {
          stopped = await api.lifecycle(target.userId, target.deviceId, 'stop')
        }
        assertObserved(revision, localDeviceId)
        if (stopped.lifecycle?.status !== 'stopped') {
          throw Object.assign(new Error('Stand-in cancellation is incomplete'), {
            code: 'stand_in_stop_incomplete',
          })
        }
        if (observed(revision, localDeviceId)) {
          publishBinding({ version: ++version, status: 'stopped', target })
          publish({ stoppedProfile: stopped })
        }
        await clearStopIntent(localDeviceId, target, localPending, sharedPending)
        return
      }
      if (!api || !localDeviceId || !input.target) {
        if (operation === 'migrate') throw new StandInMigrationError('not_stopped')
        return
      }
      if (operation === 'migrate' && (!binding?.target || binding.status !== 'stopped')) {
        throw new StandInMigrationError('not_stopped')
      }
      const target = normalizeStandInBindingTarget(
        input.target,
        localDeviceId,
        observation?.devices
      )
      const localPending = hasPendingStop(await api.binding(localDeviceId, 'get'), target)
      assertObserved(revision, localDeviceId)
      const role =
        operation === 'migrate'
          ? await migrateStandIn(api, {
              sourceUser: binding!.target!.userId,
              sourceDevice: binding!.target!.deviceId,
              roleId: input.roleId,
              targetUser: target.userId,
              targetDevice: target.deviceId,
              primaryName: input.primaryName!,
              targetApi: input.targetApi,
              assertOwnership: () => assertObserved(revision, localDeviceId),
            })
          : undefined
      assertObserved(revision, localDeviceId)
      await updateCloudPrimaryDevice(target.deviceId)
      assertObserved(revision, localDeviceId)
      const sharedPending = sharedStopIntent(await loadStopAccount(), target.deviceId)
      assertObserved(revision, localDeviceId)
      const pendingStop = localPending || Boolean(sharedPending)
      pinnedSelection = {
        userId: target.userId,
        scope: JSON.stringify([
          target.userId,
          configuredPrimaryStandInDevice(observation?.readAccount?.() ?? observation?.account) ??
            '',
        ]),
        deviceId: target.deviceId,
      }
      let status: StandInInstanceBinding['status'] = pendingStop ? 'stopping' : 'active'
      let stoppedProfile: PersonalStandInSettings | undefined
      try {
        if (pendingStop) {
          const profile = await api.personalGet(target.userId, target.deviceId, {
            deviceSettingsOnly: true,
          })
          assertObserved(revision, localDeviceId)
          // A recorded stop can still be pending when the remote device is online again.
          // Selecting that device must not restart it or discard the stop request.
          if (profile.lifecycle?.status !== 'stopped') return role
          status = 'stopped'
          stoppedProfile = profile
          await clearStopIntent(localDeviceId, target, localPending, sharedPending)
          assertObserved(revision, localDeviceId)
        }
        await api.lifecycle(target.userId, target.deviceId, 'start')
        status = 'active'
        if (observed(revision, localDeviceId)) return role
      } finally {
        if (observed(revision, localDeviceId)) {
          publishBinding({ version: ++version, status, target })
          if (status === 'stopped') publish({ stoppedProfile })
        }
      }
    } catch (cause) {
      if (observed(revision, localDeviceId))
        publish({ error: { cause, fallback: 'save_settings_failed' } })
      if (operation === 'migrate' || operation === 'bind') throw cause
    } finally {
      if (observed(revision, localDeviceId)) {
        publish({ busy: false })
        if (refreshStopState) {
          refreshStopState = false
          void read()
        }
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: InstanceObservation, listener: () => void) {
      const previous = observation
      observation = owner
      listeners.add(listener)
      const targetId = snapshot.binding?.target?.deviceId
      const stopStateChanged =
        targetId !== undefined &&
        sharedStopIntent(previous?.account, targetId)?.requestId !==
          sharedStopIntent(owner.account, targetId)?.requestId
      const changed =
        !previous ||
        previous.active !== owner.active ||
        previous.connected !== owner.connected ||
        previous.devices !== owner.devices ||
        previous.entryRequestKey !== owner.entryRequestKey ||
        configuredPrimaryStandInDevice(previous.account) !==
          configuredPrimaryStandInDevice(owner.account) ||
        stopStateChanged
      if (!previous || previous.active !== owner.active) activation++
      if (changed) {
        readRevision++
        if (owner.active && !snapshot.busy) void read()
        else if (owner.active && stopStateChanged) refreshStopState = true
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          readRevision++
          lifetime++
          activation++
          observation = undefined
          refreshStopState = false
          publish({ busy: false })
        })
      }
    },
    stop: async (target?: StandInBindingTarget) => {
      await mutate('stop', { target })
    },
    bind: async (target: StandInBindingTarget) => {
      await mutate('bind', { target })
    },
    migrate: (
      target: StandInBindingTarget,
      roleId: string | undefined,
      primaryName: string,
      targetApi?: StandInExecutorApi
    ) => mutate('migrate', { target, roleId, primaryName, targetApi }),
    reload: () => {
      void read()
    },
  }
}
