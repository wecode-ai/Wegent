import { getWorkbenchDeviceIds } from '@/lib/workbench-device'
import { telemetryExecutionTarget } from './executionTarget'
import type { ExecutionTarget } from './events'
import { useContext, useEffect } from 'react'
import { useNotificationTaskSource } from '@/features/notifications/NotificationTaskSourceContext'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { getDshTelemetrySinks } from '@/features/dsh-runtime/dshExtensions'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { standInCollectionSince, useTelemetryEnabled } from './client'
import { getTelemetryConfig } from './config'
import {
  clearStandInDeliveries,
  createStandInDelivery,
  queuedStandInDevices,
} from './standInDelivery'

/** One main-window consumer, independent of which stand-in page is open. */
export function StandInTelemetryAgent() {
  const source = useNotificationTaskSource()
  const cloud = useContext(CloudConnectionContext)
  const preferences = useAppPreferencesState()
  const publicEnabled = useTelemetryEnabled()
  const distribution = getTelemetryConfig().distribution
  const policy =
    distribution === 'internal' || publicEnabled
      ? true
      : preferences?.loaded &&
          preferences.preferences.telemetryConsentAsked === true &&
          preferences.preferences.telemetryEnabled !== true
        ? false
        : null
  const userId = cloud?.user?.id ?? source?.userId
  const accountKey = JSON.stringify([cloud?.apiBaseUrl ?? 'local', userId])
  const api = source?.services?.standInApi
  const identity = source?.services?.getLocalRuntimeSidebarIdentity
  const devices = JSON.stringify(
    (source?.devices ?? [])
      .filter(device => device.status !== 'offline')
      .map(device => ({
        id: device.device_id,
        ids: getWorkbenchDeviceIds(device),
        location: telemetryExecutionTarget(device.device_id, [device]),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  )

  useEffect(() => {
    if (getDesktopWindowLabel() !== 'main' || !api || !identity || userId == null || policy == null)
      return
    if (!policy) clearStandInDeliveries(distribution, accountKey)
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const local = await identity()
        if (!active || !local) return
        const targets = new Map<string, ExecutionTarget>([[local.deviceId, 'local']])
        for (const device of JSON.parse(devices) as {
          id: string
          ids: string[]
          location: ExecutionTarget
        }[]) {
          if (!device.ids.includes(local.deviceId)) targets.set(device.id, device.location)
        }
        for (const [deviceId, location] of targets) {
          if (!active) return
          const delivery = createStandInDelivery(`${accountKey}:${deviceId}`, distribution)
          if (!policy) delivery.clear()
          try {
            await api.configureTelemetry(
              userId,
              deviceId,
              policy,
              distribution === 'public' ? standInCollectionSince() : undefined
            )
            if (!active || !policy) continue
            await delivery.collect(api, userId, deviceId, () => active, location)
            if (!active) return
          } catch {
            // The next poll reconnects; neither queue is acknowledged on a failed handoff.
            console.warn('[Stand-in telemetry] Device delivery pending')
          }
        }
      } catch {
        console.warn('[Stand-in telemetry] Executor connection pending')
      } finally {
        try {
          // Already handed-off facts do not depend on their Executor still being online.
          if (policy && active) {
            const sinks = getDshTelemetrySinks().map(sink => ({
              ...sink,
              accept: (fact: Parameters<typeof sink.accept>[0]) => sink.accept(fact),
            }))
            for (const deviceId of queuedStandInDevices(accountKey, distribution)) {
              if (!active) break
              await createStandInDelivery(`${accountKey}:${deviceId}`, distribution).flush(
                sinks,
                () => active
              )
            }
          }
        } catch {
          console.warn('[Stand-in telemetry] Durable delivery pending')
        }
        if (active) timer = setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [accountKey, api, devices, distribution, identity, policy, userId])

  return null
}
