import { useContext, useEffect, useMemo, useState } from 'react'
import { canAccessCollaborationProjectView, IssueActivityMarkdown } from '@wegent/collaboration'
import type {
  CollaborationMember,
  CollaborationPlatformLocation,
  CollaborationProject,
  CollaborationView,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { WeworkSharedProject } from '@/features/todo/WeworkCollaborationPlatform'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { projectScopeOf } from '../model'
import { invalidatesExperienceRead } from '../data/useExperienceSourceReads'
import { ProjectDrilldown, type ProjectDrilldownView } from './ProjectDrilldown'

interface Props {
  project: CollaborationProject
  api: SharedWorkspaceApi
  view: ProjectDrilldownView
  planView: CollaborationView
  active: boolean
  onViewChange(view: ProjectDrilldownView): void
  onPlanViewChange(view: CollaborationView): void
  onOpenIssue(issueId: string): void
  onBack(): void
}

export function ProjectExperience(props: Props) {
  const { state, services } = useWorkbench()
  const { i18n, t } = useTranslation('collaborationExp')
  const canConfigure = canAccessCollaborationProjectView(props.project, 'manage')
  const location: CollaborationPlatformLocation = {
    platformView: 'spaces',
    collaborationDomain: props.project.project_store === 'local' ? 'local' : 'cloud',
    workspaceId: props.project.workspace_id ?? null,
    workspaceView: 'projects',
    projectId: props.project.id,
    projectView: props.view === 'settings' ? 'manage' : props.planView,
    issueId: null,
  }
  return (
    <ProjectDrilldown
      project={projectScopeOf(props.project)}
      view={props.view}
      onViewChange={props.onViewChange}
      onBack={props.onBack}
      canConfigure={canConfigure}
    >
      {props.view === 'overview' ? (
        <ProjectOverview api={props.api} project={props.project} active={props.active} />
      ) : props.view === 'settings' && !canConfigure ? (
        <p role="status" className="p-5 text-sm text-text-secondary">
          {t('tasks.configurationUnavailable')}
        </p>
      ) : props.active ? (
        <WeworkSharedProject
          key={`${props.project.project_store}:${props.project.id}`}
          api={props.api}
          project={props.project}
          projectCatalogApi={props.api.projects}
          detailServices={
            services.projectSpaceDetailServices?.[
              props.project.project_store === 'local' ? 'local' : 'cloud'
            ]
          }
          devices={state.devices}
          localProjects={state.projects}
          locale={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
          location={location}
          services={services}
          userId={state.user?.id ?? ''}
          workspace={null}
          runtimeWork={state.runtimeWork}
          setLocation={update => {
            const next = typeof update === 'function' ? update(location) : update
            if (next.issueId) props.onOpenIssue(next.issueId)
            else if (next.projectView === 'manage') props.onViewChange('settings')
            else props.onPlanViewChange(next.projectView)
          }}
        />
      ) : null}
    </ProjectDrilldown>
  )
}

function ProjectOverview({
  api,
  project,
  active,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  active: boolean
}) {
  const { t } = useTranslation('collaborationExp')
  const { state: workbench } = useWorkbench()
  const cloud = useContext(CloudConnectionContext)
  const backendUrl = cloud?.apiBaseUrl ?? ''
  const userId = workbench.user?.id
  const scope = JSON.stringify([backendUrl, userId, project.project_store, project.current_user_id])
  const [revision, setRevision] = useState(0)
  const owner = useMemo(() => ({ api, projectId: project.id, scope }), [api, project.id, scope])
  const request = useMemo(() => ({ owner, active, revision }), [owner, active, revision])
  const [state, setSnapshot] = useState<{
    owner: typeof owner
    request: typeof request | null
    members: CollaborationMember[] | null
    error: string | null
  }>({ owner, request: null, members: null, error: null })
  const snapshot = state.owner === owner ? state : { request: null, members: null, error: null }
  const loading = active && snapshot.request !== request
  const error = loading ? null : snapshot.error
  useEffect(() => {
    if (!request.active) return
    let cancelled = false
    const { owner } = request
    void owner.api.members.list(owner.projectId).then(
      members => {
        if (!cancelled) setSnapshot({ owner, request, members, error: null })
      },
      cause => {
        if (!cancelled)
          setSnapshot(previous => ({
            owner,
            request,
            members:
              previous.owner === owner && !invalidatesExperienceRead(cause)
                ? previous.members
                : null,
            error: String(cause),
          }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request])
  return (
    <section
      className="experience-project-overview"
      data-testid="collaboration-exp-project-overview-body"
    >
      <div className="experience-project-overview-heading">
        <h2>{project.name}</h2>
        <p className="text-sm text-text-muted">{project.project_key}</p>
      </div>
      {project.description ? (
        <IssueActivityMarkdown content={project.description} />
      ) : (
        <p className="text-sm text-text-secondary">{t('tasks.noProjectDescription')}</p>
      )}
      <div
        className="experience-project-members"
        data-testid="collaboration-exp-project-members"
        aria-busy={loading}
      >
        <h3>{t('tasks.members')}</h3>
        {loading && snapshot.members === null ? (
          <p
            role="status"
            data-testid="collaboration-exp-project-members-loading"
            className="text-sm text-text-muted"
          >
            {t('tasks.membersLoading')}
          </p>
        ) : null}
        <div className="experience-project-member-list">
          {snapshot.members?.map(member => (
            <span key={member.user_id}>
              <span className="experience-project-member-avatar" aria-hidden="true">
                {member.user_name?.slice(0, 1)}
              </span>
              {member.user_name}
            </span>
          ))}
        </div>
        {snapshot.members?.length === 0 && !error ? (
          <p
            role="status"
            data-testid="collaboration-exp-project-members-empty"
            className="text-sm text-text-muted"
          >
            {t('tasks.membersEmpty')}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="text-sm">
            <p>{t('tasks.membersFailed')}</p>
            <Button
              variant="ghost"
              data-testid="collaboration-exp-project-members-retry"
              onClick={() => setRevision(value => value + 1)}
            >
              {t('retry')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
