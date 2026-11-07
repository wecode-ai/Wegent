import { useEffect, useState, type ReactNode } from 'react'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { availableStandInDevices } from './standInDevices'

export function StandInCreationDevice({
  devices,
  services,
  requestLeave,
  children,
}: {
  devices: DeviceInfo[]
  services: WorkbenchServices
  requestLeave(action: () => void): void
  children(deviceId: string, local: boolean): ReactNode
}) {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState<{ local: string; selected: string }>()
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity) throw new Error('Executor identity is unavailable')
      if (active) {
        const available = availableStandInDevices(devices)
        const preferred = available.find(device => device.is_default) ?? available[0]
        setTarget(
          previous =>
            previous ?? {
              local: identity.deviceId,
              selected: preferred?.device_id ?? identity.deviceId,
            }
        )
        setError(null)
      }
    })().catch(cause => {
      if (active) setError(getStandInErrorMessage(cause, 'load_settings_failed'))
    })
    return () => {
      active = false
    }
  }, [services, devices, attempt])
  if (!target)
    return error ? (
      <div role="alert" className="p-5 text-sm text-error">
        {error}
        <button
          type="button"
          data-testid="stand-in-device-retry"
          className="ml-2 min-h-11 underline"
          onClick={() => setAttempt(value => value + 1)}
        >
          {t('standIn.reload')}
        </button>
      </div>
    ) : (
      <p role="status" className="p-5 text-sm">
        {t('standIn.loading')}
      </p>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="flex items-center gap-2 border-b border-border px-5 py-2 text-sm">
        <span>{t('standIn.device')}</span>
        <StandInDeviceSelect
          value={target.selected}
          currentDeviceId={target.local}
          devices={devices.filter(device => isCloudDevice(device) || isRemoteDevice(device))}
          disabled={false}
          onChange={selected => requestLeave(() => setTarget({ ...target, selected }))}
        />
      </label>
      {children(target.selected, target.selected === target.local)}
    </div>
  )
}
