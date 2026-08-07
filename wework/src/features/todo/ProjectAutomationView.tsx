import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { ProjectChatAgentsSection } from './ProjectChatAgentsSection'
import { ProjectQueueView, type ExecutionListApi } from './ProjectQueueView'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

export function ProjectAutomationView({
  api,
  project,
  projectChatAgentApi,
  executionApi,
  deviceApi,
  modelApi,
  currentUserId,
  canManageAgents,
  onOpenTask,
}: {
  api: DeliveryApi
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  executionApi?: ExecutionListApi
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
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
        <ProjectChatAgentsSection
          project={project}
          projectChatAgentApi={projectChatAgentApi}
          deviceApi={deviceApi}
          modelApi={modelApi}
          canManage={canManageAgents}
        />
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
