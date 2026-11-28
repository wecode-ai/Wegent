import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInProposal } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollaborationProject } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { dequal } from 'dequal'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useMemo, useSyncExternalStore } from 'react'
import { StandInGhostEvidence } from './StandInGhostEvidence'
import { StandInProposalDiff } from './StandInProposalDiff'

export function StandInProposalCard({
  proposal,
  current,
  busy,
  onResolve,
  projects,
  result,
  api,
  deviceId,
}: {
  proposal: StandInProposal
  current: PersonalStandInSettings
  busy: boolean
  projects: CollaborationProject[]
  onResolve(accept: boolean): Promise<void>
  result?: 'accepted' | 'rejected'
  api?: StandInExecutorApi
  deviceId?: string
}) {
  const { t } = useTranslation('common')
  const changed = proposal.settings.roles.filter(
    role =>
      !dequal(
        { ...role, version: undefined },
        { ...current.roles.find(row => row.id === role.id), version: undefined }
      )
  )
  const removed = current.roles.filter(
    role => !proposal.settings.roles.some(row => row.id === role.id)
  )
  const providerId = '@wegent/dsh-connection-dingtalk/dingtalk'
  const needsAccount = [proposal.settings.primary, ...changed].some(identity =>
    identity?.connections?.some(source => source.providerId === providerId && source.profile)
  )
  const catalog = useMemo(
    () => createAsyncResource(deviceId ?? '', () => api!.connectionProviders(deviceId!)),
    [api, deviceId]
  )
  const snapshot = useSyncExternalStore(
    needsAccount && api && deviceId ? catalog.subscribe : subscribeIdleResource,
    catalog.getSnapshot,
    getIdleResourceSnapshot
  )
  const account = snapshot.data?.items.find(item => item.id === providerId)?.availability
  const stale =
    proposal.settings.executionDeviceId === current.executionDeviceId &&
    proposal.settings.version !== current.version
  const title = t(
    `standIn.workspace.${result ? `proposal_${result}` : proposal.training ? 'ghost_proposal_title' : 'proposal_title'}`
  )
  return (
    <section
      aria-label={title}
      data-testid={result ? 'stand-in-proposal-result' : 'stand-in-proposal'}
      role={result ? 'status' : undefined}
      className="mb-3 flex max-h-[45vh] shrink-0 flex-col overflow-hidden rounded-lg border border-border"
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="font-medium">{title}</h2>
      </header>
      <div className="min-h-0 overflow-y-auto px-4" data-testid="stand-in-proposal-details">
        <p className="break-words border-b border-border py-3 text-sm leading-relaxed text-text-secondary">
          {proposal.summary}
        </p>
        {proposal.training ? (
          <StandInGhostEvidence training={proposal.training} resolved={!!result} />
        ) : (
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
                    { name: role.name || t('standIn.personal.unnamed_assistant') }
                  )}
                  identity={role}
                  previous={previous}
                  projects={projects}
                  dingTalkAccount={account}
                />
              )
            })}
            {removed.map(role => (
              <p key={role.id} className="py-3 text-sm">
                {t('standIn.workspace.remove_role', {
                  name: role.name || t('standIn.personal.unnamed_assistant'),
                })}
              </p>
            ))}
            {!dequal(current.primary, proposal.settings.primary) && proposal.settings.primary && (
              <StandInProposalDiff
                name={t('standIn.workspace.update_primary')}
                identity={proposal.settings.primary}
                previous={current.primary}
                projects={projects}
                dingTalkAccount={account}
              />
            )}
          </div>
        )}
      </div>
      {!result && (
        <footer className="shrink-0 border-t border-border bg-background px-4 py-3">
          <p className="mt-2 text-xs text-text-muted">
            {t(stale ? 'standIn.workspace.proposal_stale' : 'standIn.workspace.proposal_help')}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="stand-in-proposal-reject"
              disabled={busy}
              onClick={() => void onResolve(false)}
              className="min-h-8 rounded-md px-3 text-sm hover:bg-muted"
            >
              {t('standIn.workspace.proposal_reject')}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              type="button"
              data-testid="stand-in-proposal-accept"
              disabled={busy || stale}
              onClick={() => void onResolve(true)}
              className="min-h-8 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
            >
              {t('standIn.workspace.proposal_accept')}
            </ControlButton>
          </div>
        </footer>
      )}
    </section>
  )
}
