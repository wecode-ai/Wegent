import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useRef, useState } from 'react'
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

interface ProjectAutomationRuleSnapshot {
  rules: AutomationUiRule[]
  runSources: AutomationRunSource[]
}

interface AutomationRunSource {
  automationId: string
  ruleId: string
}

interface ProjectAutomationRuleCacheEntry extends ProjectAutomationRuleSnapshot {
  source: object
  updatedAt: number
}

interface ProjectAutomationRuleLoadRequest {
  source: object
  promise: Promise<ProjectAutomationRuleSnapshot>
}

interface ExecutionCatalogCacheEntry {
  deviceSource: object | undefined
  modelSource: object | undefined
  pluginSource: object | undefined
  catalog: AutomationExecutionCatalog
  updatedAt: number
}

interface ExecutionCatalogLoadRequest {
  deviceSource: object | undefined
  modelSource: object | undefined
  pluginSource: object | undefined
  promise: Promise<AutomationExecutionCatalog>
}

const AUTOMATION_CACHE_FRESH_MS = 30_000
const AUTOMATION_RUN_REFRESH_MS = 15_000
const projectAutomationRuleCache = new Map<string, ProjectAutomationRuleCacheEntry>()
const projectAutomationRuleLoads = new Map<string, ProjectAutomationRuleLoadRequest>()
const executionCatalogCache = new Map<string, ExecutionCatalogCacheEntry>()
const executionCatalogLoads = new Map<string, ExecutionCatalogLoadRequest>()

function readProjectAutomationRuleCache(
  cacheKey: string,
  source: object | undefined
): ProjectAutomationRuleCacheEntry | null {
  if (!source) return null
  const cached = projectAutomationRuleCache.get(cacheKey)
  return cached?.source === source ? cached : null
}

function executionCatalogSourcesMatch(
  entry: {
    deviceSource: object | undefined
    modelSource: object | undefined
    pluginSource: object | undefined
  },
  deviceSource: object | undefined,
  modelSource: object | undefined,
  pluginSource: object | undefined
): boolean {
  return (
    entry.deviceSource === deviceSource &&
    entry.modelSource === modelSource &&
    entry.pluginSource === pluginSource
  )
}

function buildAutomationRuleSnapshot(
  project: CloudProject,
  backendRules: ProjectAutomationRule[]
): ProjectAutomationRuleSnapshot {
  const canonicalRule = project.workflow_automation_id
    ? backendRules.find(rule => rule.id === project.workflow_automation_id)
    : null
  const legacyRule = canonicalRule ? null : automationRuleFromLegacyWorkflow(project, backendRules)
  const legacyDefinition = project.workflow_definition
  const runtimeDefinition = canonicalRule?.eventConfig.runtime_workflow_definition
  const internalDefinition =
    runtimeDefinition && typeof runtimeDefinition === 'object' && !Array.isArray(runtimeDefinition)
      ? (runtimeDefinition as ProjectWorkflowDefinition)
      : legacyDefinition
  const internalRuleIds = new Set(
    [
      internalDefinition?.ai_automation_rule_id,
      ...(internalDefinition?.nodes ?? []).map(node => node.automation_rule_id),
    ].filter((ruleId): ruleId is string => Boolean(ruleId) && ruleId !== canonicalRule?.id)
  )
  const visibleBackendRules = backendRules.filter(rule => !internalRuleIds.has(rule.id))
  const rules = [
    ...(legacyRule ? [legacyRule] : []),
    ...visibleBackendRules.map(automationRuleFromBackend),
  ]
  const runSources = rules.flatMap(rule => {
    if (rule.origin === 'automation') {
      return [{ automationId: rule.id, ruleId: rule.id }]
    }
    return backendRules
      .filter(backendRule => internalRuleIds.has(backendRule.id))
      .map(backendRule => ({
        automationId: backendRule.id,
        ruleId: rule.id,
      }))
  })
  return { rules, runSources }
}

async function loadAutomationRuns(
  projectAutomationApi: NonNullable<WorkbenchServices['projectAutomationApi']>,
  projectId: string,
  runSources: AutomationRunSource[],
  rules: AutomationUiRule[]
): Promise<AutomationUiRun[]> {
  const rulesById = new Map(rules.map(rule => [rule.id, rule]))
  const runGroups = await Promise.all(
    runSources.map(async source => {
      const rule = rulesById.get(source.ruleId)
      if (!rule) return []
      const backendRuns = await projectAutomationApi.listRuns(projectId, source.automationId)
      return backendRuns.map(run => automationRunFromBackend(run, rule))
    })
  )
  return runGroups
    .flat()
    .sort((left, right) => Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt))
}

