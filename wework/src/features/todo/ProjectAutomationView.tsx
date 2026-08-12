import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { ProjectChatAgentsSection } from './ProjectChatAgentsSection'
import { ProjectDevelopmentWorkflowSection } from './ProjectDevelopmentWorkflowSection'
import { ProjectWorkflowAutomationsSection } from './ProjectWorkflowAutomationsSection'
import { ProjectQueueView, type ExecutionListApi } from './ProjectQueueView'
import { ProjectAutomationRulesSection } from './ProjectAutomationRulesSection'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

export function ProjectAutomationView({
  api,
  project,
  projectChatAgentApi,
  projectAutomationApi,
  executionApi,
  deviceApi,
  modelApi,
  projectWorkflowApi,
  teamApi,
  localProjects,
  runtimeWork,
  currentUserId,
  canManageAgents,
  onOpenTask,
}: {
  api: DeliveryApi
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  projectAutomationApi?: WorkbenchServices['projectAutomationApi']
  executionApi?: ExecutionListApi
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
  projectWorkflowApi?: WorkbenchServices['projectWorkflowApi']
  teamApi: WorkbenchServices['teamApi']
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentUserId?: string | number
  canManageAgents: boolean
  onOpenTask?: (item: CloudLoopItem) => void
}) {
  const { t } = useTranslation('common')
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="project-automation-view"
    >
      <div className="px-6 pb-8 pt-4">
        <header className="mb-4">
          <h2 className="text-heading-md font-semibold">{t('workbench.automation_title')}</h2>
          <p className="mt-1 text-sm text-text-muted">{t('workbench.automation_description')}</p>
        </header>
        <ProjectAutomationRulesSection
          projectId={project.id}
          api={project.task_provider === 'local' ? projectAutomationApi : undefined}
          agentApi={projectChatAgentApi}
          canManage={canManageAgents}
          deviceApi={deviceApi}
          onOpenTask={taskId => {
            void api.getLoopItem(taskId).then(item => onOpenTask?.(item))
          }}
        />
        <ProjectChatAgentsSection
          project={project}
          projectChatAgentApi={projectChatAgentApi}
          deviceApi={deviceApi}
          modelApi={modelApi}
          localProjects={localProjects}
          runtimeWork={runtimeWork}
          canManage={canManageAgents}
        />
        {projectWorkflowApi && Number(currentUserId) > 0 ? (
          <>
            <ProjectDevelopmentWorkflowSection
              projectId={project.id}
              api={projectWorkflowApi}
              projectChatAgentApi={projectChatAgentApi}
              teamApi={teamApi}
              canManage={canManageAgents}
              currentUserId={Number(currentUserId)}
            />
            <ProjectWorkflowAutomationsSection
              projectId={project.id}
              api={projectWorkflowApi}
              deviceApi={deviceApi}
              canManage={canManageAgents}
              localProject={project.project_store === 'local'}
            />
          </>
        ) : null}
        <section className="mt-8 border-t border-border pt-6">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-heading-md font-semibold">
              {t('workbench.automation_queue_title')}
            </h3>
            <span className="text-xs text-text-muted">{t('workbench.queue_description')}</span>
          </div>
          <ProjectQueueView
            api={api}
            project={project}
            projectChatAgentApi={projectChatAgentApi}
            executionApi={executionApi}
            currentUserId={currentUserId}
            onOpenTask={onOpenTask}
            embedded
          />
        </section>
      </div>
    </div>
  )
}
