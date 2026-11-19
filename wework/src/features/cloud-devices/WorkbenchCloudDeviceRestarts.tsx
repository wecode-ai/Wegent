import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createSettingsDeviceApi } from '@/components/settings/settings-cloud-api'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { DeviceInfo } from '@/types/api'
import { CloudDeviceRestartDialog } from './CloudDeviceRestartDialog'
import { CloudDeviceRestartNotice } from './CloudDeviceRestartNotice'
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
  const [owner, setOwner] = useState(() => ({
    apiBaseUrl,
    userId: user?.id,
    source: createCloudDeviceRestartSource(),
  }))
  if (owner.apiBaseUrl !== apiBaseUrl || owner.userId !== user?.id)
    setOwner({ apiBaseUrl, userId: user?.id, source: createCloudDeviceRestartSource() })
  const source = owner.source
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(listener, {
        devices,
        refreshDevices,
        restart: deviceId => createSettingsDeviceApi(connection).restartCloudDevice(deviceId),
      }),
    [source, devices, refreshDevices, connection]
  )
  const { confirmation, progress } = useSyncExternalStore(subscribe, source.getSnapshot)
  const requestRestart = source.requestRestart
  const actions = useMemo(
    () => ({
      requestRestart,
      progress,
      isConfirming: confirmation.length > 0,
      isRestarting: (device: DeviceInfo) =>
        ['submitting', 'waiting-offline', 'waiting-online'].includes(
          progress[cloudDeviceRestartKey(device)]?.phase ?? 'idle'
        ),
    }),
    [requestRestart, progress, confirmation.length]
  )

  return (
    <CloudDeviceRestartContext.Provider value={actions}>
      {children}
      <CloudDeviceRestartDialog
        devices={confirmation}
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
      compact={compact}
      onRetry={() => actions?.requestRestart([device])}
      onRefresh={progress.onRefresh}
    />
  )
}
