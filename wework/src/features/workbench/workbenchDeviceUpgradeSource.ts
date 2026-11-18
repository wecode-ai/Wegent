import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { canRequestDeviceUpgrade, isWeWorkCompatibleDevice } from '@/lib/device-capabilities'
import type {
  DeviceSlotUpdatePayload,
  DeviceUpgradeState,
  DeviceUpgradeStatusPayload,
} from '@/types/device-events'
import type { WorkbenchState } from '@/types/workbench'
import {
  UPGRADE_REFRESH_INTERVAL_MS,
  UPGRADE_STATE_CLEAR_DELAY_MS,
  getUpgradeStatusMessage,
  isTerminalDeviceUpgradeStatus,
} from './workbenchProviderHelpers'
import type { WorkbenchAction } from './workbenchReducer'
import type { WorkbenchServices } from './workbenchServices'

export interface WorkbenchDeviceUpgradeInput {
  state: Pick<WorkbenchState, 'devices'>
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  refreshDevices: (options?: { useCacheFallback?: boolean }) => Promise<void>
}

/** One workbench owns device progress, transport observations and expiry deadlines. */
export function createWorkbenchDeviceUpgradeSource() {
  let snapshot: Record<string, DeviceUpgradeState> = {}
  let input: WorkbenchDeviceUpgradeInput | undefined
  const listeners = new Set<() => void>()
  const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const deadlines = new Map<string, number>()
  let stopStream: (() => void) | undefined
  let stream: WorkbenchServices['chatStream'] | undefined
  let streamRevision = 0
  let observation = 0
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let devices: WorkbenchState['devices'] | undefined
  const refresh = (options?: { useCacheFallback?: boolean }) => input!.refreshDevices(options)
  const reconcilePolling = () => {
    const active = Object.values(snapshot).some(
      state => !isTerminalDeviceUpgradeStatus(state.status)
    )
    if (!listeners.size || !active) {
      clearInterval(pollTimer)
      pollTimer = undefined
    } else if (pollTimer === undefined) {
      pollTimer = setInterval(() => {
        if (polling || !input) return
        polling = true
        void refresh()
          .catch(() => undefined)
          .finally(() => {
            polling = false
          })
      }, UPGRADE_REFRESH_INTERVAL_MS)
    }
  }
  const publish = (next: typeof snapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
    reconcilePolling()
  }
  const clearExpiry = (deviceId: string) => {
    clearTimeout(clearTimers.get(deviceId))
    clearTimers.delete(deviceId)
    deadlines.delete(deviceId)
  }
  const expire = (deviceId: string) => {
    clearExpiry(deviceId)
    if (!snapshot[deviceId]) return
    const next = { ...snapshot }
    delete next[deviceId]
    publish(next)
  }
  const armExpiry = (deviceId: string, deadline: number) => {
    clearTimeout(clearTimers.get(deviceId))
    if (!listeners.size) return
    clearTimers.set(
      deviceId,
      setTimeout(() => expire(deviceId), Math.max(0, deadline - Date.now()))
    )
  }
  const setUpgrade = (deviceId: string, state: DeviceUpgradeState) => {
    clearExpiry(deviceId)
    publish({ ...snapshot, [deviceId]: state })
    if (isTerminalDeviceUpgradeStatus(state.status)) {
      const deadline = Date.now() + UPGRADE_STATE_CLEAR_DELAY_MS
      deadlines.set(deviceId, deadline)
      armExpiry(deviceId, deadline)
    }
  }
  function connect() {
    if (!input || (stream === input.services.chatStream && stopStream)) return
    stopStream?.()
    stream = input.services.chatStream
    const epoch = ++streamRevision
    const current = () => epoch === streamRevision && listeners.size > 0
    const refreshAfterEvent = () => {
      if (current()) void refresh({ useCacheFallback: false }).catch(() => undefined)
    }
    stopStream = stream.subscribe({
      onDeviceOnline: refreshAfterEvent,
      onDeviceOffline: refreshAfterEvent,
      onDeviceStatus: refreshAfterEvent,
      onDeviceSlotUpdate(payload: DeviceSlotUpdatePayload) {
        if (current()) input!.dispatch({ type: 'device_slot_updated', payload })
      },
      onDeviceUpgradeStatus(payload: DeviceUpgradeStatusPayload) {
        if (!current()) return
        setUpgrade(payload.device_id, {
          status: payload.status,
          message: getUpgradeStatusMessage(payload),
          progress: payload.progress,
          error: payload.error,
        })
        if (payload.status === 'success' || payload.status === 'skipped')
          void refresh().catch(() => undefined)
      },
    })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: WorkbenchDeviceUpgradeInput) {
      input = next
      const revision = ++observation
      listeners.add(listener)
      connect()
      if (devices !== next.state.devices) {
        devices = next.state.devices
        for (const deviceId of Object.keys(snapshot)) {
          const device = devices.find(candidate => candidate.device_id === deviceId)
          if (device?.status === 'online' && isWeWorkCompatibleDevice(device)) expire(deviceId)
        }
      }
      for (const [deviceId, deadline] of deadlines) armExpiry(deviceId, deadline)
      reconcilePolling()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || observation !== revision) return
          streamRevision += 1
          stopStream?.()
          stopStream = undefined
          clearInterval(pollTimer)
          pollTimer = undefined
          for (const timer of clearTimers.values()) clearTimeout(timer)
          clearTimers.clear()
        })
      }
    },
    async upgradeDevice(deviceId: string) {
      if (!input) return
      const owner = input
      const device = owner.state.devices.find(item => item.device_id === deviceId)
      if (device && !canRequestDeviceUpgrade(device)) {
        const message =
          device.status !== 'online'
            ? '设备离线，恢复在线后再升级'
            : '设备正在执行任务，空闲后再升级'
        setUpgrade(deviceId, { status: 'busy', message })
        owner.dispatch({ type: 'error_set', error: message })
        return
      }
      setUpgrade(deviceId, { status: 'pending', message: '正在发送升级指令' })
      try {
        await owner.executorClient.commands.upgradeDevice(deviceId, { auto_confirm: true })
        setUpgrade(deviceId, { status: 'checking', message: '升级指令已发送，正在等待设备更新' })
        void owner.refreshDevices().catch(() => undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : '升级失败'
        setUpgrade(deviceId, { status: 'error', message, error: message })
        owner.dispatch({ type: 'error_set', error: message })
      }
    },
  }
}
