import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInImmediateSwitch } from './StandInImmediateSwitch'
import { StandInReplyAuthorization } from './StandInReplyAuthorization'
import { ChevronDown } from 'lucide-react'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useState } from 'react'

export function StandInProcessingSettings({
  rows,
  disabled,
  sessionScope = 'source',
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
  sessionScope?: 'source' | 'issue' | 'schedule'
}) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  if (!rows.length) return null
  return (
    <section
      className="mt-4 border-t border-border pt-4"
      data-testid="stand-in-processing-settings"
    >
      <button
        type="button"
        data-testid="stand-in-processing-settings-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="group flex min-h-11 w-full items-center justify-between gap-2 rounded-md text-sm font-medium hover:bg-muted md:min-h-8"
      >
        {t('standIn.workspace.processing_settings')}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-text-muted transition-transform group-aria-expanded:rotate-180"
        />
      </button>
      {expanded &&
        rows.map(row => (
          <div
            key={row.key}
            role="group"
            aria-label={row.name}
            className="min-w-0 border-b border-border py-2 last:border-b-0"
          >
            <h5 className="break-words text-sm font-medium">{row.name}</h5>
            <StandInImmediateSwitch
              policy={row.policy}
              disabled={disabled}
              label={t('standIn.workspace.handling_for', { name: row.name })}
              testId={row.testId}
              onChange={row.onChange}
            />
            <SettingsRow
              className="px-0"
              label={t(
                sessionScope === 'source'
                  ? 'standIn.workspace.session_independent'
                  : 'standIn.workspace.session_strategy'
              )}
              description={t(`standIn.workspace.session_${sessionScope}_description`)}
              control={
                sessionScope === 'source' ? (
                  <SettingsSwitch
                    data-testid={`${row.testId}-session-strategy`}
                    aria-label={`${row.name} · ${t('standIn.workspace.session_independent')}`}
                    disabled={disabled || !row.policy.automatic}
                    checked={row.policy.sessionStrategy === 'independent'}
                    onCheckedChange={independent =>
                      row.onChange({
                        ...row.policy,
                        sessionStrategy: independent ? 'independent' : 'reuse',
                      })
                    }
                  />
                ) : undefined
              }
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
