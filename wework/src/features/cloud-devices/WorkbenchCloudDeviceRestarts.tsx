import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createSettingsDeviceApi } from '@/components/settings/settings-cloud-api'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { DeviceInfo } from '@/types/api'
import { CloudDeviceRestartDialog } from './CloudDeviceRestartDialog'
import { CloudDeviceRestartNotice } from './CloudDeviceRestartNotice'
import { useDeviceOfflineLifecycleAction } from './useDeviceOfflineLifecycleAction'
import {
  CloudDeviceRestartContext,
  cloudDeviceRestartKey,
  useWorkbenchCloudDeviceRestarts,
  type DeviceRestartProgress,
} from './useWorkbenchCloudDeviceRestarts'

function RestartRequest({
  target,
  device,
  refreshDevices,
  onProgress,
}: {
  target: DeviceInfo
  device: DeviceInfo | undefined
  refreshDevices: () => Promise<void>
  onProgress: (key: string, progress: DeviceRestartProgress | null) => void
}) {
  const connection = useOptionalCloudConnection()
  const requestAction = useCallback(
    () => createSettingsDeviceApi(connection).restartCloudDevice(target.device_id),
    [connection, target.device_id]
  )
  const { run, phase, error, refreshAfterTimeout } = useDeviceOfflineLifecycleAction({
    status: device?.status ?? 'offline',
    runtimeInstanceId: device?.runtime_instance_id,
    requestAction,
    refreshDevices,
  })
  const started = useRef(false)
  const submitted = useRef(false)
  const key = cloudDeviceRestartKey(target)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
  }, [run])

  useEffect(() => {
    if (phase !== 'idle') {
      submitted.current = true
      onProgress(key, { device: target, phase, error, onRefresh: refreshAfterTimeout })
    } else if (submitted.current) {
      onProgress(key, null)
    }
  }, [error, key, onProgress, phase, refreshAfterTimeout, target])

  return null
}

export function WorkbenchCloudDeviceRestarts({
  devices,
  refreshDevices,
  children,
}: {
  devices: DeviceInfo[]
  refreshDevices: () => Promise<void>
  children: ReactNode
}) {
  const [confirmation, setConfirmation] = useState<DeviceInfo[]>([])
  const [requests, setRequests] = useState<Record<string, { target: DeviceInfo; attempt: number }>>(
    {}
  )
  const [progress, setProgress] = useState<Record<string, DeviceRestartProgress>>({})
  const locks = useRef(new Set<string>())
  const nextAttempt = useRef(0)

  const requestRestart = useCallback((targets: DeviceInfo[]) => {
    const bySandbox = new Map<string, DeviceInfo>()
    for (const target of targets) {
      const key = cloudDeviceRestartKey(target)
      if (!locks.current.has(key) && !bySandbox.has(key)) bySandbox.set(key, target)
    }
    setConfirmation([...bySandbox.values()])
  }, [])

  const confirmRestart = () => {
    const confirmed = confirmation.filter(
      target => !locks.current.has(cloudDeviceRestartKey(target))
    )
    const next = Object.fromEntries(
      confirmed.map(target => {
        const key = cloudDeviceRestartKey(target)
        locks.current.add(key)
        return [key, { target, attempt: nextAttempt.current++ }]
      })
    )
    setRequests(current => ({ ...current, ...next }))
    setConfirmation([])
  }

  const onProgress = useCallback((key: string, next: DeviceRestartProgress | null) => {
    if (!next || next.phase === 'error' || next.phase === 'timeout' || next.phase === 'recovered') {
      locks.current.delete(key)
    } else {
      locks.current.add(key)
    }
    setProgress(current => {
      if (next) return { ...current, [key]: next }
      const remaining = { ...current }
      delete remaining[key]
      return remaining
    })
    if (!next) {
      setRequests(current => {
        const remaining = { ...current }
        delete remaining[key]
        return remaining
      })
    }
  }, [])

  const actions = useMemo(
    () => ({
      requestRestart,
      progress,
      isRestarting: (device: DeviceInfo) =>
        ['submitting', 'waiting-offline', 'waiting-online'].includes(
          progress[cloudDeviceRestartKey(device)]?.phase ?? 'idle'
        ),
    }),
    [requestRestart, progress]
  )

  return (
    <CloudDeviceRestartContext.Provider value={actions}>
      {children}
      {Object.values(requests).map(({ target, attempt }) => (
        <RestartRequest
          key={attempt}
          target={target}
          device={devices.find(device => device.device_id === target.device_id)}
          refreshDevices={refreshDevices}
          onProgress={onProgress}
        />
      ))}
      <CloudDeviceRestartDialog
        devices={confirmation}
        overlayClassName="z-[10001]"
        onCancel={() => setConfirmation([])}
        onConfirm={confirmRestart}
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
