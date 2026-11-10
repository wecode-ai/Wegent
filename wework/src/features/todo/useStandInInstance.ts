import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StandInBindingTarget, StandInInstanceBinding } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { LOCAL_USER } from '@/api/local/localSession'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { availableStandInDevices } from './standInDevices'
import { migrateStandIn, StandInMigrationError } from './migrateStandIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'

/** An instance has one durable binding; failed cancellation never unlocks rebinding. */
export function useStandInInstance(
  services: WorkbenchServices,
  userId: number,
  devices: DeviceInfo[],
  connected: boolean,
  active: boolean,
  backendUrl = '',
  initialDeviceId?: string
) {
  const [binding, setBinding] = useState<StandInInstanceBinding>()
  const [stoppedProfile, setStoppedProfile] = useState<PersonalStandInSettings>()
  const [localDeviceId, setLocalDeviceId] = useState('')
  const [error, setError] = useState<{
    cause: unknown
    fallback: 'load_settings_failed' | 'save_settings_failed'
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const operation = useRef(false)
  const cancelRead = useRef<(() => void) | null>(null)
  const pageActive = useRef(active)
  useLayoutEffect(() => {
    pageActive.current = active
    return () => {
      pageActive.current = false
    }
  }, [active])
  const initialization = useRef<{
    deviceId: string
    request: Promise<{ binding: StandInInstanceBinding; error?: unknown }>
  } | null>(null)
  const api = services.standInApi
  useEffect(() => {
    if (!active || operation.current) return
    let current = true
    const cancel = () => {
      current = false
    }
    cancelRead.current = cancel
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity || !api) throw new Error('Executor identity is unavailable')
      if (current) setLocalDeviceId(identity.deviceId)
      let value = await api.binding(identity.deviceId)
      if (!current) return
      if (
        value.status === 'stopped' &&
        value.target &&
        (value.target.userId === LOCAL_USER.id ||
          (value.target.userId === userId && (value.target.backendUrl ?? '') === backendUrl))
      ) {
        // Binding choices do not depend on reading an already stopped device.
        setBinding(value)
        const profile = await api.personalGet(value.target.userId, value.target.deviceId)
        if (!current) return
        setStoppedProfile(profile)
        setError(null)
        return
      }
      if (value.status === 'unbound') {
        const initialize = async () => {
          const unbound = value
          const [owned, local] = await Promise.all([
            api.personalGet(userId, identity.deviceId),
            userId === LOCAL_USER.id
              ? Promise.resolve(undefined)
              : api.personalGet(LOCAL_USER.id, identity.deviceId),
          ])
          if (!pageActive.current) return { binding: unbound }
          const configured = (settings: typeof owned) =>
            Boolean(
              settings.version > 0 ||
              settings.roles.some(
                role =>
                  role.version > 0 ||
                  role.enabled ||
                  role.name ||
                  role.prompt ||
                  role.connections?.length
              ) ||
              settings.primary?.prompt ||
              settings.primary?.preferences
            )
          const localOwner = !initialDeviceId && !configured(owned) && !!local && configured(local)
          const available = connected ? availableStandInDevices(devices) : []
          const preferred = available.find(device => device.is_default) ?? available[0]
          const target = {
            userId: localOwner ? LOCAL_USER.id : userId,
            backendUrl: localOwner || userId === LOCAL_USER.id ? '' : backendUrl,
            deviceId:
              initialDeviceId ||
              (configured(owned) || localOwner
                ? identity.deviceId
                : (preferred?.device_id ?? identity.deviceId)),
          }
          if (target.deviceId !== identity.deviceId) {
            await api.personalGet(target.userId, target.deviceId)
            if (!pageActive.current) return { binding: unbound }
          }
          let bound: StandInInstanceBinding
          try {
            bound = await api.binding(identity.deviceId, 'bind', unbound.version, target)
          } catch (cause) {
            if (
              !cause ||
              typeof cause !== 'object' ||
              !('code' in cause) ||
              cause.code !== 'version_conflict'
            )
              throw cause
            // Another initialization won. Read its authoritative target without
            // retrying the write or starting a possibly different owner's profile.
            return { binding: await api.binding(identity.deviceId) }
          }
          // Persist the binding first: a failed start remains bound and recoverable by stopping.
          try {
            await api.lifecycle(target.userId, target.deviceId, 'start')
          } catch (cause) {
            return { binding: bound, error: cause }
          }
          return { binding: bound }
        }
        // Device discovery can refresh while bind is in flight. Every observer must
        // share that transaction, including late reads of the old unbound version.
        if (initialization.current?.deviceId !== identity.deviceId) {
          const request = initialize()
          initialization.current = { deviceId: identity.deviceId, request }
          void request.catch(() => {
            if (initialization.current?.request === request) initialization.current = null
          })
        }
        const request = initialization.current.request
        const initialized = await request
        value = initialized.binding
        if (value.status === 'unbound' && initialization.current?.request === request) {
          initialization.current = null
        }
        if (initialized.error) {
          if (current) setBinding(value)
          throw initialized.error
        }
      }
      if (current) {
        setBinding(value)
        setError(null)
      }
    })().catch(cause => {
      if (current) setError({ cause, fallback: 'load_settings_failed' })
    })
    return cancel
  }, [api, services, userId, devices, connected, active, attempt, backendUrl, initialDeviceId])

  const run = async <T>(action: () => Promise<T>, propagate = false): Promise<T | undefined> => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      return await action()
    } catch (cause) {
      setError({ cause, fallback: 'save_settings_failed' })
      if (propagate) throw cause
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  const stop = (version: number) =>
    run(async () => {
      if (!api || !binding?.target || !localDeviceId) return
      cancelRead.current?.()
      const stopping = await api.binding(localDeviceId, 'beginStop', version)
      setBinding(stopping)
      const target = stopping.target!
      const stopped = await api.lifecycle(target.userId, target.deviceId, 'stop')
      if (stopped.lifecycle?.status !== 'stopped') {
        throw Object.assign(new Error('Stand-in cancellation is incomplete'), {
          code: 'stand_in_stop_incomplete',
        })
      }
      setBinding(await api.binding(localDeviceId, 'completeStop', stopping.version))
      setStoppedProfile(stopped)
    })
  const bind = (target: StandInBindingTarget) =>
    run(async () => {
      if (!api || !binding || !localDeviceId || binding.status !== 'stopped') return
      cancelRead.current?.()
      const next = await api.binding(localDeviceId, 'bind', binding.version, target)
      try {
        await api.lifecycle(target.userId, target.deviceId, 'start')
      } finally {
        setBinding(next)
      }
    })
  const migrate = (target: StandInBindingTarget, roleId: string | undefined, primaryName: string) =>
    run(async () => {
      if (!api || !binding?.target || binding.status !== 'stopped' || !localDeviceId)
        throw new StandInMigrationError('not_stopped')
      cancelRead.current?.()
      const role = await migrateStandIn(api, {
        sourceUser: binding.target.userId,
        sourceDevice: binding.target.deviceId,
        roleId,
        targetUser: target.userId,
        targetDevice: target.deviceId,
        primaryName,
      })
      const next = await api.binding(localDeviceId, 'bind', binding.version, target)
      try {
        await api.lifecycle(target.userId, target.deviceId, 'start')
        return role
      } finally {
        setBinding(next)
      }
    }, true)
  return {
    binding,
    stoppedProfile,
    localDeviceId,
    busy,
    error: error ? getStandInErrorMessage(error.cause, error.fallback) : null,
    errorCause: error?.cause,
    stop,
    bind,
    migrate,
    reload: () => setAttempt(value => value + 1),
  }
}
