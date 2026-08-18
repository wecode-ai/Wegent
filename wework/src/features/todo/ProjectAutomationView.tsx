import { useCallback, useRef, useState } from 'react'
import type { CloudLoopItem, CloudProject, ProjectWorkflowDefinition } from '@/api/deliveries'
import type { ProjectAutomationInput, ProjectAutomationRule } from '@/api/projectAutomations'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { ProjectChatAgentsSection } from './ProjectChatAgentsSection'
import { ProjectQueueView, type ExecutionListApi } from './ProjectQueueView'
import { ProjectAutomationRulesSection } from './ProjectAutomationRulesSection'
import { ProjectWorkflowEditor } from './ProjectWorkflowEditor'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

export function ProjectAutomationView({
  api,
  project,
  projectChatAgentApi,
  projectAutomationApi,
  executionApi,
  deviceApi,
  modelApi,
  teamApi,
  localProjects,
  runtimeWork,
  currentUserId,
  canManageAgents,
  onOpenTask,
  onProjectUpdated,
}: {
  api: DeliveryApi
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  projectAutomationApi?: WorkbenchServices['projectAutomationApi']
  executionApi?: ExecutionListApi
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
  teamApi?: WorkbenchServices['teamApi']
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentUserId?: string | number
  canManageAgents: boolean
  onOpenTask?: (item: CloudLoopItem) => void
  onProjectUpdated?: (project: CloudProject) => void
}) {
  const { t } = useTranslation('common')
  const [workflowDefinition, setWorkflowDefinition] = useState<ProjectWorkflowDefinition>(
    project.workflow_definition ?? { version: 1, nodes: [] }
  )
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const projectVersionRef = useRef({ projectId: String(project.id), version: project.version })
  const [automationRules, setAutomationRules] = useState<ProjectAutomationRule[]>([])
  const [projectAgents, setProjectAgents] = useState<ProjectChatAgent[]>([])
  const [robotCreateRequestKey, setRobotCreateRequestKey] = useState(0)
  const [coordinatorCreateRequestKey, setCoordinatorCreateRequestKey] = useState(0)

  const handleRulesChange = useCallback((rules: ProjectAutomationRule[]) => {
    setAutomationRules(current => {
      const next = new Map(rules.map(rule => [rule.id, rule]))
      for (const rule of current) {
        if (rule.triggerType === 'workflow' && !next.has(rule.id)) next.set(rule.id, rule)
      }
      return [...next.values()]
    })
  }, [])
  const handleAgentsChange = useCallback((agents: ProjectChatAgent[]) => {
    setProjectAgents(agents.filter(agent => agent.status === 'active'))
  }, [])

  const ensureStageRobotRule = useCallback(
    async (agentId: string): Promise<string | null> => {
      const existing = automationRules.find(
        rule =>
          rule.triggerType === 'workflow' &&
          rule.assignmentMode === 'manual' &&
          rule.agentId === agentId
      )
      if (existing) return existing.id
      const agent = projectAgents.find(candidate => candidate.id === agentId)
      if (!agent || !projectAutomationApi) return null
      const input: ProjectAutomationInput = {
        name: `Workflow · ${agent.name}`,
        prompt: 'Use the workflow stage prompt as the concrete task instruction.',
        triggerType: 'workflow',
        eventType: null,
        eventConfig: { workflowStageProfile: true },
        cronExpression: null,
        timezone: 'Asia/Shanghai',
        enabled: true,
        assignmentMode: 'manual',
        managerType: null,
        agentId: agent.id,
        wegentTeamId: null,
        model: null,
        executionEnvironment: null,
        executionDeviceId: null,
      }
      const created = await projectAutomationApi.create(String(project.id), input)
      setAutomationRules(current =>
        current.some(rule => rule.id === created.id) ? current : [...current, created]
      )
      return created.id
    },
    [automationRules, project.id, projectAgents, projectAutomationApi]
  )

  async function saveWorkflow() {
    if (workflowBusy) return
    setWorkflowBusy(true)
    setWorkflowError(null)
    try {
      const projectVersion =
        projectVersionRef.current.projectId === String(project.id)
          ? projectVersionRef.current.version
          : project.version
      const updated = await api.updateCloudProject(project.id, {
        workflow_definition: {
          ...workflowDefinition,
          version: workflowDefinition.version + 1,
        },
        version: projectVersion,
      })
      projectVersionRef.current = {
        projectId: String(project.id),
        version: updated.version,
      }
      setWorkflowDefinition(
        updated.workflow_definition ?? { version: workflowDefinition.version + 1, nodes: [] }
      )
      onProjectUpdated?.(updated)
    } catch (cause) {
      setWorkflowError(cause instanceof Error ? cause.message : t('todo.workflow_save_failed'))
    } finally {
      setWorkflowBusy(false)
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="project-automation-view"
    >
      <div className="px-6 pb-8 pt-4">
        <header>
          <h2 className="text-heading-md font-semibold">{t('workbench.automation_title')}</h2>
          <p className="mt-1 text-sm text-text-muted">{t('workbench.automation_description')}</p>
        </header>
        <ProjectAutomationRulesSection
          projectId={project.id}
          api={project.task_provider === 'local' ? projectAutomationApi : undefined}
          agentApi={projectChatAgentApi}
          canManage={canManageAgents}
          deviceApi={deviceApi}
          modelApi={modelApi}
          teamApi={teamApi}
          projectTags={project.tags ?? []}
          createAiCoordinatorRequestKey={coordinatorCreateRequestKey}
          onOpenTask={taskId => {
            void api.getLoopItem(taskId).then(item => onOpenTask?.(item))
          }}
          onRulesChange={handleRulesChange}
        />
        <ProjectWorkflowEditor
          value={workflowDefinition}
          busy={workflowBusy}
          onChange={setWorkflowDefinition}
          onSave={() => void saveWorkflow()}
          automationRules={automationRules}
          projectAgents={projectAgents}
          onEnsureStageRobotRule={ensureStageRobotRule}
          onRequestCreateRobot={() => setRobotCreateRequestKey(current => current + 1)}
          onRequestConfigureAiCoordinator={
            canManageAgents
              ? () => setCoordinatorCreateRequestKey(current => current + 1)
              : undefined
          }
        />
        {workflowError ? <p className="mt-3 text-xs text-destructive">{workflowError}</p> : null}
        <ProjectChatAgentsSection
          project={project}
          projectChatAgentApi={projectChatAgentApi}
          deviceApi={deviceApi}
          modelApi={modelApi}
          teamApi={teamApi}
          localProjects={localProjects}
          runtimeWork={runtimeWork}
          canManage={canManageAgents}
          createRequestKey={robotCreateRequestKey}
          onAgentsChange={handleAgentsChange}
        />
        <section className="mt-8 border-t border-border pt-8">
          <div>
            <h3 className="text-heading-md font-semibold">
              {t('workbench.automation_queue_title')}
            </h3>
            <p className="mt-1 text-sm text-text-muted">{t('workbench.queue_description')}</p>
          </div>
          <div className="mt-5">
            <ProjectQueueView
              api={api}
              project={project}
              projectChatAgentApi={projectChatAgentApi}
              executionApi={executionApi}
              currentUserId={currentUserId}
              onOpenTask={onOpenTask}
              embedded
            />
          </div>
        </section>
      </div>
    </div>
  )
}
