import type { DeviceInfo } from '@/types/api'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { isVersionAtLeast } from '@/lib/device-capabilities'
import { claimDailyCloudUpgradeReminder, cloudUpgradeReminder } from './cloudDeviceUpgradeReminder'
import { createDeviceOfflineLifecycleSource } from './deviceOfflineLifecycleSource'
import {
  DEVICE_LIFECYCLE_POLL_INTERVAL_MS,
  DEVICE_LIFECYCLE_TIMEOUT_MS,
  DEVICE_LIFECYCLE_RECOVERED_NOTICE_MS,
} from './useDeviceOfflineLifecycleAction'
import {
  cloudDeviceRestartKey,
  type DeviceRestartProgress,
} from './useWorkbenchCloudDeviceRestarts'

interface Input {
  devices: DeviceInfo[]
  reminderScope: string | null
  refreshDevices(): Promise<void>
  restart(deviceId: string, forceStopTasks: boolean): Promise<unknown>
}
interface Request {
  target: DeviceInfo
  upgrade: boolean
  source: ReturnType<typeof createDeviceOfflineLifecycleSource>
  stop?: () => void
}

/** Explicit confirmation admits each restart; its actual lifecycle drives the shared notices. */
export function createCloudDeviceRestartSource() {
  let snapshot: {
    confirmation: DeviceInfo[]
    upgrade: boolean
    progress: Record<string, DeviceRestartProgress>
  } = {
    confirmation: [],
    upgrade: false,
    progress: {},
  }
  let input: Input | undefined
  const requests = new Map<string, Request>()
  const listeners = new Set<() => void>()
  let observation = 0
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const locked = (key: string) => {
    const phase = requests.get(key)?.source.getSnapshot().phase
    return phase === 'submitting' || phase === 'waiting-offline' || phase === 'waiting-online'
  }
  function publishProgress(key: string, request: Request) {
    if (requests.get(key) !== request) return
    const { phase, error } = request.source.getSnapshot()
    const progress = { ...snapshot.progress }
    if (phase === 'idle') {
      delete progress[key]
      request.stop?.()
      requests.delete(key)
    } else
      progress[key] = {
        device: request.target,
        upgrade: request.upgrade,
        phase,
        error,
        onRefresh: request.source.refreshAfterTimeout,
      }
    snapshot = { ...snapshot, progress }
    notify()
  }
  function bind(key: string, request: Request) {
    if (!input) return
    const device = input.devices.find(device => device.device_id === request.target.device_id)
    const targetVersion = request.upgrade
      ? request.target.cloud_upgrade_reminder?.target_version
      : null
    const previous = request.stop
    const stop = request.source.subscribe(() => publishProgress(key, request), {
      status: device?.status ?? 'offline',
      runtimeInstanceId: device?.runtime_instance_id,
      recoveryReady:
        !targetVersion ||
        Boolean(
          device?.executor_version &&
          /^v?\d+\.\d+\.\d+$/.test(device.executor_version) &&
          isVersionAtLeast(device.executor_version, targetVersion)
        ),
      requestAction: () => input!.restart(request.target.device_id, !request.upgrade),
      refreshDevices: input.refreshDevices,
      pollIntervalMs: DEVICE_LIFECYCLE_POLL_INTERVAL_MS,
      timeoutMs: DEVICE_LIFECYCLE_TIMEOUT_MS,
      recoveredNoticeMs: DEVICE_LIFECYCLE_RECOVERED_NOTICE_MS,
    })
    if (requests.get(key) === request) request.stop = stop
    else stop()
    previous?.()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: Input) {
      input = next
      const revision = ++observation
      listeners.add(listener)
      for (const [key, request] of requests) bind(key, request)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || observation !== revision) return
          for (const request of requests.values()) {
            request.stop?.()
            request.stop = undefined
          }
        })
      }
    },
    remindOnUse(deviceId: string | null | undefined) {
      const scope = input?.reminderScope
      if (!input || !scope || !listeners.size) return
      const device = findWorkbenchDevice(input.devices, deviceId)
      if (!device || !cloudUpgradeReminder(device)) return
      const key = cloudDeviceRestartKey(device)
      const storageKey = `wework:cloud-upgrade-reminder:${JSON.stringify([scope, key])}`
      void navigator.locks
        .request(storageKey, () => {
          if (
            !input ||
            input.reminderScope !== scope ||
            !listeners.size ||
            document.visibilityState !== 'visible' ||
            snapshot.confirmation.length ||
            locked(key)
          )
            return
          const current = findWorkbenchDevice(input.devices, device.device_id)
          if (!current || cloudDeviceRestartKey(current) !== key || !cloudUpgradeReminder(current))
            return
          if (!claimDailyCloudUpgradeReminder(localStorage, storageKey)) return
          snapshot = { ...snapshot, confirmation: [current], upgrade: true }
          notify()
        })
        .catch(error => console.warn('Could not show cloud device upgrade reminder', error))
    },
    requestRestart(targets: DeviceInfo[], upgrade = false) {
      if (!listeners.size) return
      const selected = new Map<string, DeviceInfo>()
      for (const target of targets) {
        const key = cloudDeviceRestartKey(target)
        if (!locked(key) && !selected.has(key)) selected.set(key, target)
      }
      snapshot = { ...snapshot, confirmation: [...selected.values()], upgrade }
      notify()
    },
    cancel() {
      snapshot = { ...snapshot, confirmation: [] }
      notify()
    },
    confirm() {
      if (!listeners.size || !input) return
      const { upgrade } = snapshot
      const targets = snapshot.confirmation.filter(target => !locked(cloudDeviceRestartKey(target)))
      snapshot = { ...snapshot, confirmation: [] }
      notify()
      for (const target of targets) {
        if (!listeners.size) break
        const key = cloudDeviceRestartKey(target)
        requests.get(key)?.stop?.()
        const request: Request = { target, upgrade, source: createDeviceOfflineLifecycleSource() }
        requests.set(key, request)
        bind(key, request)
        void request.source.run()
      }
    },
  }
}
