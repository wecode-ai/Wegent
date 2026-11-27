import { SettingsGroup, SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInSettingsEntry, type StandInSettingsShortcut } from './StandInSettingsLayout'

export function StandInSelfLearningSetting({
  enabled = false,
  disabled,
  onChange,
  report,
  onOpenReport,
}: {
  enabled?: boolean
  disabled: boolean
  onChange(enabled: boolean): void
  report?: StandInSettingsShortcut
  onOpenReport(): void
}) {
  const { t } = useTranslation('common')
  const label = t('standIn.workspace.self_learning')
  return (
    <SettingsGroup className="mt-4 rounded-lg bg-transparent">
      <SettingsRow
        className="px-3"
        label={label}
        description={t('standIn.workspace.self_learning_help')}
      >
        <SettingsSwitch
          aria-label={label}
          data-testid="stand-in-self-learning-toggle"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </SettingsRow>
      {report && (
        <StandInSettingsEntry
          grouped
          testId={report.testId}
          label={report.label}
          disabled={disabled}
          onClick={onOpenReport}
        />
      )}
    </SettingsGroup>
  )
}
