import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'
import { StandInReplyAuthorization } from './StandInReplyAuthorization'

const processingModes = ['manual', 'collect', 'immediate'] as const

function processingMode(policy: StandInHandlingPolicy) {
  if (!policy.automatic) return 'manual'
  return (policy.immediate ?? true) ? 'immediate' : 'collect'
}

export function StandInProcessingSettings({
  rows,
  disabled,
  sessionScope = 'source',
  compact = false,
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
  sessionScope?: 'source' | 'issue'
  compact?: boolean
}) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  if (!rows.length) return null
  const first = rows[0]
  const firstMode = processingMode(first.policy)
  const uniformMode = compact && rows.every(row => processingMode(row.policy) === firstMode)
  const singleCompact = compact && rows.length === 1
  return (
    <section
      className={compact ? 'border-t border-border pt-2' : 'mt-4 border-t border-border pt-4'}
      data-testid="stand-in-processing-settings"
    >
      <ControlButton
        variant={compact ? 'unstyled' : 'outline'}
        size="sm"
        type="button"
        data-testid="stand-in-processing-settings-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}
        className={
          compact
            ? 'group flex min-h-11 w-full items-center gap-2 rounded-md py-2 text-left text-sm hover:bg-muted/50 md:min-h-9'
            : 'group flex min-h-11 w-full items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-left text-sm hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70'
        }
      >
        {compact ? (
          <>
            <span className="flex-1 font-medium">{t('standIn.workspace.processing_settings')}</span>
            {!expanded && (
              <span className="text-text-secondary">
                {t(
                  uniformMode
                    ? `standIn.workspace.processing_${firstMode}`
                    : 'standIn.workspace.processing_varies'
                )}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {t('standIn.workspace.processing_settings')}
              </span>
              <span className="mt-1 block break-words text-text-secondary">
                {t('standIn.workspace.processing_summary', {
                  name: first.name,
                  mode: t(`standIn.workspace.processing_${processingMode(first.policy)}`),
                })}
                {rows.length > 1 && (
                  <span className="block">
                    {t('standIn.workspace.processing_more', { count: rows.length - 1 })}
                  </span>
                )}
              </span>
            </span>
            <span className="shrink-0 rounded-md border border-border bg-background px-2 py-1">
              {t(
                expanded ? 'standIn.workspace.processing_hide' : 'standIn.workspace.processing_edit'
              )}
            </span>
          </>
        )}
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
              {!singleCompact && <h5 className="break-words text-sm font-medium">{row.name}</h5>}
              <SettingsRow
                className={singleCompact ? 'px-0 max-md:gap-0' : 'px-0'}
                label={singleCompact ? null : t('standIn.workspace.processing_settings')}
              >
                <SelectRoot
                  value={processingMode(row.policy)}
                  disabled={disabled}
                  onValueChange={mode => {
                    if (mode === null) return
                    row.onChange({
                      ...row.policy,
                      automatic: mode !== 'manual',
                      immediate: mode === 'manual' ? row.policy.immediate : mode === 'immediate',
                    })
                  }}
                >
                  <SelectTrigger
                    aria-label={t('standIn.workspace.handling_for', { name: row.name })}
                    data-testid={row.testId}
                  >
                    {t(`standIn.workspace.processing_${processingMode(row.policy)}`)}
                  </SelectTrigger>
                  <SelectContent>
                    {processingModes.map(mode => (
                      <SelectItem key={mode} value={mode} data-testid={`${row.testId}-${mode}`}>
                        {t(`standIn.workspace.processing_${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </SettingsRow>
              {(!compact || sessionScope === 'source') && (
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
