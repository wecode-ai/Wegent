import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInSelfLearningSetting({
  enabled = false,
  savedEnabled,
  disabled,
  onChange,
}: {
  enabled?: boolean
  savedEnabled?: boolean
  disabled: boolean
  onChange(enabled: boolean): void
}) {
  const experimental = useExperimentalFeaturesEnabled()
  const { t } = useTranslation('common')
  if (!experimental && !savedEnabled && !enabled) return null
  const label = t('standIn.workspace.self_learning')
  return (
    <SettingsRow
      className="px-0"
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
  )
}
