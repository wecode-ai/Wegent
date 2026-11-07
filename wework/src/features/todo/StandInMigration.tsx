import { useState } from 'react'
import type { DeviceInfo } from '@/types/api'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { availableStandInDevices } from './standInDevices'
import { migrateStandIn, StandInMigrationError } from './migrateStandIn'

export function StandInMigration({
  api,
  devices,
  sourceUser,
  sourceDevice,
  roleId,
  targetUser,
  requestLeave,
  onMigrated,
}: {
  api: StandInExecutorApi
  devices: DeviceInfo[]
  sourceUser: number
  sourceDevice: string
  roleId?: string
  targetUser: number
  requestLeave(action: () => void): void
  onMigrated(deviceId: string, roleId: string): void
}) {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = availableStandInDevices(devices)
  const selected =
    target || (available.find(device => device.is_default) ?? available[0])?.device_id
  const device = available.find(device => device.device_id === selected)
  if (dismissed || (!available.length && !pending && !error)) return null
  const migrate = async () => {
    if (pending || !device) return
    setPending(true)
    setError(null)
    try {
      const role = await migrateStandIn(api, {
        sourceUser,
        sourceDevice,
        roleId,
        targetUser,
        targetDevice: device.device_id,
        primaryName: t('standIn.title'),
      })
      setConfirm(false)
      onMigrated(device.device_id, role.id)
    } catch (cause) {
      setConfirm(false)
      setError(
        cause instanceof StandInMigrationError
          ? t(`standIn.migration.${cause.code}`)
          : getStandInErrorMessage(cause)
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-5 py-2 text-sm"
      data-testid="stand-in-migration"
    >
      <p className="min-w-0 flex-1">{t('standIn.migration.offer')}</p>
      <select
        data-testid="stand-in-migration-device"
        aria-label={t('standIn.device')}
        value={selected ?? ''}
        disabled={pending}
        onChange={event => setTarget(event.target.value)}
        className="min-h-11 max-w-full rounded-md border border-border bg-background px-2 md:min-h-8"
      >
        {available.map(device => (
          <option key={device.device_id} value={device.device_id}>
            {device.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="stand-in-migrate-open"
        disabled={pending || !device}
        onClick={() => requestLeave(() => setConfirm(true))}
        className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
      >
        {t('standIn.migration.action')}
      </button>
      <button
        type="button"
        data-testid="stand-in-migrate-keep-local"
        disabled={pending}
        onClick={() => setDismissed(true)}
        className="min-h-11 rounded-md px-3 hover:bg-muted md:min-h-8"
      >
        {t('standIn.migration.keep_local')}
      </button>
      {error && (
        <p role="alert" className="w-full text-error">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('standIn.migration.title', { device: device?.name })}
        description={t('standIn.migration.description')}
        cancelLabel={t('standIn.migration.keep_local')}
        confirmLabel={t('standIn.migration.action')}
        confirmTestId="stand-in-migrate-confirm"
        cancelTestId="stand-in-migrate-cancel"
        pending={pending}
        confirmDisabled={!device}
        onClose={() => setConfirm(false)}
        onConfirm={() => void migrate()}
      />
    </div>
  )
}
