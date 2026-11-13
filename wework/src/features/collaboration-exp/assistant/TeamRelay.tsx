import { CircleHelp, LoaderCircle, Settings2, UserRound } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceTeamRelayNode } from '../model'

export interface TeamRelayProps {
  nodes: readonly ExperienceTeamRelayNode[]
  onManage(roleId?: string): void
  testId?: string
  manageTestId?: string
  expanded?: boolean
  ready?: boolean
  managementAvailable?: boolean
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
}: TeamRelayProps) {
  const { t } = useTranslation('collaborationExp')
  return (
    <section
      className="experience-team-relay"
      data-testid={testId}
      aria-label={t('teamRelay.title')}
    >
      <div className="experience-team-relay-heading">
        <h2 className="text-sm font-medium text-text-secondary">{t('teamRelay.title')}</h2>
        <button
          type="button"
          data-testid={manageTestId ?? `${testId}-manage`}
          aria-expanded={expanded}
          disabled={!managementAvailable}
          title={!managementAvailable ? t('teamRelay.managementUnavailable') : undefined}
          onClick={() => onManage()}
          className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-text-secondary hover:bg-muted disabled:cursor-default disabled:opacity-50 md:min-h-7"
        >
          <Settings2 aria-hidden="true" className="size-4" />
          {t('assistant.manage')}
        </button>
      </div>
      {nodes.length ? (
        <ul className="experience-team-relay-members">
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
            const Icon =
              node.state === 'waiting'
                ? CircleHelp
                : node.state === 'running'
                  ? LoaderCircle
                  : UserRound
            return (
              <li key={node.id ?? '@primary'} className="experience-team-relay-member">
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
                  className="experience-team-relay-node"
                >
                  <span className="experience-team-relay-status" aria-hidden="true">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="block truncate text-xs text-text-muted" title={statusDetail}>
                      {statusDetail}
                    </span>
                  </span>
                  <span className="experience-team-relay-trail" aria-hidden="true" />
                </button>
              </li>
            )
          })}
          {nodes.length > 2 && (
            <li className="experience-team-relay-more">
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
