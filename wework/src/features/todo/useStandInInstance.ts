import { useEffect, useRef, useState } from 'react'
import type { StandInBindingTarget, StandInInstanceBinding } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { LOCAL_USER } from '@/api/local/localSession'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { availableStandInDevices } from './standInDevices'

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
  const [localDeviceId, setLocalDeviceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const operation = useRef(false)
  const api = services.standInApi
  useEffect(() => {
    if (!active || operation.current) return
    let current = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity || !api) throw new Error('Executor identity is unavailable')
      if (current) setLocalDeviceId(identity.deviceId)
      let value = await api.binding(identity.deviceId)
      if (!current) return
      if (value.status === 'unbound') {
        const owned = await api.personalGet(userId, identity.deviceId)
        const local =
          userId === LOCAL_USER.id ? owned : await api.personalGet(LOCAL_USER.id, identity.deviceId)
        if (!current) return
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
        const localOwner = !initialDeviceId && !configured(owned) && configured(local)
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
          if (!current) return
        }
        value = await api.binding(identity.deviceId, 'bind', value.version, target)
        // Persist the binding first: a failed start remains bound and recoverable by stopping.
        try {
          await api.lifecycle(target.userId, target.deviceId, 'start')
        } catch (cause) {
          if (current) setBinding(value)
          throw cause
        }
      }
      if (current) {
        setBinding(value)
        setError(null)
      }
    })().catch(cause => {
      if (current) setError(getStandInErrorMessage(cause, 'load_settings_failed'))
    })
    return () => {
      current = false
    }
  }, [api, services, userId, devices, connected, active, attempt, backendUrl, initialDeviceId])

  const run = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(getStandInErrorMessage(cause, 'save_settings_failed'))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  const stop = (version: number) =>
    run(async () => {
      if (!api || !binding?.target || !localDeviceId) return
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
    })
  const bind = (target: StandInBindingTarget) =>
    run(async () => {
      if (!api || !binding || !localDeviceId || binding.status !== 'stopped') return
      const next = await api.binding(localDeviceId, 'bind', binding.version, target)
      try {
        await api.lifecycle(target.userId, target.deviceId, 'start')
      } finally {
        setBinding(next)
      }
    })
  return {
    binding,
    localDeviceId,
    busy,
    error,
    stop,
    bind,
    reload: () => setAttempt(value => value + 1),
  }
}
