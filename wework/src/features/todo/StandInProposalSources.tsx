import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInIdentity, StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInProposalSources({
  identity,
  projects,
}: {
  identity: Pick<StandInIdentity, 'dingtalk' | 'collaboration'>
  projects: CollaborationProject[]
}) {
  const { t } = useTranslation('common')
  const projectName = (id: string, store: string) =>
    projects.find(
      project =>
        project.id === id && (project.project_store === 'local' ? 'local' : 'cloud') === store
    )?.name ?? t('standIn.workspace.unavailable_project')
  const policyName = (policy: { automatic: boolean; askBeforeAct: boolean }) =>
    t(
      !policy.automatic
        ? 'standIn.workspace.policy_manual'
        : policy.askBeforeAct
          ? 'standIn.workspace.policy_confirm'
          : 'standIn.workspace.policy_automatic'
    )
  const source: StandInRole['collaboration'] | undefined = identity.collaboration
  return (
    <div className="space-y-1 text-text-secondary">
      {source?.enabled && (
        <>
          <p>
            {t('standIn.personal.collaboration')} ·{' '}
            {source.allProjects
              ? t('standIn.personal.all_projects')
              : source.projects.map(project => projectName(project.id, project.store)).join(' · ')}
          </p>
          {source.policy && <p>{policyName(source.policy)}</p>}
          {source.excludedProjects.map(project => (
            <p key={`${project.store}:${project.id}`}>
              {t('standIn.workspace.excluded_project', {
                name: projectName(project.id, project.store),
              })}
            </p>
          ))}
          {source.projectPolicies?.map(project => (
            <p key={`${project.store}:${project.id}`}>
              {projectName(project.id, project.store)} · {policyName(project.policy)}
            </p>
          ))}
          {!!source.tags.length && <p>{source.tags.join(' · ')}</p>}
        </>
      )}
      {identity.dingtalk?.map(row => (
        <p key={`${row.profile}:${row.kind}:${row.id}`}>
          {row.name} ·{' '}
          {t(
            row.kind === 'group'
              ? 'standIn.workspace.group_mentions'
              : 'standIn.workspace.direct_messages'
          )}{' '}
          · {policyName(row.policy)}
        </p>
      ))}
    </div>
  )
}
