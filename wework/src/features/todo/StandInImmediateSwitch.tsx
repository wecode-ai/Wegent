import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsSwitch } from '@/components/settings/settings-ui'

export function StandInImmediateSwitch({
  policy,
  disabled,
  label,
  testId,
  onChange,
}: {
  policy: StandInHandlingPolicy
  disabled: boolean
  label: string
  testId: string
  onChange(policy: StandInHandlingPolicy): void
}) {
  const { t } = useTranslation('common')
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      title={t('standIn.workspace.direct_processing_description')}
    >
      <div className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
        <span>{t('standIn.workspace.process_immediately')}</span>
        <SettingsSwitch
          data-testid={testId}
          aria-label={label}
          disabled={disabled || !policy.automatic}
          checked={policy.immediate ?? true}
          onCheckedChange={immediate => onChange({ ...policy, immediate })}
        />
      </div>
      {!policy.automatic && (
        <button
          type="button"
          data-testid={`${testId}-enable`}
          disabled={disabled}
          onClick={() => onChange({ ...policy, automatic: true })}
          className="min-h-11 px-2 text-sm underline md:min-h-8"
        >
          {t('standIn.workspace.enable_connection_handling')}
        </button>
      )}
    </div>
  )
}
