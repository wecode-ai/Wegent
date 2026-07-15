import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { canRequestDeviceUpgrade, isWeWorkCompatibleDevice } from '@/lib/device-capabilities'
import type { DeviceUpgradeState, DeviceUpgradeStatusPayload } from '@/types/device-events'
import type { WorkbenchState } from '@/types/workbench'
import {
  UPGRADE_REFRESH_INTERVAL_MS,
  UPGRADE_STATE_CLEAR_DELAY_MS,
  getUpgradeStatusMessage,
  isTerminalDeviceUpgradeStatus,
} from './workbenchProviderHelpers'
import type { WorkbenchAction } from './workbenchReducer'
import {
  getDeviceEventId,
  getDeviceEventName,
  isDeviceStatus,
  isRecord,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'

interface UseWorkbenchDeviceUpgradesOptions {
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  refreshDevices: (options?: { useCacheFallback?: boolean }) => Promise<void>
}

export function useWorkbenchDeviceUpgrades({
  state,
  dispatch,
  executorClient,
  services,
  refreshDevices,
}: UseWorkbenchDeviceUpgradesOptions) {
  const [upgradingDevices, setUpgradingDevices] = useState<Record<string, DeviceUpgradeState>>({})
  const upgradeClearTimersRef = useRef<Record<string, number>>({})

  const clearUpgradeStateTimer = useCallback((deviceId: string) => {
    const timer = upgradeClearTimersRef.current[deviceId]
    if (!timer) return
    window.clearTimeout(timer)
    delete upgradeClearTimersRef.current[deviceId]
  }, [])

  const scheduleUpgradeStateClear = useCallback(
    (deviceId: string) => {
      clearUpgradeStateTimer(deviceId)
      upgradeClearTimersRef.current[deviceId] = window.setTimeout(() => {
        setUpgradingDevices(current => {
          const next = { ...current }
          delete next[deviceId]
          return next
        })
        delete upgradeClearTimersRef.current[deviceId]
      }, UPGRADE_STATE_CLEAR_DELAY_MS)
    },
    [clearUpgradeStateTimer]
  )

  const setDeviceUpgradeState = useCallback(
    (deviceId: string, upgradeState: DeviceUpgradeState) => {
      clearUpgradeStateTimer(deviceId)
      setUpgradingDevices(current => ({
        ...current,
        [deviceId]: upgradeState,
      }))
      if (isTerminalDeviceUpgradeStatus(upgradeState.status)) {
        scheduleUpgradeStateClear(deviceId)
      }
    },
    [clearUpgradeStateTimer, scheduleUpgradeStateClear]
  )

  const upgradeDevice = useCallback(
    async (deviceId: string) => {
      const device = state.devices.find(item => item.device_id === deviceId)
      if (device && !canRequestDeviceUpgrade(device)) {
        const message =
          device.status !== 'online'
            ? '设备离线，恢复在线后再升级'
            : '设备正在执行任务，空闲后再升级'
        setDeviceUpgradeState(deviceId, {
          status: 'busy',
          message,
        })
        dispatch({ type: 'error_set', error: message })
        return
      }

      setDeviceUpgradeState(deviceId, {
        status: 'pending',
        message: '正在发送升级指令',
      })

      try {
        await executorClient.commands.upgradeDevice(deviceId, {
          auto_confirm: true,
        })
        setDeviceUpgradeState(deviceId, {
          status: 'checking',
          message: '升级指令已发送，正在等待设备更新',
        })
        void refreshDevices().catch(() => undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : '升级失败'
        setDeviceUpgradeState(deviceId, {
          status: 'error',
          message,
          error: message,
        })
        dispatch({ type: 'error_set', error: message })
      }
    },
    [dispatch, executorClient, refreshDevices, setDeviceUpgradeState, state.devices]
  )

  useEffect(() => {
    const refreshDevicesAfterEvent = () => {
      void refreshDevices({ useCacheFallback: false }).catch(() => undefined)
    }
    const handleDeviceOnline = (payload: unknown) => {
      const deviceId = getDeviceEventId(payload)
      if (deviceId) {
        dispatch({
          type: 'device_status_changed',
          deviceId,
          status: 'online',
          name: getDeviceEventName(payload),
        })
      }
      refreshDevicesAfterEvent()
    }
    const handleDeviceOffline = (payload: unknown) => {
      const deviceId = getDeviceEventId(payload)
      if (deviceId) {
        dispatch({
          type: 'device_status_changed',
          deviceId,
          status: 'offline',
        })
      }
      refreshDevicesAfterEvent()
    }
    const handleDeviceStatus = (payload: unknown) => {
      const deviceId = getDeviceEventId(payload)
      const status = isRecord(payload) ? payload.status : undefined
      if (deviceId && isDeviceStatus(status)) {
        dispatch({
          type: 'device_status_changed',
          deviceId,
          status,
        })
      }
      refreshDevicesAfterEvent()
    }
    const handleDeviceUpgradeStatus = (payload: DeviceUpgradeStatusPayload) => {
      setDeviceUpgradeState(payload.device_id, {
        status: payload.status,
        message: getUpgradeStatusMessage(payload),
        progress: payload.progress,
        error: payload.error,
      })
      if (payload.status === 'success' || payload.status === 'skipped') {
        void refreshDevices()
      }
    }

    return services.chatStream.subscribe({
      onDeviceOnline: handleDeviceOnline,
      onDeviceOffline: handleDeviceOffline,
      onDeviceStatus: handleDeviceStatus,
      onDeviceSlotUpdate: refreshDevicesAfterEvent,
      onDeviceUpgradeStatus: handleDeviceUpgradeStatus,
    })
  }, [dispatch, refreshDevices, services.chatStream, setDeviceUpgradeState])

  useEffect(() => {
    return () => {
      Object.values(upgradeClearTimersRef.current).forEach(timer => {
        window.clearTimeout(timer)
      })
      upgradeClearTimersRef.current = {}
    }
  }, [])

  useEffect(() => {
    const hasActiveUpgrade = Object.values(upgradingDevices).some(
      upgradeState => !isTerminalDeviceUpgradeStatus(upgradeState.status)
    )
    if (!hasActiveUpgrade) return undefined

    const interval = window.setInterval(() => {
      void refreshDevices().catch(() => undefined)
    }, UPGRADE_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [refreshDevices, upgradingDevices])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUpgradingDevices(current => {
        let changed = false
        const next = { ...current }
        Object.keys(next).forEach(deviceId => {
          const device = state.devices.find(item => item.device_id === deviceId)
          if (device && device.status === 'online' && isWeWorkCompatibleDevice(device)) {
            clearUpgradeStateTimer(deviceId)
            delete next[deviceId]
            changed = true
          }
        })
        return changed ? next : current
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [clearUpgradeStateTimer, state.devices])

  return { upgradingDevices, upgradeDevice }
}
