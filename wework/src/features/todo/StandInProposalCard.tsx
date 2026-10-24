import type { CollaborationProject } from '@wegent/collaboration'
import { StandInProposalDiff } from './StandInProposalDiff'
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
      className="mb-3 flex max-h-[45vh] shrink-0 flex-col overflow-hidden rounded-lg border border-border"
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="font-medium">{t('standIn.workspace.proposal_title')}</h2>
        <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{proposal.summary}</p>
      </header>
      <div className="min-h-0 overflow-y-auto px-4" data-testid="stand-in-proposal-details">
        <div className="divide-y divide-border">
          {changed.map(role => {
            const previous = current.roles.find(row => row.id === role.id)
            return (
              <StandInProposalDiff
                key={role.id}
                name={t(
                  previous
                    ? 'standIn.workspace.update_role'
                    : 'standIn.workspace.proposal_create_role',
                  { name: role.name || t('standIn.personal.default_role') }
                )}
                identity={role}
                previous={previous}
                projects={projects}
              />
            )
          })}
          {removed.map(role => (
            <p key={role.id} className="py-3 text-sm">
              {t('standIn.workspace.remove_role', { name: role.name })}
            </p>
          ))}
          {!dequal(current.primary, proposal.settings.primary) && proposal.settings.primary && (
            <StandInProposalDiff
              name={t('standIn.workspace.update_primary')}
              identity={proposal.settings.primary}
              previous={current.primary}
              projects={projects}
            />
          )}
          {current.autoSelect !== proposal.settings.autoSelect && (
            <p className="py-3 text-sm">
              {t('standIn.workspace.ai_ownership')} ·{' '}
              {t(proposal.settings.autoSelect ? 'standIn.auto_on' : 'standIn.auto_off')}
            </p>
          )}
        </div>
      </div>
      <footer className="shrink-0 border-t border-border bg-background px-4 py-3">
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
      </footer>
    </section>
  )
}
