import { ArrowRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceTeamRelayNode } from '../model'
import './TeamRelay.css'

export interface TeamRelayProps {
  nodes: readonly ExperienceTeamRelayNode[]
  onManage(roleId?: string): void
  testId?: string
  manageTestId?: string
  expanded?: boolean
  ready?: boolean
  managementAvailable?: boolean
  compact?: boolean
}

/** A status projection only; choosing a member opens its existing configuration. */
export function TeamRelay({
  nodes,
  onManage,
  testId = 'collaboration-exp-team-relay',
  manageTestId,
  expanded,
  ready = true,
  managementAvailable = true,
  compact = false,
}: TeamRelayProps) {
  const { t } = useTranslation('collaborationExp')
  return (
    <section
      className={`experience-team-relay assistant-team-rail${compact ? ' assistant-team-rail--compact' : ''}`}
      data-testid={testId}
      aria-label={t('teamRelay.title')}
      data-live={ready && nodes.some(node => node.state === 'running')}
    >
      <div className="assistant-team-rail-head">
        <span className="assistant-team-rail-signal" aria-hidden="true" />
        <span className="assistant-team-rail-label">
          <strong className="text-xs">{t('teamRelay.title')}</strong>
          <small>
            {ready
              ? t('teamRelay.runningCount', {
                  count: nodes.reduce((sum, node) => sum + node.counts.running, 0),
                })
              : t('teamRelay.state.unknown')}
          </small>
        </span>
        <button
          type="button"
          data-testid={manageTestId ?? `${testId}-manage`}
          aria-expanded={expanded}
          disabled={!managementAvailable}
          title={!managementAvailable ? t('teamRelay.managementUnavailable') : undefined}
          onClick={() => onManage()}
          className="assistant-text-button text-xs"
        >
          {t('assistant.manage')}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </div>
      {nodes.length ? (
        <ul className="assistant-team-members">
          {nodes.map(node => {
            const name =
              node.name || t(node.isDefault ? 'assistant.defaultAssistant' : 'assistant.specialist')
            const status = t(`teamRelay.state.${ready ? node.state : 'unknown'}`)
            const statusDetail = [
              status,
              ...(!node.enabled ? [t('teamRelay.paused')] : []),
              ...(ready && node.state !== 'idle' && node.counts[node.state] > 0
                ? [node.counts[node.state]]
                : []),
            ].join(' · ')
            return (
              <li key={node.id ?? '@primary'}>
                <button
                  type="button"
                  data-testid={`${testId}-node-${node.id ?? '@primary'}`}
                  data-state={ready ? node.state : 'unknown'}
                  data-assistant-id={node.id ?? '@primary'}
                  data-waiting-count={ready ? node.counts.waiting : undefined}
                  data-running-count={ready ? node.counts.running : undefined}
                  data-completed-count={ready ? node.counts.completed : undefined}
                  aria-label={t('teamRelay.memberLabel', { name, state: statusDetail })}
                  title={`${name} · ${statusDetail}`}
                  disabled={!managementAvailable}
                  onClick={() => onManage(node.id ?? undefined)}
                  className="experience-team-relay-node assistant-presence"
                >
                  <span className="assistant-presence-avatar" aria-hidden="true">
                    <span className="assistant-avatar assistant-avatar--sm text-xs">
                      {Array.from(name)[0]}
                    </span>
                    <span
                      className="experience-team-relay-status assistant-presence-mark"
                      data-testid={`${testId}-status-${node.id ?? '@primary'}`}
                      data-state={ready ? node.state : 'unknown'}
                    />
                  </span>
                  <span className="assistant-presence-copy">
                    <strong className="text-xs">{name}</strong>
                    <small title={statusDetail}>{statusDetail}</small>
                  </span>
                  <ArrowRight size={14} className="assistant-presence-arrow" aria-hidden="true" />
                </button>
              </li>
            )
          })}
          {nodes.length > 4 && (
            <li className="assistant-team-more">
              <button
                type="button"
                data-testid={`${testId}-more`}
                onClick={() => onManage()}
                disabled={!managementAvailable}
                className="min-h-11 w-full text-xs text-text-secondary hover:bg-muted"
              >
                {t('teamRelay.allMembers', { count: nodes.length })}
              </button>
            </li>
          )}
        </ul>
      ) : (
        <p className="py-2 text-sm text-text-muted" data-testid={`${testId}-unavailable`}>
          {t('teamRelay.unavailable')}
        </p>
      )}
    </section>
  )
}
