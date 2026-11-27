import { standInRoleName, type StandInRole } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
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

export function StandInMigration({
  devices,
  sourceDevice,
  roles,
  busy,
  onDismiss,
  requestLeave,
  onMigrate,
}: {
  devices: DeviceInfo[]
  sourceDevice: string
  roles: StandInRole[]
  busy: boolean
  onDismiss(): void
  requestLeave(action: () => void): void
  onMigrate(deviceId: string, roleId?: string): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState('')
  const [roleId, setRoleId] = useState('@primary')
  const [confirmation, setConfirmation] = useState<DeviceInfo>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = availableStandInDevices(devices).filter(
    device => device.device_id !== sourceDevice
  )
  const device = target
    ? available.find(device => device.device_id === target)
    : (available.find(device => device.is_default) ?? available[0])
  const confirmedDeviceAvailable = available.some(
    device => device.device_id === confirmation?.device_id
  )
  const disabled = busy || pending
  if (!available.length && !disabled && !error && !confirmation) return null
  const migrate = async () => {
    if (disabled || !confirmation || !confirmedDeviceAvailable) return
    setPending(true)
    setError(null)
    try {
      await onMigrate(confirmation.device_id, roleId === '@primary' ? undefined : roleId)
      onDismiss()
    } catch (cause) {
      setConfirmation(undefined)
      if (cause instanceof StandInMigrationError) setError(t(`standIn.migration.${cause.code}`))
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-4 text-sm"
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
          <SelectItem value="@primary">{t('standIn.personal.default_role')}</SelectItem>
          {roles.map((role, index) => (
            <SelectItem key={role.id} value={String(role.id)}>
              {standInRoleName(role, index, t('standIn.personal.unnamed_assistant'))}
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
        onClick={() => {
          if (device) requestLeave(() => setConfirmation(device))
        }}
        className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
      >
        {t('standIn.migration.action')}
      </ControlButton>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="stand-in-migrate-keep-local"
        disabled={disabled}
        onClick={onDismiss}
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
        open={!!confirmation}
        title={t('standIn.migration.title', { device: confirmation?.name })}
        description={t('standIn.migration.description')}
        cancelLabel={t('standIn.migration.keep_local')}
        confirmLabel={t('standIn.migration.action')}
        confirmTestId="stand-in-migrate-confirm"
        cancelTestId="stand-in-migrate-cancel"
        pending={disabled}
        confirmDisabled={!confirmedDeviceAvailable}
        onClose={() => setConfirmation(undefined)}
        onConfirm={() => void migrate()}
      />
    </div>
  )
}
