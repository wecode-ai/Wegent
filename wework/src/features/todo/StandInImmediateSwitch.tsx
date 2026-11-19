import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'

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
    <SettingsRow
      className="px-0"
      label={t('standIn.workspace.start_timing')}
      description={t('standIn.workspace.start_timing_description')}
      children={
        <>
          <SettingsSwitch
            data-testid={testId}
            aria-label={`${label} · ${t('standIn.workspace.start_timing')}`}
            disabled={disabled || !policy.automatic}
            checked={policy.immediate ?? true}
            onCheckedChange={immediate => onChange({ ...policy, immediate })}
          />
          {!policy.automatic && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`${testId}-enable`}
              disabled={disabled}
              onClick={() => onChange({ ...policy, automatic: true })}
              className="min-h-11 px-2 text-sm underline md:min-h-8"
            >
              {t('standIn.workspace.enable_connection_handling')}
            </ControlButton>
          )}
        </>
      }
    />
  )
}
