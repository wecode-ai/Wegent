import type { CollaborationProject } from '@wegent/collaboration'
import { dequal } from 'dequal'
import type { StandInIdentity, StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInProposalSources } from './StandInProposalSources'

type Identity = Partial<StandInIdentity & StandInRole>

export function StandInProposalDiff({
  name,
  identity,
  previous,
  projects,
}: {
  name: string
  identity: Identity
  previous?: Identity
  projects: CollaborationProject[]
}) {
  const { t } = useTranslation('common')
  const description = (value?: Identity) =>
    [value?.prompt, value?.preferences].filter(Boolean).join('\n\n')
  const descriptionChanged = description(identity) !== description(previous)
  return (
    <div className="space-y-2 py-3" data-testid="stand-in-proposal-change">
      <h3 className="font-medium">{name}</h3>
      {previous?.name && identity.name !== previous.name && (
        <p className="text-sm">
          {t('standIn.workspace.role_renamed', { before: previous.name, after: identity.name })}
        </p>
      )}
      {identity.enabled !== previous?.enabled && (
        <p className="text-sm text-text-secondary">
          {t(
            identity.enabled
              ? 'standIn.workspace.start_receiving'
              : 'standIn.workspace.stop_receiving'
          )}
        </p>
      )}
      <StandInProposalSources identity={identity} previous={previous} projects={projects} />
      {descriptionChanged && (
        <details className="text-sm">
          <summary className="min-h-8 cursor-pointer text-text-secondary">
            {t('standIn.workspace.instructions_changed')}
          </summary>
          {previous && description(previous) && (
            <div className="mt-2">
              <p className="text-xs text-text-muted">{t('standIn.workspace.before_change')}</p>
              <p className="mt-1 whitespace-pre-wrap break-words">{description(previous)}</p>
            </div>
          )}
          <div className="mt-2">
            <p className="text-xs text-text-muted">{t('standIn.workspace.after_change')}</p>
            <p className="mt-1 whitespace-pre-wrap break-words">
              {description(identity) || t('standIn.workspace.instructions_cleared')}
            </p>
          </div>
        </details>
      )}
      {!dequal(identity.workspace, previous?.workspace) && (
        <p className="break-all text-sm">
          {t('standIn.local_project')}：
          {identity.workspace?.workspacePath ?? t('standIn.inherit_environment')}
        </p>
      )}
      {!dequal(identity.model, previous?.model) && (
        <p className="text-sm">
          {t('standIn.model_label')}：
          {identity.model?.model_id ?? t('standIn.workspace.inherited_policy')}
        </p>
      )}
      {!dequal(identity.modelOptions, previous?.modelOptions) && (
        <p className="text-sm">{t('standIn.workspace.model_options_changed')}</p>
      )}
      {(identity.agentId !== previous?.agentId ||
        identity.agentResourceId !== previous?.agentResourceId) && (
        <p className="text-sm">{t('standIn.workspace.agent_changed')}</p>
      )}
    </div>
  )
}
