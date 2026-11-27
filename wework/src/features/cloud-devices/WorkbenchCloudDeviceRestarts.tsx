import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createSettingsDeviceApi } from '@/components/settings/settings-cloud-api'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { DeviceInfo } from '@/types/api'
import { CloudDeviceRestartDialog } from './CloudDeviceRestartDialog'
import { CloudDeviceRestartNotice } from './CloudDeviceRestartNotice'
import { busyCloudSandboxIds } from './cloudDeviceUpgradeReminder'
import { createCloudDeviceRestartSource } from './cloudDeviceRestartSource'
import {
  CloudDeviceRestartContext,
  cloudDeviceRestartKey,
  useWorkbenchCloudDeviceRestarts,
} from './useWorkbenchCloudDeviceRestarts'

export function WorkbenchCloudDeviceRestarts({
  devices,
  refreshDevices,
  children,
}: {
  devices: DeviceInfo[]
  refreshDevices: () => Promise<void>
  children: ReactNode
}) {
  const connection = useOptionalCloudConnection()
  const { apiBaseUrl, user } = connection
  const userId = user?.id
  const reminderScope = apiBaseUrl && userId != null ? JSON.stringify([apiBaseUrl, userId]) : null
  const [owner, setOwner] = useState(() => ({
    apiBaseUrl,
    userId,
    source: createCloudDeviceRestartSource(),
  }))
  if (owner.apiBaseUrl !== apiBaseUrl || owner.userId !== userId)
    setOwner({ apiBaseUrl, userId, source: createCloudDeviceRestartSource() })
  const source = owner.source
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(listener, {
        devices,
        reminderScope,
        refreshDevices,
        restart: (deviceId, forceStopTasks) =>
          createSettingsDeviceApi(connection).restartCloudDevice(deviceId, forceStopTasks),
      }),
    [source, devices, refreshDevices, connection, reminderScope]
  )
  const { confirmation, progress, upgrade } = useSyncExternalStore(subscribe, source.getSnapshot)
  const busySandboxes = useMemo(
    () => (upgrade ? busyCloudSandboxIds(devices) : null),
    [upgrade, devices]
  )
  const sandboxId = confirmation[0]?.cloud_config?.sandboxId
  const requestRestart = source.requestRestart
  const actions = useMemo(
    () => ({
      requestRestart,
      remindOnUse: source.remindOnUse,
      progress,
      isConfirming: confirmation.length > 0,
      isRestarting: (device: DeviceInfo) =>
        ['submitting', 'waiting-offline', 'waiting-online'].includes(
          progress[cloudDeviceRestartKey(device)]?.phase ?? 'idle'
        ),
    }),
    [source, requestRestart, progress, confirmation.length]
  )

  return (
    <CloudDeviceRestartContext.Provider value={actions}>
      {children}
      <CloudDeviceRestartDialog
        devices={confirmation.map(target => {
          if (!upgrade) return target
          const current = devices.find(device => device.device_id === target.device_id)
          return current
            ? { ...current, cloud_upgrade_reminder: target.cloud_upgrade_reminder }
            : { ...target, status: 'offline' }
        })}
        upgrade={upgrade}
        sandboxBusy={Boolean(sandboxId && busySandboxes?.has(sandboxId))}
        overlayClassName="z-[10001]"
        onCancel={source.cancel}
        onConfirm={source.confirm}
      />
    </CloudDeviceRestartContext.Provider>
  )
}

export function CloudDeviceRestartProgress({
  device,
  compact,
}: {
  device: DeviceInfo
  compact?: boolean
}) {
  const actions = useWorkbenchCloudDeviceRestarts()
  const progress = actions?.progress[cloudDeviceRestartKey(device)]
  if (!progress) return null

  return (
    <CloudDeviceRestartNotice
      deviceId={device.device_id}
      phase={progress.phase}
      error={progress.error}
      upgrade={progress.upgrade}
      compact={compact}
      onRetry={() => actions?.requestRestart([progress.device], progress.upgrade)}
      onRefresh={progress.onRefresh}
    />
  )
}
