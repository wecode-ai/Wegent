import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { AddDevicePanel } from '@/components/devices/AddDevicePanel'
import type { DeviceOnboardingConnection } from '@/components/devices/useDeviceOnboarding'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'

interface AddCloudDeviceDialogProps {
  open: boolean
  hasCloudDevice?: boolean
  cloudConnection: DeviceOnboardingConnection
  onClose: () => void
  onCreated: (devices?: DeviceInfo[], createdDeviceId?: number) => void | Promise<void>
  onCreatingChange?: (creating: boolean) => void
}

export function AddCloudDeviceDialog(props: AddCloudDeviceDialogProps) {
  const { open, cloudConnection, hasCloudDevice, onClose, onCreated, onCreatingChange } = props
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(() => {
    if (!busy) onClose()
  }, open)
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
      onClick={event => {
        if (!busy && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.add_device_dialog_title')}
        data-testid="add-cloud-device-dialog"
        className="max-h-[calc(100vh-32px)] w-full max-w-[800px] overflow-hidden rounded-[20px] border border-border bg-popover shadow-lg"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
            <Plus className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="heading-base text-text-primary">
              {t('workbench.add_device_dialog_title')}
            </h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              {t('workbench.add_device_dialog_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="add-cloud-device-close"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
            className="shrink-0 rounded-md p-1 text-text-muted hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 max-h-[calc(100vh-176px)] overflow-y-auto px-5 pb-1">
          <AddDevicePanel
            cloudConnection={cloudConnection}
            hasCloudDevice={hasCloudDevice}
            onBusyChange={setBusy}
            onCreatingChange={onCreatingChange}
            onCreated={async (devices, id) => {
              await onCreated(devices, id)
              onClose()
            }}
            onConnected={async (devices, device) => {
              await onCreated(devices, device.id)
              onClose()
            }}
          />
        </div>
        <div className="flex justify-end px-5 pb-5 pt-4">
          <button
            type="button"
            data-testid="add-cloud-device-cancel"
            onClick={onClose}
            disabled={busy}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
