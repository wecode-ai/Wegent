import type { StandInTaskPermissions } from '@/api/personalStandIn'
import { PermissionModeSelector } from '@/components/chat/composer/PermissionModeSelector'
import { SettingsRow } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInTaskPermissionSettings({
  value,
  disabled,
  onChange,
}: {
  value?: StandInTaskPermissions
  disabled: boolean
  onChange(value: StandInTaskPermissions): void
}) {
  const { t } = useTranslation('common')
  return (
    <SettingsRow
      data-testid="stand-in-task-permissions"
      className="px-0 max-md:[&_button]:min-h-11"
      label={t('standIn.workspace.task_permissions')}
      description={t('standIn.workspace.task_permissions_help')}
    >
      <PermissionModeSelector
        value={value?.permissionMode ?? 'read-only'}
        commandApproval={value?.commandApproval}
        disabled={disabled}
        showChevron
        onChange={(permissionMode, commandApproval) => {
          const approval = commandApproval ?? value?.commandApproval
          onChange({ permissionMode, ...(approval ? { commandApproval: approval } : {}) })
        }}
        onCommandApprovalChange={commandApproval =>
          onChange({ permissionMode: 'full-access', commandApproval })
        }
      />
    </SettingsRow>
  )
}
