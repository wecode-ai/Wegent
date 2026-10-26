import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInHandlingSelect({
  policy,
  onChange,
  disabled,
  testId,
  label,
}: {
  policy: StandInHandlingPolicy
  onChange(policy: StandInHandlingPolicy): void
  disabled?: boolean
  testId: string
  label: string
}) {
  const { t } = useTranslation('common')
  const value = !policy.automatic ? 'manual' : policy.askBeforeAct ? 'confirm' : 'automatic'
  return (
    <select
      aria-label={label}
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={event =>
        onChange({
          automatic: event.target.value !== 'manual',
          askBeforeAct: event.target.value !== 'automatic',
        })
      }
      className="min-h-9 max-w-full rounded-md border border-border bg-background px-2 text-sm"
    >
      <option value="manual">{t('standIn.workspace.policy_manual')}</option>
      <option value="confirm">{t('standIn.workspace.policy_confirm')}</option>
      <option value="automatic">{t('standIn.workspace.policy_automatic')}</option>
    </select>
  )
}
