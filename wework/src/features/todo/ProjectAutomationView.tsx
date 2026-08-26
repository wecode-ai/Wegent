import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CloudLoopItem,
  CloudProject,
  CloudProjectMember,
  ProjectWorkflowDefinition,
} from '@/api/deliveries'
import type { ProjectAutomationInput, ProjectAutomationRule } from '@/api/projectAutomations'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CloneGitRepositoryInput,
  CreatedRuntimeProject,
  ProjectWithTasks,
  RuntimeWorkListResponse,
} from '@/types/api'
import { ProjectChatAgentsSection } from './ProjectChatAgentsSection'
import { ProjectQueueView, type ExecutionListApi } from './ProjectQueueView'
import { ProjectAutomationRulesSection } from './ProjectAutomationRulesSection'
import { ProjectWorkflowEditor } from './ProjectWorkflowEditor'
import { PullRequestAutomationSettings } from './PullRequestAutomationSettings'
import { workflowExecutionConfigForAgent } from './workflowExecutionConfig'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

export function ProjectAutomationView({
  api,
  project,
  projectChatAgentApi,
  projectAutomationApi,
  runtimeProfileApi,
  executionApi,
  deviceApi,
  modelApi,
  teamApi,
  pluginApi,
  localProjects = [],
  runtimeWork,
  onCreateLocalCodeProject,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  currentUserId,
  projectMembers = [],
  canManageAgents,
  onOpenTask,
  onProjectUpdated,
}: {
  api: DeliveryApi
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  projectAutomationApi?: WorkbenchServices['projectAutomationApi']
  runtimeProfileApi?: WorkbenchServices['runtimeProfileApi']
  executionApi?: ExecutionListApi
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
  teamApi?: WorkbenchServices['teamApi']
  pluginApi?: WorkbenchServices['pluginApi']
  localProjects?: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  onCreateLocalCodeProject?: (data: {
    deviceId: string
    name: string
    roots: string[]
  }) => Promise<CreatedRuntimeProject>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  currentUserId?: string | number
  projectMembers?: CloudProjectMember[]
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
  const [pullRequestAutomationBusy, setPullRequestAutomationBusy] = useState(false)
  const [pullRequestAutomationError, setPullRequestAutomationError] = useState<string | null>(null)
  const projectVersionRef = useRef({ projectId: String(project.id), version: project.version })
  const workflowEditRevisionRef = useRef(0)
  const [automationRules, setAutomationRules] = useState<ProjectAutomationRule[]>([])
  const [projectAgents, setProjectAgents] = useState<ProjectChatAgent[]>([])
  const [runtimeProfiles, setRuntimeProfiles] = useState<RuntimeProfile[]>([])
  const [robotCreateRequestKey, setRobotCreateRequestKey] = useState(0)
  const robotCreateResolverRef = useRef<((agent: ProjectChatAgent | null) => void) | null>(null)
  const [coordinatorCreateRequestKey, setCoordinatorCreateRequestKey] = useState(0)

  useEffect(() => {
    const projectId = String(project.id)
    const versionRef = projectVersionRef.current
    if (versionRef.projectId === projectId && versionRef.version === project.version) return
    projectVersionRef.current = { projectId, version: project.version }
    setWorkflowDefinition(project.workflow_definition ?? { version: 1, nodes: [] })
  }, [project.id, project.version, project.workflow_definition])

  useEffect(() => {
    if (!runtimeProfileApi) return
    let active = true
    void runtimeProfileApi
      .list()
      .then(profiles => {
        if (active) setRuntimeProfiles(profiles)
      })
      .catch(cause => {
        if (active) {
          setWorkflowError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      active = false
    }
  }, [runtimeProfileApi])

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
  const requestCreateRobot = useCallback(
    () =>
      new Promise<ProjectChatAgent | null>(resolve => {
        robotCreateResolverRef.current?.(null)
        robotCreateResolverRef.current = resolve
        setRobotCreateRequestKey(current => current + 1)
      }),
    []
  )
  const settleCreateRobot = useCallback((agent: ProjectChatAgent | null) => {
    const resolve = robotCreateResolverRef.current
    robotCreateResolverRef.current = null
    resolve?.(agent)
  }, [])
  useEffect(
    () => () => {
      robotCreateResolverRef.current?.(null)
      robotCreateResolverRef.current = null
    },
    []
  )
  const handleWorkflowChange = useCallback((definition: ProjectWorkflowDefinition) => {
    workflowEditRevisionRef.current += 1
    setWorkflowDefinition(definition)
  }, [])

  const ensureStageRobotRule = useCallback(
    async (config: {
      roleSource: 'generic' | 'agent'
      agentId: string | null
      runtimeSource: 'issue_creator' | 'agent_default' | 'fixed_profile' | 'runtime_user'
      runtimeProfileId: string | null
      runtimeUserId: number | null
    }): Promise<string | null> => {
      const existing = automationRules.find(
        rule =>
          rule.triggerType === 'workflow' &&
          rule.assignmentMode === 'manual' &&
          rule.roleSource === config.roleSource &&
          rule.agentId === config.agentId &&
          rule.runtimeSource === config.runtimeSource &&
          rule.runtimeProfileId === config.runtimeProfileId &&
          rule.runtimeUserId === config.runtimeUserId
      )
      if (existing) return existing.id
      const agent = config.agentId
        ? projectAgents.find(candidate => candidate.id === config.agentId)
        : null
      if ((config.roleSource === 'agent' && !config.agentId) || !projectAutomationApi) return null
      const input: ProjectAutomationInput = {
        name: `Workflow · ${agent?.name ?? config.agentId ?? 'Generic AI'}`,
        prompt: 'Use the workflow stage prompt as the concrete task instruction.',
        triggerType: 'workflow',
        eventType: null,
        eventConfig: { workflowStageProfile: true },
        cronExpression: null,
        timezone: 'Asia/Shanghai',
        enabled: true,
        assignmentMode: 'manual',
        managerType: null,
        agentId: agent?.id ?? null,
        wegentTeamId: null,
        model: null,
        executionEnvironment: null,
        executionDeviceId: null,
        roleSource: config.roleSource,
        runtimeSource: config.runtimeSource,
        runtimeProfileId: config.runtimeProfileId,
        runtimeUserId: config.runtimeUserId,
      }
      const created = await projectAutomationApi.create(String(project.id), input)
      setAutomationRules(current =>
        current.some(rule => rule.id === created.id) ? current : [...current, created]
      )
      return created.id
    },
    [automationRules, project.id, projectAgents, projectAutomationApi]
  )

  async function saveWorkflow(definition: ProjectWorkflowDefinition) {
    if (workflowBusy) return
    const savedEditRevision = workflowEditRevisionRef.current
    setWorkflowBusy(true)
    setWorkflowError(null)
    try {
      const snapshotDefinition: ProjectWorkflowDefinition = {
        ...definition,
        execution_config: null,
        nodes: definition.nodes.map(node => {
          if (!node.automation_rule_id) {
            return {
              ...node,
              execution_config: null,
              execution_config_override: false,
            }
          }
          const rule = automationRules.find(candidate => candidate.id === node.automation_rule_id)
          const agent = projectAgents.find(candidate => candidate.id === rule?.agentId)
          const runtimeProfileId =
            rule?.runtimeSource === 'fixed_profile'
              ? rule.runtimeProfileId
              : (agent?.defaultRuntimeProfileId ?? null)
          const runtimeProfile = runtimeProfiles.find(
            candidate => candidate.id === runtimeProfileId
          )
          return {
            ...node,
            execution_config: agent
              ? workflowExecutionConfigForAgent(agent, runtimeProfile, runtimeProfileId)
              : null,
            execution_config_override: false,
          }
        }),
      }
      const projectVersion =
        projectVersionRef.current.projectId === String(project.id)
          ? projectVersionRef.current.version
          : project.version
      const updated = await api.updateCloudProject(project.id, {
        workflow_definition: {
          ...snapshotDefinition,
          version: definition.version + 1,
        },
        version: projectVersion,
      })
      projectVersionRef.current = {
        projectId: String(project.id),
        version: updated.version,
      }
      const savedDefinition = updated.workflow_definition ?? {
        version: definition.version + 1,
        nodes: [],
      }
      setWorkflowDefinition(current =>
        workflowEditRevisionRef.current === savedEditRevision
          ? savedDefinition
          : { ...current, version: savedDefinition.version }
      )
      onProjectUpdated?.(updated)
    } catch (cause) {
      setWorkflowError(cause instanceof Error ? cause.message : t('todo.workflow_save_failed'))
    } finally {
      setWorkflowBusy(false)
    }
  }

  async function savePullRequestAutomation(
    value: NonNullable<CloudProject['pull_request_automation']>
  ) {
    if (pullRequestAutomationBusy) return
    setPullRequestAutomationBusy(true)
    setPullRequestAutomationError(null)
    try {
      const projectVersion =
        projectVersionRef.current.projectId === String(project.id)
          ? projectVersionRef.current.version
          : project.version
      const updated = await api.updateCloudProject(project.id, {
        pull_request_automation: value,
        version: projectVersion,
      })
      projectVersionRef.current = {
        projectId: String(project.id),
        version: updated.version,
      }
      onProjectUpdated?.(updated)
    } catch (cause) {
      setPullRequestAutomationError(
        cause instanceof Error
          ? cause.message
          : t('workbench.pull_request_automation_save_failed', '保存 PR 自动修复设置失败')
      )
    } finally {
      setPullRequestAutomationBusy(false)
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
        <PullRequestAutomationSettings
          key={String(project.id)}
          value={
            project.pull_request_automation ?? {
              enabled: false,
              statuses: [
                'checks_failed',
                'merge_conflict',
                'merge_queue_failed',
                'merge_queue_timed_out',
                'merge_queue_conflicting',
              ],
              prompt: '',
            }
          }
          canManage={canManageAgents}
          busy={pullRequestAutomationBusy}
          onSave={savePullRequestAutomation}
        />
        {pullRequestAutomationError ? (
          <p className="mt-2 text-sm text-red-500">{pullRequestAutomationError}</p>
        ) : null}
        <ProjectWorkflowEditor
          value={workflowDefinition}
          busy={workflowBusy}
          onChange={handleWorkflowChange}
          onSave={saveWorkflow}
          automationRules={automationRules}
          projectAgents={projectAgents}
          onEnsureStageRobotRule={ensureStageRobotRule}
          onRequestCreateRobot={requestCreateRobot}
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
          pluginApi={pluginApi}
          localProjects={localProjects}
          runtimeWork={runtimeWork}
          runtimeProfiles={runtimeProfiles}
          onCreateLocalCodeProject={onCreateLocalCodeProject}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onListDeviceDirectories={onListDeviceDirectories}
          onCreateDeviceDirectory={onCreateDeviceDirectory}
          onCloneGitRepository={onCloneGitRepository}
          canManage={canManageAgents}
          createRequestKey={robotCreateRequestKey}
          onAgentsChange={handleAgentsChange}
          onAgentCreated={agent => settleCreateRobot(agent)}
          onCreateCancelled={() => settleCreateRobot(null)}
        />
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
          runtimeProfiles={runtimeProfiles}
          projectMembers={projectMembers}
          onOpenTask={taskId => {
            void api.getLoopItem(taskId).then(item => onOpenTask?.(item))
          }}
          onRulesChange={handleRulesChange}
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
              runtimeProfileApi={runtimeProfileApi}
              runtimeProfiles={runtimeProfiles}
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
