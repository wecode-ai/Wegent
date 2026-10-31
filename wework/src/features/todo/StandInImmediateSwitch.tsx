import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

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
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
        <input
          type="checkbox"
          data-testid={testId}
          aria-label={label}
          disabled={disabled || !policy.automatic}
          checked={policy.immediate ?? true}
          onChange={event => onChange({ ...policy, immediate: event.target.checked })}
          className="accent-text-primary"
        />
        <span>{t('standIn.workspace.process_immediately')}</span>
      </label>
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
