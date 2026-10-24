import type { CollaborationProject } from '@wegent/collaboration'
import { StandInProposalSources } from './StandInProposalSources'
import { dequal } from 'dequal'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInProposal } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInProposalCard({
  proposal,
  current,
  busy,
  onResolve,
  projects,
}: {
  proposal: StandInProposal
  current: PersonalStandInSettings
  busy: boolean
  projects: CollaborationProject[]
  onResolve(accept: boolean): Promise<void>
}) {
  const { t } = useTranslation('common')
  const changed = proposal.settings.roles.filter(
    role =>
      !dequal(
        role,
        current.roles.find(row => row.id === role.id)
      )
  )
  const removed = current.roles.filter(
    role => !proposal.settings.roles.some(row => row.id === role.id)
  )
  const stale = proposal.settings.version !== current.version
  return (
    <section
      aria-label={t('standIn.workspace.proposal_title')}
      data-testid="stand-in-proposal"
      className="mx-5 mt-4 max-h-72 shrink-0 overflow-y-auto rounded-lg border border-border p-4"
    >
      <h2 className="font-medium">{t('standIn.workspace.proposal_title')}</h2>
      <p className="mt-2 whitespace-pre-wrap text-sm">{proposal.summary}</p>
      <details className="mt-3 text-sm" open>
        <summary data-testid="stand-in-proposal-details" className="min-h-8 cursor-pointer">
          {t('standIn.workspace.proposal_details')}
        </summary>
        {changed.map(role => (
          <div key={role.id} className="mt-2 border-t border-border pt-2">
            <p className="font-medium">
              {role.name || t('standIn.personal.default_role')} ·{' '}
              {t(role.enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-text-secondary">{role.prompt}</p>
            <StandInProposalSources identity={role} projects={projects} />
          </div>
        ))}
        {removed.map(role => (
          <p key={role.id} className="mt-2">
            {t('standIn.workspace.remove_role', { name: role.name })}
          </p>
        ))}
        {!dequal(current.primary, proposal.settings.primary) && (
          <div className="mt-2 whitespace-pre-wrap border-t border-border pt-2">
            {t('standIn.workspace.primary_profile')}
            <p>{proposal.settings.primary?.prompt}</p>
            <p>{proposal.settings.primary?.preferences}</p>
            <p>
              {t(
                proposal.settings.primary?.enabled
                  ? 'standIn.workspace.receiving'
                  : 'standIn.workspace.paused'
              )}
            </p>
            {proposal.settings.primary && (
              <StandInProposalSources identity={proposal.settings.primary} projects={projects} />
            )}
          </div>
        )}
        {current.autoSelect !== proposal.settings.autoSelect && (
          <p>
            {t('standIn.workspace.ai_ownership')} ·{' '}
            {t(proposal.settings.autoSelect ? 'standIn.auto_on' : 'standIn.auto_off')}
          </p>
        )}
      </details>
      <p className="mt-2 text-xs text-text-muted">
        {t(stale ? 'standIn.workspace.proposal_stale' : 'standIn.workspace.proposal_help')}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-testid="stand-in-proposal-reject"
          disabled={busy}
          onClick={() => void onResolve(false)}
          className="min-h-8 rounded-md px-3 text-sm hover:bg-muted"
        >
          {t('standIn.workspace.proposal_reject')}
        </button>
        <button
          type="button"
          data-testid="stand-in-proposal-accept"
          disabled={busy || stale}
          onClick={() => void onResolve(true)}
          className="min-h-8 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
        >
          {t('standIn.workspace.proposal_accept')}
        </button>
      </div>
    </section>
  )
}
