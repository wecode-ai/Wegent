import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInImmediateSwitch } from './StandInImmediateSwitch'
import { StandInReplyAuthorization } from './StandInReplyAuthorization'

export function StandInProcessingSettings({
  rows,
  disabled,
}: {
  rows: {
    key: string
    name: string
    testId: string
    policy: StandInHandlingPolicy
    outbound?: boolean
    onChange(policy: StandInHandlingPolicy): void
  }[]
  disabled: boolean
}) {
  const { t } = useTranslation('common')
  if (!rows.length) return null
  return (
    <section
      className="mt-4 space-y-2 border-t border-border pt-4"
      data-testid="stand-in-processing-settings"
    >
      <h4 className="text-sm font-medium">{t('standIn.workspace.processing_settings')}</h4>
      <p className="text-xs text-text-muted">
        {t('standIn.workspace.direct_processing_description')}
      </p>
      {rows.map(row => (
        <div key={row.key} className="flex min-h-9 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
          <StandInImmediateSwitch
            policy={row.policy}
            disabled={disabled}
            label={t('standIn.workspace.handling_for', { name: row.name })}
            testId={row.testId}
            onChange={row.onChange}
          />
          {row.outbound && (
            <StandInReplyAuthorization
              name={row.name}
              policy={row.policy}
              disabled={disabled}
              testId={row.testId}
              onChange={row.onChange}
            />
          )}
        </div>
      ))}
    </section>
  )
}
