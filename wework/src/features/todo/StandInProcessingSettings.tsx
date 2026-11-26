import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'
import { StandInImmediateSwitch } from './StandInImmediateSwitch'
import { StandInReplyAuthorization } from './StandInReplyAuthorization'

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
  const contentId = useId()
  if (!rows.length) return null
  const first = rows[0]
  return (
    <section
      className="mt-4 border-t border-border pt-4"
      data-testid="stand-in-processing-settings"
    >
      <ControlButton
        variant="outline"
        size="sm"
        type="button"
        data-testid="stand-in-processing-settings-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}
        className="group flex min-h-11 w-full items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-left text-sm hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t('standIn.workspace.processing_settings')}</span>
          <span className="mt-1 block break-words text-text-secondary">
            {t('standIn.workspace.processing_summary', {
              name: first.name,
              mode: t(
                !first.policy.automatic
                  ? 'standIn.workspace.processing_manual'
                  : (first.policy.immediate ?? true)
                    ? 'standIn.workspace.processing_immediate'
                    : 'standIn.workspace.processing_collect'
              ),
            })}
            {rows.length > 1 && (
              <span className="block">
                {t('standIn.workspace.processing_more', { count: rows.length - 1 })}
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 rounded-md border border-border bg-background px-2 py-1">
          {t(expanded ? 'standIn.workspace.processing_hide' : 'standIn.workspace.processing_edit')}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-text-secondary transition-transform group-aria-expanded:rotate-180"
        />
      </ControlButton>
      <div id={contentId} hidden={!expanded}>
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
                children={
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
              {sessionScope === 'schedule' && (
                <SettingsRow
                  className="px-0"
                  label={t('standIn.workspace.schedule_ask_before_act')}
                  description={t('standIn.workspace.schedule_ask_before_act_help')}
                >
                  <SettingsSwitch
                    data-testid={`${row.testId}-ask-before-act`}
                    aria-label={t('standIn.workspace.schedule_ask_before_act')}
                    disabled={disabled}
                    checked={row.policy.askBeforeAct}
                    onCheckedChange={askBeforeAct => row.onChange({ ...row.policy, askBeforeAct })}
                  />
                </SettingsRow>
              )}
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
      </div>
    </section>
  )
}
