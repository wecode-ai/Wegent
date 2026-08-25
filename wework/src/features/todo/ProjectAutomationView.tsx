import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useState } from 'react'
import type {
  CloudLoopItem,
  CloudProject,
  CloudProjectMember,
  ProjectWorkflowDefinition,
} from '@/api/deliveries'
import type { ProjectAutomationRule } from '@/api/projectAutomations'
import type { ExecutionListApi } from '@/features/todo/ProjectQueueView'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type {
  CloneGitRepositoryInput,
  CreatedRuntimeProject,
  ProjectWithTasks,
  RuntimeWorkListResponse,
} from '@/types/api'
import { AutomationRulesView } from './AutomationRulesView.jsx'
import {
  automationInputFromUi,
  automationRuleFromLegacyWorkflow,
  automationRuleFromBackend,
  automationRunFromBackend,
  legacyWorkflowFromAutomationRule,
  type AutomationExecutionCatalog,
  type AutomationUiRule,
  type AutomationUiRun,
} from './automationRuleBackend'

interface ProjectAutomationViewProps {
  api: NonNullable<WorkbenchServices['deliveryApi']>
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
}

export function ProjectAutomationView(props: ProjectAutomationViewProps) {
  const {
    api,
    project,
    projectAutomationApi,
    deviceApi,
    modelApi,
    pluginApi,
    currentUserId = project.current_user_id,
    canManageAgents,
    onProjectUpdated,
  } = props
  const projectId = String(project.id)
  const [rules, setRules] = useState<AutomationUiRule[]>([])
  const [runs, setRuns] = useState<AutomationUiRun[]>([])
  const [executionCatalog, setExecutionCatalog] = useState<AutomationExecutionCatalog>({
    environments: [],
    models: [],
    plugins: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!projectAutomationApi) {
      setRules([])
      setRuns([])
      setError('当前项目没有可用的自动化服务')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [backendRules, devices, modelResponse] = await Promise.all([
        projectAutomationApi.list(projectId),
        deviceApi?.listDevices() ?? Promise.resolve([]),
        modelApi?.listModels() ?? Promise.resolve({ data: [] }),
      ])
      const availableDevices = devices.filter(device => device.status !== 'offline')
      const pluginGroups = pluginApi
        ? await Promise.all(availableDevices.map(device => pluginApi.listPlugins(device.device_id)))
        : []
      const canonicalRule = project.workflow_automation_id
        ? backendRules.find(rule => rule.id === project.workflow_automation_id)
        : null
      const legacyRule = canonicalRule
        ? null
        : automationRuleFromLegacyWorkflow(project, backendRules)
      const legacyDefinition = project.workflow_definition
      const runtimeDefinition = canonicalRule?.eventConfig.runtime_workflow_definition
      const internalDefinition =
        runtimeDefinition &&
        typeof runtimeDefinition === 'object' &&
        !Array.isArray(runtimeDefinition)
          ? (runtimeDefinition as ProjectWorkflowDefinition)
          : legacyDefinition
      const internalRuleIds = new Set(
        [
          internalDefinition?.ai_automation_rule_id,
          ...(internalDefinition?.nodes ?? []).map(node => node.automation_rule_id),
        ].filter((ruleId): ruleId is string => Boolean(ruleId) && ruleId !== canonicalRule?.id)
      )
      const visibleBackendRules = backendRules.filter(rule => !internalRuleIds.has(rule.id))
      const uiRules = [
        ...(legacyRule ? [legacyRule] : []),
        ...visibleBackendRules.map(automationRuleFromBackend),
      ]
      const runGroups = await Promise.all(
        backendRules.map(async backendRule => {
          const uiRule = internalRuleIds.has(backendRule.id)
            ? legacyRule
            : uiRules.find(candidate => candidate.id === backendRule.id)
          if (!uiRule) return []
          const backendRuns = await projectAutomationApi.listRuns(projectId, backendRule.id)
          return backendRuns
            .sort(
              (left, right) =>
                new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
            )
            .map(run => automationRunFromBackend(run, uiRule))
        })
      )
      const plugins = Array.from(
        new Map(
          pluginGroups.flat().map(plugin => [
            plugin.id,
            {
              id: plugin.id,
              label: plugin.displayName || plugin.pluginName,
              reference: { ...plugin },
            },
          ])
        ).values()
      )
      setRules(uiRules)
      setRuns(runGroups.flat())
      setExecutionCatalog({
        environments: availableDevices.map(device => ({
          deviceId: device.device_id,
          label: `${device.name} · ${device.status === 'online' ? '在线' : '忙碌'}`,
          executionEnvironment: device.device_type === 'cloud' ? 'cloud' : 'local',
        })),
        models: modelResponse.data
          .filter(model => model.isActive !== false && !model.compatibilityDisabled)
          .map(model => ({
            name: model.name,
            label: model.displayName || model.name,
            type: model.type,
            options: Object.fromEntries(
              Object.entries(model.config ?? {}).flatMap(([key, value]) =>
                typeof value === 'string' ? [[key, value]] : []
              )
            ),
          })),
        plugins,
      })
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [deviceApi, modelApi, pluginApi, project, projectAutomationApi, projectId])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  const persistRule = useCallback(
    async (rule: AutomationUiRule, published: boolean) => {
      if (!projectAutomationApi) throw new Error('当前项目没有可用的自动化服务')
      if (!canManageAgents) throw new Error('当前账号没有管理自动化的权限')
      if (currentUserId == null) throw new Error('当前项目缺少可用的 Runtime 用户')
      const nextRule = { ...rule, enabled: published ? true : rule.enabled }
      if (rule.origin === 'legacy_workflow') {
        const workflowDefinition = legacyWorkflowFromAutomationRule(nextRule)
        const result = await projectAutomationApi.migrateWorkflow(projectId, {
          projectVersion: project.version,
          automation: automationInputFromUi(nextRule, currentUserId),
          workflowDefinition,
        })
        const updatedProject: CloudProject = {
          ...project,
          workflow_automation_id: result.workflowAutomationId,
          workflow_definition: {
            version: workflowDefinition.version,
            stage_mode: 'none',
            advancement_policy: 'manual',
            coordinator_prompt: '',
            approval_policy: 'required',
            ai_automation_rule_id: null,
            execution_config: null,
            nodes: [],
          },
          version: result.projectVersion,
        }
        onProjectUpdated?.(updatedProject)
        const mapped = automationRuleFromBackend(result.automation)
        setRules(current =>
          current.map(candidate => (candidate.id === rule.id ? mapped : candidate))
        )
        setError('')
        return mapped
      }
      const input = automationInputFromUi(nextRule, currentUserId)
      const saved: ProjectAutomationRule = rule.persisted
        ? await projectAutomationApi.update(projectId, rule.id, {
            ...input,
            version: rule.version,
          })
        : await projectAutomationApi.create(projectId, input)
      const mapped = automationRuleFromBackend(saved)
      setRules(current => {
        const exists = current.some(candidate => candidate.id === mapped.id)
        return exists
          ? current.map(candidate => (candidate.id === mapped.id ? mapped : candidate))
          : [mapped, ...current]
      })
      setError('')
      return mapped
    },
    [canManageAgents, currentUserId, onProjectUpdated, project, projectAutomationApi, projectId]
  )

  const toggleRule = useCallback(
    async (rule: AutomationUiRule, enabled: boolean) => {
      if (!projectAutomationApi) throw new Error('当前项目没有可用的自动化服务')
      if (!canManageAgents) throw new Error('当前账号没有管理自动化的权限')
      if (rule.origin === 'legacy_workflow') {
        return persistRule({ ...rule, enabled }, false)
      }
      const saved = await projectAutomationApi.update(projectId, rule.id, {
        version: rule.version,
        enabled,
      })
      const mapped = automationRuleFromBackend(saved)
      setRules(current =>
        current.map(candidate => (candidate.id === mapped.id ? mapped : candidate))
      )
      return mapped
    },
    [canManageAgents, persistRule, projectAutomationApi, projectId]
  )

  const deleteRule = useCallback(
    async (rule: AutomationUiRule) => {
      if (!projectAutomationApi) throw new Error('当前项目没有可用的自动化服务')
      if (!canManageAgents) throw new Error('当前账号没有管理自动化的权限')
      if (rule.origin === 'legacy_workflow') {
        const updatedProject = await api.updateCloudProject(project.id, {
          version: project.version,
          workflow_definition: {
            version: Math.max(1, project.workflow_definition?.version ?? 1),
            stage_mode: 'none',
            advancement_policy: 'manual',
            coordinator_prompt: '',
            approval_policy: 'required',
            ai_automation_rule_id: null,
            execution_config: null,
            nodes: [],
          },
        })
        onProjectUpdated?.(updatedProject)
        setRules(current => current.filter(candidate => candidate.id !== rule.id))
        setRuns(current => current.filter(run => run.ruleId !== rule.id))
        return
      }
      const result = await projectAutomationApi.delete(projectId, rule.id)
      if (project.workflow_automation_id === rule.id) {
        onProjectUpdated?.({
          ...project,
          workflow_automation_id: result.workflowAutomationId,
          version: result.projectVersion,
        })
      }
      setRules(current => current.filter(candidate => candidate.id !== rule.id))
      setRuns(current => current.filter(run => run.ruleId !== rule.id))
    },
    [api, canManageAgents, onProjectUpdated, project, projectAutomationApi, projectId]
  )

  const duplicateRule = useCallback(
    async (rule: AutomationUiRule) => {
      const copy: AutomationUiRule = {
        ...rule,
        id: `draft-${crypto.randomUUID()}`,
        persisted: false,
        origin: 'automation',
        legacyDefinition: null,
        version: 1,
        name: `${rule.name} 副本`,
        enabled: false,
      }
      return persistRule(copy, false)
    },
    [persistRule]
  )

  const runRule = useCallback(
    async (rule: AutomationUiRule) => {
      if (!projectAutomationApi) throw new Error('当前项目没有可用的自动化服务')
      if (rule.origin === 'legacy_workflow') {
        throw new Error('旧 Issue 编排由 Issue 进入处理状态时触发')
      }
      if (!rule.persisted) throw new Error('请先保存自动化')
      const backendRun = await projectAutomationApi.runNow(projectId, rule.id)
      const mapped = automationRunFromBackend(backendRun, rule)
      setRuns(current => [mapped, ...current.filter(run => run.id !== mapped.id)])
      return mapped
    },
    [projectAutomationApi, projectId]
  )

  return (
    <AutomationRulesView
      rules={rules}
      runs={runs}
      loading={loading}
      error={error}
      canManage={canManageAgents}
      projectTags={project.tags}
      executionCatalog={executionCatalog}
      onReload={load}
      onSaveRule={persistRule}
      onToggleRule={toggleRule}
      onDuplicateRule={duplicateRule}
      onDeleteRule={deleteRule}
      onRunRule={runRule}
    />
  )
}
