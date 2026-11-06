import { useState, type ReactNode } from 'react'
import { isCloudDevice, isRemoteDevice, isUsableDevice } from '@/lib/device-capabilities'
import { navigateTo } from '@/lib/navigation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { StandInSettingsHeader } from './StandInSettingsLayout'

export function StandInCreationDevice({
  devices,
  onCancel,
  children,
}: {
  devices: DeviceInfo[]
  onCancel?(): void
  children(deviceId: string): ReactNode
}) {
  const { t } = useTranslation('common')
  const available = devices.filter(
    device => (isCloudDevice(device) || isRemoteDevice(device)) && isUsableDevice(device)
  )
  const initial = available.length === 1 ? available[0].device_id : ''
  const [selected, setSelected] = useState(initial)
  // Keep the chosen device stable if its status changes while the user edits a draft.
  if (!selected && initial) setSelected(initial)
  const dialog = useDialogKeyboard<HTMLElement>(() => onCancel?.(), !selected)
  if (selected) return children(selected)
  return (
    <section
      ref={dialog}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5"
      data-testid="stand-in-settings"
    >
      <StandInSettingsHeader
        title={t('standIn.personal.create_title')}
        description={t('standIn.cloud_device_description')}
        disabled={false}
        close={onCancel ? { testId: 'stand-in-close', onClick: onCancel } : undefined}
      />
      {available.length ? (
        <label className="space-y-2 text-sm">
          <span>{t('standIn.device')}</span>
          <StandInDeviceSelect
            value=""
            currentDeviceId=""
            devices={available}
            disabled={false}
            includeCurrent={false}
            onChange={setSelected}
          />
        </label>
      ) : (
        <>
          <p role="status" className="text-sm text-text-muted">
            {t('standIn.no_cloud_device')}
          </p>
          <button
            type="button"
            data-testid="stand-in-open-cloud-work"
            className="mt-3 min-h-11 self-start rounded-lg border border-border px-3 text-sm md:min-h-9"
            onClick={() => {
              onCancel?.()
              navigateTo('/cloud-work')
            }}
          >
            {t('workbench.cloud_work_entry')}
          </button>
        </>
      )}
    </section>
  )
}
