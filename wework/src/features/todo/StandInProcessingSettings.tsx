import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInImmediateSwitch } from './StandInImmediateSwitch'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import {
  ConnectionRuleFields,
  type ConnectionRuleProcessing,
} from '@wegent/collaboration/automation'

export function StandInProcessingSettings({
  rows,
  disabled,
}: {
  rows: {
    key: string
    name: string
    testId: string
    policy: StandInHandlingPolicy
    onChange(policy: StandInHandlingPolicy): void
    processing?: ConnectionRuleProcessing
    onProcessingChange?(processing: ConnectionRuleProcessing): void
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
        <div key={row.key} className="space-y-2">
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
            {row.onProcessingChange && (
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                {t('automation_rules.rule_enabled')}
                <SettingsSwitch
                  data-testid={`${row.testId}-enabled`}
                  disabled={disabled}
                  aria-label={t('automation_rules.rule_for', { name: row.name })}
                  checked={row.policy.enabled !== false}
                  onCheckedChange={enabled => row.onChange({ ...row.policy, enabled })}
                />
              </label>
            )}
            <StandInImmediateSwitch
              policy={row.policy}
              disabled={disabled || row.policy.enabled === false}
              label={t('standIn.workspace.handling_for', { name: row.name })}
              testId={row.testId}
              onChange={row.onChange}
            />
          </div>
          {row.onProcessingChange && (
            <details>
              <summary
                className="min-h-11 cursor-pointer text-sm md:min-h-8"
                data-testid={`${row.testId}-rule-settings`}
              >
                {t('automation_rules.edit_processing')}
              </summary>
              <ConnectionRuleFields
                value={row.processing ?? {}}
                onChange={row.onProcessingChange}
                disabled={disabled || row.policy.enabled === false}
                testId={`${row.testId}-rule`}
                translate={(key, fallback) => t(key, fallback ?? key)}
              />
            </details>
          )}
        </div>
      ))}
    </section>
  )
}