async function fetchExecutionCatalog(
  deviceApi: WorkbenchServices['deviceApi'] | undefined,
  modelApi: WorkbenchServices['modelApi'] | undefined,
  pluginApi: WorkbenchServices['pluginApi'] | undefined
): Promise<AutomationExecutionCatalog> {
  const [devices, modelResponse] = await Promise.all([
    deviceApi?.listDevices() ?? Promise.resolve([]),
    modelApi?.listModels() ?? Promise.resolve({ data: [] }),
  ])
  const availableDevices = devices.filter(device => device.status !== 'offline')
  const pluginGroups = pluginApi
    ? await Promise.all(availableDevices.map(device => pluginApi.listPlugins(device.device_id)))
    : []
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
  return {
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
  }
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
  const cacheKey = `${projectId}:${String(currentUserId ?? '')}`
  const projectRef = useRef(project)
  const initialCache = readProjectAutomationRuleCache(cacheKey, projectAutomationApi)
  const [rules, setRules] = useState<AutomationUiRule[]>(() => initialCache?.rules ?? [])
  const [runs, setRuns] = useState<AutomationUiRun[]>([])
  const [runSources, setRunSources] = useState<AutomationRunSource[]>(
    () => initialCache?.runSources ?? []
  )
  const [runsLoaded, setRunsLoaded] = useState(false)
  const runsRequestRef = useRef<Promise<AutomationUiRun[]> | null>(null)
  const [loading, setLoading] = useState(() => !initialCache)
  const [error, setError] = useState('')

  useEffect(() => {
    projectRef.current = project
  }, [project])

  const load = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (!projectAutomationApi) {
        setRules([])
        setRunSources([])
        setError('当前项目没有可用的自动化服务')
        setLoading(false)
        return
      }
      const cached = readProjectAutomationRuleCache(cacheKey, projectAutomationApi)
      if (cached && !force && Date.now() - cached.updatedAt < AUTOMATION_CACHE_FRESH_MS) {
        setLoading(false)
        return
      }
      if (!cached) setLoading(true)
      try {
        let request = projectAutomationRuleLoads.get(cacheKey)
        if (!request || request.source !== projectAutomationApi) {
          const loadProject = projectRef.current
          const promise = projectAutomationApi
            .list(projectId)
            .then(backendRules => buildAutomationRuleSnapshot(loadProject, backendRules))
          request = { source: projectAutomationApi, promise }
          projectAutomationRuleLoads.set(cacheKey, request)
          const clearRequest = () => {
            if (projectAutomationRuleLoads.get(cacheKey)?.promise === promise) {
              projectAutomationRuleLoads.delete(cacheKey)
            }
          }
          void promise.then(clearRequest, clearRequest)
        }
        const snapshot = await request.promise
        projectAutomationRuleCache.set(cacheKey, {
          ...snapshot,
          source: projectAutomationApi,
          updatedAt: Date.now(),
        })
        setRules(snapshot.rules)
        setRunSources(snapshot.runSources)
        setError('')
      } catch (loadError) {
        if (!cached) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      } finally {
        setLoading(false)
      }
    },
    [cacheKey, projectAutomationApi, projectId]
  )

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  const refreshRuns = useCallback(async (): Promise<AutomationUiRun[]> => {
    if (!projectAutomationApi) throw new Error('当前项目没有可用的自动化服务')
    if (runsRequestRef.current) return runsRequestRef.current
    const request = loadAutomationRuns(projectAutomationApi, projectId, runSources, rules)
      .then(refreshedRuns => {
        setRuns(refreshedRuns)
        setRunsLoaded(true)
        return refreshedRuns
      })
      .finally(() => {
        if (runsRequestRef.current === request) runsRequestRef.current = null
      })
    runsRequestRef.current = request
    return request
  }, [projectAutomationApi, projectId, rules, runSources])

  useEffect(() => {
    if (!projectAutomationApi || !runsLoaded) return
    let disposed = false
    let refreshing = false
    const refresh = async () => {
      if (disposed || refreshing || document.visibilityState !== 'visible') return
      refreshing = true
      try {
        await refreshRuns()
      } catch (refreshError) {
        console.error('[Wework project automation] run history refresh failed', {
          projectId,
          error: refreshError,
        })
      } finally {
        refreshing = false
      }
    }
    const interval = window.setInterval(() => void refresh(), AUTOMATION_RUN_REFRESH_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [projectAutomationApi, projectId, refreshRuns, runsLoaded])

  useEffect(() => {
    if (!projectAutomationApi || loading || error) return
    const cached = readProjectAutomationRuleCache(cacheKey, projectAutomationApi)
    projectAutomationRuleCache.set(cacheKey, {
      source: projectAutomationApi,
      rules,
      runSources,
      updatedAt: cached?.updatedAt ?? Date.now(),
    })
  }, [cacheKey, error, loading, projectAutomationApi, rules, runSources])

  const loadExecutionCatalog = useCallback(async (): Promise<AutomationExecutionCatalog> => {
    const cached = executionCatalogCache.get(cacheKey)
    if (
      cached &&
      executionCatalogSourcesMatch(cached, deviceApi, modelApi, pluginApi) &&
      Date.now() - cached.updatedAt < AUTOMATION_CACHE_FRESH_MS
    ) {
      return cached.catalog
    }
    let request = executionCatalogLoads.get(cacheKey)
    if (!request || !executionCatalogSourcesMatch(request, deviceApi, modelApi, pluginApi)) {
      const promise = fetchExecutionCatalog(deviceApi, modelApi, pluginApi)
      request = {
        deviceSource: deviceApi,
        modelSource: modelApi,
        pluginSource: pluginApi,
        promise,
      }
      executionCatalogLoads.set(cacheKey, request)
      const clearRequest = () => {
        if (executionCatalogLoads.get(cacheKey)?.promise === promise) {
          executionCatalogLoads.delete(cacheKey)
        }
      }
      void promise.then(clearRequest, clearRequest)
    }
    const catalog = await request.promise
    executionCatalogCache.set(cacheKey, {
      deviceSource: deviceApi,
      modelSource: modelApi,
      pluginSource: pluginApi,
      catalog,
      updatedAt: Date.now(),
    })
    return catalog
  }, [cacheKey, deviceApi, modelApi, pluginApi])

  const reload = useCallback(async () => {
    await load({ force: true })
  }, [load])

  const persistRule = useCallback(
    async (rule: AutomationUiRule) => {
      if (!projectAutomationApi) throw new Error('当前项目没有可用的自动化服务')
      if (!canManageAgents) throw new Error('当前账号没有管理自动化的权限')
      if (currentUserId == null) throw new Error('当前项目缺少可用的 Runtime 用户')
      if (rule.origin === 'legacy_workflow') {
        const workflowDefinition = legacyWorkflowFromAutomationRule(rule)
        const result = await projectAutomationApi.migrateWorkflow(projectId, {
          projectVersion: project.version,
          automation: automationInputFromUi(rule, currentUserId),
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
        setRunSources(current => {
          return [
            { automationId: mapped.id, ruleId: mapped.id },
            ...current.filter(
              source => source.ruleId !== rule.id && source.automationId !== mapped.id
            ),
          ]
        })
        setError('')
        return mapped
      }
      const input = automationInputFromUi(rule, currentUserId)
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
      setRunSources(current =>
        current.some(source => source.automationId === mapped.id)
          ? current
          : [{ automationId: mapped.id, ruleId: mapped.id }, ...current]
      )
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
        return persistRule({ ...rule, enabled })
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
        setRunSources(current => current.filter(source => source.ruleId !== rule.id))
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
      setRunSources(current => current.filter(source => source.ruleId !== rule.id))
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
      return persistRule(copy)
    },
    [persistRule]
  )

  return (
    <AutomationRulesView
      rules={rules}
      runs={runs}
      loading={loading}
      error={error}
      canManage={canManageAgents}
      projectTags={project.tags}
      onReload={reload}
      onLoadExecutionCatalog={loadExecutionCatalog}
      onLoadRuns={refreshRuns}
      onSaveRule={persistRule}
      onToggleRule={toggleRule}
      onDuplicateRule={duplicateRule}
      onDeleteRule={deleteRule}
    />
  )
}
