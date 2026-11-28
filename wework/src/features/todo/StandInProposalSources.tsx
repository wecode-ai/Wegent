import type { CollaborationProject } from '@wegent/collaboration'
import { dequal } from 'dequal'
import type { StandInIdentity, StandInHandlingPolicy, StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import { standInProjectTags } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

type Sources = Pick<StandInIdentity, 'connections' | 'collaboration'>

export function StandInProposalSources({
  identity,
  previous,
  projects,
  dingTalkAccount,
}: {
  identity: Sources
  previous?: Sources
  projects: CollaborationProject[]
  dingTalkAccount?: ConnectionProviderDescriptor['availability']
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
  const isDingTalk = (row: NonNullable<Sources['connections']>[number]) =>
    !row.providerId || row.providerId === '@wegent/dsh-connection-dingtalk/dingtalk'
  const accountLabel = (profile: string) =>
    (dingTalkAccount?.profile === profile &&
      [dingTalkAccount.accountName, dingTalkAccount.organizationName]
        .filter(Boolean)
        .join(' · ')) ||
    profile
  const configuration = (row?: NonNullable<Sources['connections']>[number]) =>
    row &&
    [
      isDingTalk(row) && row.profile
        ? t('standIn.workspace.proposal_account', { account: accountLabel(row.profile) })
        : (row.configurationSummary ?? t('standIn.workspace.connection_default_configuration')),
      ...(row?.excludedResources?.length
        ? [
            `${t('standIn.workspace.connection_blacklist')}: ${row.excludedResources.map(item => item.name).join(', ')}`,
          ]
        : []),
    ].join(' · ')
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
      : [
          source.includeParticipatingIssues && t('standIn.workspace.receive_participating_issues'),
          source.allProjects
            ? t('standIn.workspace.all_projects_with_exclusions', {
                count: source.excludedProjects.length,
              })
            : source.projects.map(ref => projectName(ref.id, ref.store)).join('、'),
        ]
          .filter(Boolean)
          .join(' · ') || t('standIn.workspace.no_project_connection')
  const collaborationChanged = !dequal(previous?.collaboration, identity.collaboration)
  const source = identity.collaboration
  const previousSource = previous?.collaboration
  const tagChanges = source?.enabled
    ? [
        ...(
          [
            ['projects', source.allProjects, 'project_only_all'],
            ['participating', source.includeParticipatingIssues, 'receive_participating_issues'],
            ['independent', source.includeIndependentIssues, 'project_scope_independent'],
          ] as const
        )
          .filter(([, enabled]) => enabled)
          .map(([key, , label]) => ({
            key,
            name: t(`standIn.workspace.${label}`),
            before: previousSource?.tagFilters?.[key] ?? previousSource?.tags ?? [],
            after: source.tagFilters?.[key] ?? source.tags,
          })),
        ...(!source.allProjects
          ? source.projects.map(project => ({
              key: `${project.store}:${project.id}`,
              name: projectName(project.id, project.store),
              before: previousSource ? standInProjectTags(previousSource, project) : [],
              after: standInProjectTags(source, project),
            }))
          : []),
      ].filter(row => !dequal(row.before, row.after))
    : []
  return (
    <div className="space-y-2 text-sm">
      {changed.map(row => (
        <div key={sourceKey(row)} className="space-y-1">
          <p>
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
              {!isDingTalk(row)
                ? row.kind
                : t(
                    row.kind === 'group'
                      ? row.collectionKey === 'all-messages'
                        ? 'standIn.workspace.group_all_new_messages'
                        : 'standIn.workspace.group_mentions'
                      : 'standIn.workspace.direct_messages'
                  )}{' '}
              ·{' '}
              {isDingTalk(row) && row.policy?.automatic && row.policy.askBeforeAct
                ? t('standIn.workspace.proposal_dingtalk_confirm')
                : policyName(row.policy)}
            </span>
          </p>
          <p
            className="whitespace-pre-wrap break-words text-text-secondary"
            data-testid="stand-in-proposal-connection-configuration"
          >
            {before.some(old => sourceKey(old) === sourceKey(row)) && (
              <>
                {t('standIn.workspace.before_change')}：
                {configuration(before.find(old => sourceKey(old) === sourceKey(row)))}
                {' → '}
              </>
            )}
            {t('standIn.workspace.after_change')}：{configuration(row)}
          </p>
        </div>
      ))}
      {removed.map(row => (
        <p key={sourceKey(row)}>
          <span className="text-text-muted">{t('standIn.workspace.connection_removed')}：</span>
          {row.name}
          <span className="text-text-secondary">
            {' · '}
            {row.configurationSummary ?? t('standIn.workspace.connection_default_configuration')}
          </span>
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
              {tagChanges.map(change => (
                <p key={change.key}>
                  {t('standIn.workspace.project_range_tags', { name: change.name })}：
                  {change.after.join('、') || t('standIn.workspace.no_tag_limit')}
                </p>
              ))}
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
