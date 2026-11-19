import {
  isStandInBindingOwner,
  type StandInBindingTarget,
  type StandInInstanceBinding,
  type StandInExecutorApi,
} from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { LOCAL_USER } from '@/api/local/localSession'
import { availableStandInDevices } from './standInDevices'
import { migrateStandIn, StandInMigrationError } from './migrateStandIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'

interface InstanceSnapshot {
  binding?: StandInInstanceBinding
  stoppedProfile?: PersonalStandInSettings
  localDeviceId: string
  busy: boolean
  error: { cause: unknown; fallback: 'load_settings_failed' | 'save_settings_failed' } | null
}
interface InstanceObservation {
  devices: DeviceInfo[]
  connected: boolean
  active: boolean
  entryRequestKey?: number
}
const configured = (settings: PersonalStandInSettings) =>
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

/** The local instance binding owns initialization, cancellation and rebind transactions. */
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
  let readRevision = 0
  let activation = 0
  let lifetime = 0
  let initialization:
    | {
        deviceId: string
        activation: number
        lifetime: number
        request: Promise<{ binding: StandInInstanceBinding; error?: unknown }>
      }
    | undefined
  const publish = (patch: Partial<InstanceSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const publishBinding = (binding: StandInInstanceBinding) =>
    publish({
      binding,
      ...(binding.status !== 'stopped' ||
      binding.version !== snapshot.binding?.version ||
      !sameTarget(snapshot.binding?.target, binding.target) ||
      (binding.target && !isStandInBindingOwner(binding.target.userId, userId))
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
  const initialize = async (
    deviceId: string,
    unbound: StandInInstanceBinding,
    owner: InstanceObservation,
    epoch: number,
    revision: number
  ) => {
    const [owned, local] = await Promise.all([
      api!.personalGet(userId, deviceId),
      userId === LOCAL_USER.id
        ? Promise.resolve(undefined)
        : api!.personalGet(LOCAL_USER.id, deviceId),
    ])
    const mayBind = () =>
      observed(revision, deviceId) && observation?.active && activation === epoch
    if (!mayBind()) return { binding: unbound }
    const localOwner = !initialDeviceId && !configured(owned) && !!local && configured(local)
    const available = owner.connected ? availableStandInDevices(owner.devices) : []
    const preferred = available.find(device => device.is_default) ?? available[0]
    const target = {
      userId: localOwner ? LOCAL_USER.id : userId,
      backendUrl: localOwner || userId === LOCAL_USER.id ? '' : backendUrl,
      deviceId:
        initialDeviceId ||
        (configured(owned) || localOwner ? deviceId : (preferred?.device_id ?? deviceId)),
    }
    if (target.deviceId !== deviceId) {
      await api!.personalGet(target.userId, target.deviceId)
      if (!mayBind()) return { binding: unbound }
    }
    let bound: StandInInstanceBinding
    try {
      bound = await api!.binding(deviceId, 'bind', unbound.version, target)
    } catch (cause) {
      if (
        !cause ||
        typeof cause !== 'object' ||
        !('code' in cause) ||
        cause.code !== 'version_conflict'
      )
        throw cause
      // A competing initializer owns its target; never start it on this transaction's behalf.
      return { binding: await api!.binding(deviceId) }
    }
    // Once persisted, a failed start remains bound and recoverable only by stopping.
    if (!observed(revision, deviceId)) return { binding: bound }
    try {
      await api!.lifecycle(target.userId, target.deviceId, 'start')
    } catch (error) {
      return { binding: bound, error }
    }
    return { binding: bound }
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
      if (current())
        publish({
          localDeviceId: identity.deviceId,
          ...(snapshot.localDeviceId && snapshot.localDeviceId !== identity.deviceId
            ? { binding: undefined, stoppedProfile: undefined }
            : {}),
        })
      // Finish the admitted binding read; only the current owner may initialize or publish it.
      let binding = await api.binding(identity.deviceId)
      if (!current()) return
      if (
        binding.status === 'stopped' &&
        binding.target &&
        isStandInBindingOwner(binding.target.userId, userId)
      ) {
        // Binding choices remain usable while the stopped device profile is loading.
        publishBinding(binding)
        const stoppedProfile = await api.personalGet(binding.target.userId, binding.target.deviceId)
        if (current()) publish({ stoppedProfile, error: null })
        return
      }
      if (binding.status === 'unbound') {
        if (initialization?.deviceId !== identity.deviceId) {
          const request = initialize(identity.deviceId, binding, owner, epoch, ownerRevision)
          initialization = {
            deviceId: identity.deviceId,
            activation: epoch,
            lifetime: ownerRevision,
            request,
          }
          void request.then(
            value => {
              if (value.binding.status === 'unbound' && initialization?.request === request)
                initialization = undefined
            },
            () => {
              if (initialization?.request === request) initialization = undefined
            }
          )
        }
        const transaction = initialization
        const initialized = await transaction.request
        if (
          current() &&
          initialized.binding.status === 'unbound' &&
          (transaction.activation !== epoch || transaction.lifetime !== ownerRevision)
        ) {
          void read()
          return
        }
        binding = initialized.binding
        if (initialized.error) {
          if (current()) publishBinding(binding)
          throw initialized.error
        }
      }
      if (current()) {
        publishBinding(binding)
        publish({ error: null })
      }
    } catch (cause) {
      if (current()) publish({ error: { cause, fallback: 'load_settings_failed' } })
    }
  }
  const mutate = async (
    operation: 'stop' | 'bind' | 'migrate',
    input: {
      version?: number
      target?: StandInBindingTarget
      roleId?: string
      primaryName?: string
    }
  ) => {
    if (!listeners.size || !observation?.active || snapshot.busy) return
    const binding = snapshot.binding
    const localDeviceId = snapshot.localDeviceId
    const revision = lifetime
    publish({ busy: true, error: null })
    try {
      if (operation === 'stop') {
        if (
          !api ||
          !binding?.target ||
          !isStandInBindingOwner(binding.target.userId, userId) ||
          !localDeviceId
        )
          return
        readRevision++
        activation++
        const stopping = await api.binding(localDeviceId, 'beginStop', input.version!)
        assertObserved(revision, localDeviceId)
        publishBinding(stopping)
        const target = stopping.target!
        const stopped = await api.lifecycle(target.userId, target.deviceId, 'stop')
        assertObserved(revision, localDeviceId)
        if (stopped.lifecycle?.status !== 'stopped')
          throw Object.assign(new Error('Stand-in cancellation is incomplete'), {
            code: 'stand_in_stop_incomplete',
          })
        const complete = await api.binding(localDeviceId, 'completeStop', stopping.version)
        if (observed(revision, localDeviceId)) {
          publishBinding(complete)
          publish({ stoppedProfile: stopped })
        }
        return
      }
      if (!api || !binding || !localDeviceId || binding.status !== 'stopped' || !input.target) {
        if (operation === 'migrate') throw new StandInMigrationError('not_stopped')
        return
      }
      if (
        operation === 'migrate' &&
        (!binding.target || !isStandInBindingOwner(binding.target.userId, userId))
      )
        throw new StandInMigrationError('not_stopped')
      readRevision++
      activation++
      const target = input.target
      const role =
        operation === 'migrate'
          ? await migrateStandIn(api, {
              sourceUser: binding.target!.userId,
              sourceDevice: binding.target!.deviceId,
              roleId: input.roleId,
              targetUser: target.userId,
              targetDevice: target.deviceId,
              primaryName: input.primaryName!,
              assertOwnership: () => assertObserved(revision, localDeviceId),
            })
          : undefined
      assertObserved(revision, localDeviceId)
      const next = await api.binding(localDeviceId, 'bind', binding.version, target)
      assertObserved(revision, localDeviceId)
      try {
        await api.lifecycle(target.userId, target.deviceId, 'start')
        if (observed(revision, localDeviceId)) return role
      } finally {
        if (observed(revision, localDeviceId)) publishBinding(next)
      }
    } catch (cause) {
      if (observed(revision, localDeviceId))
        publish({ error: { cause, fallback: 'save_settings_failed' } })
      if (operation === 'migrate') throw cause
    } finally {
      if (observed(revision, localDeviceId)) publish({ busy: false })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: InstanceObservation, listener: () => void) {
      const previous = observation
      observation = owner
      listeners.add(listener)
      const changed =
        !previous ||
        previous.active !== owner.active ||
        previous.connected !== owner.connected ||
        previous.devices !== owner.devices ||
        previous.entryRequestKey !== owner.entryRequestKey
      if (!previous || previous.active !== owner.active) activation++
      if (changed) {
        readRevision++
        if (owner.active && !snapshot.busy) void read()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          readRevision++
          lifetime++
          activation++
          observation = undefined
          publish({ busy: false })
        })
      }
    },
    stop: async (version: number) => {
      await mutate('stop', { version })
    },
    bind: async (target: StandInBindingTarget) => {
      await mutate('bind', { target })
    },
    migrate: (target: StandInBindingTarget, roleId: string | undefined, primaryName: string) =>
      mutate('migrate', { target, roleId, primaryName }),
    reload: () => {
      void read()
    },
  }
}
