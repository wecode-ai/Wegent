import type { StandInRole } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { DeviceInfo } from '@/types/api'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useState } from 'react'
import { StandInMigrationError } from './migrateStandIn'
import { availableStandInDevices } from './standInDevices'

/** Migration is available only on the stopped instance surface. */
export function StandInMigration({
  devices,
  sourceDevice,
  roles,
  busy,
  onMigrate,
}: {
  devices: DeviceInfo[]
  sourceDevice: string
  roles: StandInRole[]
  busy: boolean
  onMigrate(deviceId: string, roleId?: string): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState('')
  const [roleId, setRoleId] = useState('@primary')
  const [dismissed, setDismissed] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = availableStandInDevices(devices).filter(
    device => device.device_id !== sourceDevice
  )
  const device =
    available.find(device => device.device_id === target) ??
    available.find(device => device.is_default) ??
    available[0]
  const disabled = busy || pending
  if (dismissed || (!available.length && !disabled && !error)) return null
  const migrate = async () => {
    if (disabled || !device) return
    setPending(true)
    setError(null)
    try {
      await onMigrate(device.device_id, roleId === '@primary' ? undefined : roleId)
      setConfirm(false)
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
      className="flex flex-wrap items-center gap-2 border-t border-border py-4 text-sm"
      data-testid="stand-in-migration"
    >
      <p className="w-full">{t('standIn.migration.offer')}</p>
      <SelectRoot
        value={normalizeSelectValue(roleId)}
        disabled={disabled}
        onValueChange={selectedValue => {
          if (selectedValue !== null) return setRoleId(selectedValue)
        }}
      >
        <SelectTrigger
          density="compact"
          data-testid="stand-in-migration-role"
          aria-label={t('standIn.migration.profile')}
          className="max-w-full"
        />
        <SelectContent>
          <SelectItem value="@primary">{t('standIn.title')}</SelectItem>
          {roles.map(role => (
            <SelectItem key={role.id} value={String(role.id)}>
              {role.name || role.id}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
      <SelectRoot
        value={normalizeSelectValue(device?.device_id ?? '')}
        disabled={disabled}
        onValueChange={selectedValue => {
          if (selectedValue !== null) return setTarget(selectedValue)
        }}
      >
        <SelectTrigger
          density="compact"
          data-testid="stand-in-migration-device"
          aria-label={t('standIn.device')}
          className="max-w-full"
        />
        <SelectContent>
          {available.map(value => (
            <SelectItem key={value.device_id} value={String(value.device_id)}>
              {value.name}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
      <ControlButton
        variant="primary"
        size="sm"
        type="button"
        data-testid="stand-in-migrate-open"
        disabled={disabled || !device}
        onClick={() => setConfirm(true)}
        className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
      >
        {t('standIn.migration.action')}
      </ControlButton>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="stand-in-migrate-keep-local"
        disabled={disabled}
        onClick={() => setDismissed(true)}
        className="min-h-11 rounded-md px-3 hover:bg-muted md:min-h-8"
      >
        {t('standIn.migration.keep_local')}
      </ControlButton>
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
        pending={disabled}
        confirmDisabled={!device}
        onClose={() => setConfirm(false)}
        onConfirm={() => void migrate()}
      />
    </div>
  )
}
