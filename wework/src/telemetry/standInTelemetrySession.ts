import { getWorkbenchDeviceIds } from '@/lib/workbench-device'
import { telemetryExecutionTarget } from './executionTarget'
import type { ExecutionTarget } from './events'
import type { TaskSource } from '@/features/notifications/NotificationTaskSourceContext'
import { standInCollectionSince } from './client'
import {
  clearStandInDeliveries,
  createStandInDelivery,
  queuedStandInDevices,
} from './standInDelivery'

export interface StandInTelemetryInput {
  mainWindow: boolean
  source: TaskSource | null
  backendUrl: string
  userId: number | undefined
  policy: boolean | null
}

/** The window owns collection; admitted durable consent writes finish in their original scope. */
export function createStandInTelemetrySession() {
  let signature: readonly unknown[] | undefined
  let stop: (() => void) | undefined
  let localRuntimeConfiguration: {
    api: NonNullable<TaskSource['services']>['standInApi']
    key: string
    target: string | null
    promise: Promise<unknown>
  } | null = null
  const update = (input: StandInTelemetryInput) => {
    const { source, userId, policy } = input
    const api = source?.services?.standInApi
    const identity = source?.services?.getLocalRuntimeSidebarIdentity
    const accountKey = JSON.stringify([input.backendUrl, userId])
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
    const next = [input.mainWindow, api, identity, accountKey, policy, devices]
    if (signature && next.every((value, index) => value === signature![index])) return
    signature = next
    stop?.()
    stop = undefined
    stop = (() => {
      if (!input.mainWindow || !api || !identity || userId == null || policy == null) return
      if (!policy) clearStandInDeliveries(accountKey)
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
            const delivery = createStandInDelivery(`${accountKey}:${deviceId}`)
            if (!policy) delivery.clear()
            try {
              const enabledSince = standInCollectionSince()
              const localTarget =
                deviceId === local.deviceId && local.runtimeInstanceId
                  ? JSON.stringify([accountKey, deviceId, local.runtimeInstanceId])
                  : null
              const localRuntime = localTarget
                ? JSON.stringify([localTarget, policy, enabledSince])
                : null
              const previousConfiguration = localRuntimeConfiguration
              // Consent is durable. Reapply it for a new local Runtime, not every
              // delivery poll; remote devices have no freshly verified instance here.
              if (
                !localRuntime ||
                previousConfiguration?.api !== api ||
                previousConfiguration.key !== localRuntime
              ) {
                // A late old policy must not overwrite an acknowledged refusal.
                const previousWrite =
                  localTarget && previousConfiguration?.target === localTarget
                    ? previousConfiguration.promise.catch(() => undefined)
                    : Promise.resolve()
                const configuration = {
                  api,
                  key: localRuntime ?? '',
                  target: localTarget,
                  promise: previousWrite.then(() =>
                    api.configureTelemetry(userId, deviceId, policy, enabledSince)
                  ),
                }
                if (localRuntime) localRuntimeConfiguration = configuration
                try {
                  await configuration.promise
                } catch (error) {
                  if (localRuntimeConfiguration === configuration) localRuntimeConfiguration = null
                  throw error
                }
              } else {
                await previousConfiguration.promise
              }
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
              for (const deviceId of queuedStandInDevices(accountKey)) {
                if (!active) break
                await createStandInDelivery(`${accountKey}:${deviceId}`).flush(() => active)
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
    })()
  }
  return {
    update,
    stop() {
      stop?.()
      stop = undefined
      signature = undefined
    },
  }
}
