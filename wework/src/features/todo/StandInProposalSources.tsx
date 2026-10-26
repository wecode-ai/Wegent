import type { CollaborationProject } from '@wegent/collaboration'
import { dequal } from 'dequal'
import type { StandInIdentity, StandInHandlingPolicy, StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

type Sources = Pick<StandInIdentity, 'connections' | 'collaboration'>

export function StandInProposalSources({
  identity,
  previous,
  projects,
}: {
  identity: Sources
  previous?: Sources
  projects: CollaborationProject[]
}) {
  const { t } = useTranslation('common')
  const projectName = (id: string, store: string) =>
    projects.find(
      project =>
        project.id === id && (project.project_store === 'local' ? 'local' : 'cloud') === store
    )?.name ?? t('standIn.workspace.unavailable_project')
  const policyName = (policy?: StandInHandlingPolicy) =>
    policy
      ? t(
          !policy.automatic
            ? 'standIn.workspace.policy_manual'
            : policy.askBeforeAct
              ? 'standIn.workspace.policy_confirm'
              : 'standIn.workspace.policy_automatic'
        )
      : t('standIn.workspace.inherited_policy')
  const sourceKey = (row: NonNullable<Sources['connections']>[number]) =>
    JSON.stringify([row.providerId, row.profile, row.kind, row.id])
  const before = previous?.connections ?? []
  const after = identity.connections ?? []
  const changed = after.filter(
    row =>
      !dequal(
        row,
        before.find(old => sourceKey(old) === sourceKey(row))
      )
  )
  const removed = before.filter(row => !after.some(next => sourceKey(next) === sourceKey(row)))
  const scope = (source?: StandInRole['collaboration']) =>
    !source?.enabled
      ? t('standIn.workspace.no_project_connection')
      : source.allProjects
        ? t('standIn.workspace.all_projects_with_exclusions', {
            count: source.excludedProjects.length,
          })
        : source.projects.map(ref => projectName(ref.id, ref.store)).join('、') ||
          t('standIn.workspace.no_project_connection')
  const collaborationChanged = !dequal(previous?.collaboration, identity.collaboration)
  const source = identity.collaboration
  return (
    <div className="space-y-2 text-sm">
      {changed.map(row => (
        <p key={sourceKey(row)}>
          <span className="text-text-muted">
            {t(
              before.some(old => sourceKey(old) === sourceKey(row))
                ? 'standIn.workspace.connection_updated'
                : 'standIn.workspace.connection_added'
            )}
            ：
          </span>
          {row.name}
          <span className="text-text-secondary">
            {' '}
            ·{' '}
            {row.providerId && row.providerId !== '@wegent/dsh-connection-dingtalk/dingtalk'
              ? row.kind
              : t(
                  row.kind === 'group'
                    ? 'standIn.workspace.group_mentions'
                    : 'standIn.workspace.direct_messages'
                )}{' '}
            · {policyName(row.policy)}
          </span>
        </p>
      ))}
      {removed.map(row => (
        <p key={sourceKey(row)}>
          <span className="text-text-muted">{t('standIn.workspace.connection_removed')}：</span>
          {row.name}
        </p>
      ))}
      {collaborationChanged && (
        <>
          <p>
            <span className="text-text-muted">{t('standIn.personal.collaboration')}：</span>
            {previous?.collaboration && <>{scope(previous.collaboration)} → </>}
            {scope(source)}
          </p>
          {source?.enabled && (
            <>
              {!dequal(previous?.collaboration?.policy, source.policy) && (
                <p>
                  {t('standIn.workspace.handling_changed')}：{policyName(source.policy)}
                </p>
              )}
              {!dequal(previous?.collaboration?.excludedProjects, source.excludedProjects) &&
                source.excludedProjects.length > 0 && (
                  <p>
                    {t('standIn.workspace.excluded_projects_label')}：
                    {source.excludedProjects.map(ref => projectName(ref.id, ref.store)).join('、')}
                  </p>
                )}
              {!dequal(previous?.collaboration?.tags, source.tags) && (
                <p>
                  {t('standIn.workspace.task_tags_label')}：
                  {source.tags.join('、') || t('standIn.workspace.no_tag_limit')}
                </p>
              )}
              {source.projectPolicies
                ?.filter(
                  row =>
                    !dequal(
                      row,
                      previous?.collaboration?.projectPolicies?.find(
                        old => old.id === row.id && old.store === row.store
                      )
                    )
                )
                .map(row => (
                  <p key={`${row.store}:${row.id}`}>
                    {projectName(row.id, row.store)} · {policyName(row.policy)}
                  </p>
                ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
