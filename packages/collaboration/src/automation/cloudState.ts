import { useCallback, useEffect, useRef, useState } from 'react'
import {
  automationInputFromUi,
  automationRuleFromBackend,
  automationRuleFromLegacyWorkflow,
  automationRunFromBackend,
  legacyWorkflowFromAutomationRule,
  type AutomationUiRule,
  type AutomationUiRun,
} from './model'
import type {
  AutomationBackendInput,
  AutomationBackendRule,
  AutomationBackendRun,
  AutomationEventSourceCatalogItem,
  AutomationProject,
  ProjectWorkflowDefinition,
} from './types'

export interface AutomationCloudApi {
  list(projectId: string): Promise<AutomationBackendRule[]>
  create(projectId: string, input: AutomationBackendInput): Promise<AutomationBackendRule>
  migrateWorkflow(
    projectId: string,
    input: {
      projectVersion: number
      automation: AutomationBackendInput
      workflowDefinition: ProjectWorkflowDefinition
    }
  ): Promise<{
    automation: AutomationBackendRule
    projectVersion: number
    workflowAutomationId: string
  }>
  update(
    projectId: string,
    automationId: string,
    input: Partial<AutomationBackendInput> & { version: number }
  ): Promise<AutomationBackendRule>
  remove(
    projectId: string,
    automationId: string
  ): Promise<{ projectVersion: number; workflowAutomationId: string | null }>
  runNow(projectId: string, automationId: string): Promise<AutomationBackendRun>
  listRuns(projectId: string, automationId: string): Promise<AutomationBackendRun[]>
}

export interface AutomationProjectApi<P extends AutomationProject> {
  clearLegacyWorkflow(project: P, workflowDefinition: ProjectWorkflowDefinition): Promise<P>
}

export interface AutomationIncomingHooksApi {
  catalog(): Promise<AutomationEventSourceCatalogItem[]>
}

export interface UseAutomationCloudStateOptions<P extends AutomationProject> {
  api?: AutomationCloudApi
  cacheSource?: object
  projectApi: AutomationProjectApi<P>
  incomingHooksApi?: AutomationIncomingHooksApi
  project: P
  currentUserId?: string | number
  canManage: boolean
  legacyUpgradeRequiredMessage: string
  serviceUnavailableMessage: string
  managePermissionMessage: string
  runtimeUserRequiredMessage: string
  duplicateName: (name: string) => string
  onProjectUpdated?: (project: P) => void
  onRunRefreshError?: (error: unknown) => void
}

interface AutomationRunSource {
  automationId: string
  ruleId: string
}

interface AutomationRuleSnapshot {
  rules: AutomationUiRule[]
  runSources: AutomationRunSource[]
}

interface AutomationRuleCacheEntry extends AutomationRuleSnapshot {
  source: object
  updatedAt: number
}

interface AutomationRuleLoadRequest {
  source: object
  promise: Promise<AutomationRuleSnapshot>
}

const AUTOMATION_CACHE_FRESH_MS = 30_000
const AUTOMATION_RUN_REFRESH_MS = 15_000
const ruleCache = new Map<string, AutomationRuleCacheEntry>()
const ruleLoads = new Map<string, AutomationRuleLoadRequest>()

function readRuleCache(cacheKey: string, source: object | undefined) {
  if (!source) return null
  const cached = ruleCache.get(cacheKey)
  return cached?.source === source ? cached : null
}

function buildRuleSnapshot(
  project: AutomationProject,
  backendRules: AutomationBackendRule[]
): AutomationRuleSnapshot {
  const canonicalRule = project.workflow_automation_id
    ? backendRules.find(rule => rule.id === project.workflow_automation_id)
    : null
  const legacyRule = canonicalRule ? null : automationRuleFromLegacyWorkflow(project, backendRules)
  const runtimeDefinition = canonicalRule?.eventConfig.runtime_workflow_definition
  const internalDefinition =
    runtimeDefinition && typeof runtimeDefinition === 'object' && !Array.isArray(runtimeDefinition)
      ? (runtimeDefinition as ProjectWorkflowDefinition)
      : project.workflow_definition
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
      .map(backendRule => ({ automationId: backendRule.id, ruleId: rule.id }))
  })
  return { rules, runSources }
}

export function clearedLegacyWorkflow(
  definition: ProjectWorkflowDefinition
): ProjectWorkflowDefinition {
  return {
    version: definition.version,
    stage_mode: 'none',
    advancement_policy: 'manual',
    coordinator_prompt: '',
    approval_policy: 'required',
    ai_automation_rule_id: null,
    execution_config: null,
    nodes: [],
  }
}

async function loadRuns(
  api: AutomationCloudApi,
  projectId: string,
  runSources: AutomationRunSource[],
  rules: AutomationUiRule[]
) {
  const rulesById = new Map(rules.map(rule => [rule.id, rule]))
  const groups = await Promise.all(
    runSources.map(async source => {
      const rule = rulesById.get(source.ruleId)
      if (!rule) return []
      const backendRuns = await api.listRuns(projectId, source.automationId)
      return backendRuns.map(run => automationRunFromBackend(run, rule))
    })
  )
  return groups
    .flat()
    .sort((left, right) => Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt))
}

export function useAutomationCloudState<P extends AutomationProject>({
  api,
  cacheSource = api,
  projectApi,
  incomingHooksApi,
  project,
  currentUserId = project.current_user_id,
  canManage,
  legacyUpgradeRequiredMessage,
  serviceUnavailableMessage,
  managePermissionMessage,
  runtimeUserRequiredMessage,
  duplicateName,
  onProjectUpdated,
  onRunRefreshError,
}: UseAutomationCloudStateOptions<P>) {
  const projectId = String(project.id)
  const cacheKey = `${projectId}:${String(currentUserId ?? '')}`
  const projectRef = useRef(project)
  const onProjectUpdatedRef = useRef(onProjectUpdated)
  const initialCache = readRuleCache(cacheKey, cacheSource)
  const [rules, setRules] = useState<AutomationUiRule[]>(() => initialCache?.rules ?? [])
  const [runs, setRuns] = useState<AutomationUiRun[]>([])
  const [runSources, setRunSources] = useState<AutomationRunSource[]>(
    () => initialCache?.runSources ?? []
  )
  const [runsLoaded, setRunsLoaded] = useState(false)
  const runsRequestRef = useRef<Promise<AutomationUiRun[]> | null>(null)
  const [loading, setLoading] = useState(() => !initialCache)
  const [error, setError] = useState('')
  const [eventSourceCatalog, setEventSourceCatalog] = useState<AutomationEventSourceCatalogItem[]>(
    []
  )

  useEffect(() => {
    projectRef.current = project
  }, [project])

  useEffect(() => {
    onProjectUpdatedRef.current = onProjectUpdated
  }, [onProjectUpdated])

  const publishProject = useCallback((updatedProject: P) => {
    projectRef.current = updatedProject
    onProjectUpdatedRef.current?.(updatedProject)
  }, [])

  const load = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (!api) {
        setRules([])
        setRunSources([])
        setError(serviceUnavailableMessage)
        setLoading(false)
        return
      }
      const cached = readRuleCache(cacheKey, cacheSource)
      if (cached && !force && Date.now() - cached.updatedAt < AUTOMATION_CACHE_FRESH_MS) {
        setLoading(false)
        return
      }
      if (!cached) setLoading(true)
      try {
        let request = ruleLoads.get(cacheKey)
        if (!request || request.source !== cacheSource) {
          const loadProject = projectRef.current
          const promise = api.list(projectId).then(async backendRules => {
            const legacyRule = loadProject.workflow_automation_id
              ? null
              : automationRuleFromLegacyWorkflow(loadProject, backendRules)
            if (!legacyRule) return buildRuleSnapshot(loadProject, backendRules)
            if (!canManage || currentUserId == null) {
              throw new Error(legacyUpgradeRequiredMessage)
            }
            const workflowDefinition = legacyWorkflowFromAutomationRule(legacyRule)
            const result = await api.migrateWorkflow(projectId, {
              projectVersion: loadProject.version,
              automation: automationInputFromUi(legacyRule, currentUserId),
              workflowDefinition,
            })
            const updatedProject = {
              ...loadProject,
              workflow_automation_id: result.workflowAutomationId,
              workflow_definition: clearedLegacyWorkflow(workflowDefinition),
              version: result.projectVersion,
            }
            publishProject(updatedProject)
            return buildRuleSnapshot(updatedProject, [result.automation, ...backendRules])
          })
          request = { source: cacheSource ?? api, promise }
          ruleLoads.set(cacheKey, request)
          const clearRequest = () => {
            if (ruleLoads.get(cacheKey)?.promise === promise) ruleLoads.delete(cacheKey)
          }
          void promise.then(clearRequest, clearRequest)
        }
        const snapshot = await request.promise
        ruleCache.set(cacheKey, {
          ...snapshot,
          source: cacheSource ?? api,
          updatedAt: Date.now(),
        })
        setRules(snapshot.rules)
        setRunSources(snapshot.runSources)
        setError('')
      } catch (loadError) {
        if (!cached) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        setLoading(false)
      }
    },
    [
      api,
      cacheSource,
      cacheKey,
      canManage,
      currentUserId,
      legacyUpgradeRequiredMessage,
      projectId,
      publishProject,
      serviceUnavailableMessage,
    ]
  )

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  useEffect(() => {
    if (!incomingHooksApi) return
    let active = true
    void incomingHooksApi
      .catalog()
      .then(catalog => {
        if (active) setEventSourceCatalog(catalog)
      })
      .catch(loadError => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
    return () => {
      active = false
    }
  }, [incomingHooksApi, projectId])

  const refreshRuns = useCallback(async () => {
    if (!api) throw new Error(serviceUnavailableMessage)
    if (runsRequestRef.current) return runsRequestRef.current
    const request = loadRuns(api, projectId, runSources, rules)
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
  }, [api, projectId, rules, runSources, serviceUnavailableMessage])

  useEffect(() => {
    if (!api || !runsLoaded) return
    let disposed = false
    let refreshing = false
    const refresh = async () => {
      if (disposed || refreshing || document.visibilityState !== 'visible') return
      refreshing = true
      try {
        await refreshRuns()
      } catch (refreshError) {
        onRunRefreshError?.(refreshError)
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
  }, [api, onRunRefreshError, refreshRuns, runsLoaded])

  useEffect(() => {
    if (!api || loading || error) return
    const cached = readRuleCache(cacheKey, cacheSource)
    ruleCache.set(cacheKey, {
      source: cacheSource ?? api,
      rules,
      runSources,
      updatedAt: cached?.updatedAt ?? Date.now(),
    })
  }, [api, cacheKey, cacheSource, error, loading, rules, runSources])

  const requireManageApi = useCallback(() => {
    if (!api) throw new Error(serviceUnavailableMessage)
    if (!canManage) throw new Error(managePermissionMessage)
    return api
  }, [api, canManage, managePermissionMessage, serviceUnavailableMessage])

  const persistRule = useCallback(
    async (rule: AutomationUiRule) => {
      const cloudApi = requireManageApi()
      if (currentUserId == null) throw new Error(runtimeUserRequiredMessage)
      const currentProject = projectRef.current
      if (rule.origin === 'legacy_workflow') {
        const workflowDefinition = legacyWorkflowFromAutomationRule(rule)
        const result = await cloudApi.migrateWorkflow(projectId, {
          projectVersion: currentProject.version,
          automation: automationInputFromUi(rule, currentUserId),
          workflowDefinition,
        })
        publishProject({
          ...currentProject,
          workflow_automation_id: result.workflowAutomationId,
          workflow_definition: clearedLegacyWorkflow(workflowDefinition),
          version: result.projectVersion,
        })
        const mapped = automationRuleFromBackend(result.automation)
        setRules(current =>
          current.map(candidate => (candidate.id === rule.id ? mapped : candidate))
        )
        setRunSources(current => [
          { automationId: mapped.id, ruleId: mapped.id },
          ...current.filter(
            source => source.ruleId !== rule.id && source.automationId !== mapped.id
          ),
        ])
        setError('')
        return mapped
      }
      const input = automationInputFromUi(rule, currentUserId)
      const saved = rule.persisted
        ? await cloudApi.update(projectId, rule.id, { ...input, version: rule.version })
        : await cloudApi.create(projectId, input)
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
    [currentUserId, projectId, publishProject, requireManageApi, runtimeUserRequiredMessage]
  )

  const toggleRule = useCallback(
    async (rule: AutomationUiRule, enabled: boolean) => {
      const cloudApi = requireManageApi()
      if (rule.origin === 'legacy_workflow') return persistRule({ ...rule, enabled })
      const mapped = automationRuleFromBackend(
        await cloudApi.update(projectId, rule.id, { version: rule.version, enabled })
      )
      setRules(current =>
        current.map(candidate => (candidate.id === mapped.id ? mapped : candidate))
      )
      return mapped
    },
    [persistRule, projectId, requireManageApi]
  )

  const deleteRule = useCallback(
    async (rule: AutomationUiRule) => {
      const cloudApi = requireManageApi()
      const currentProject = projectRef.current
      if (rule.origin === 'legacy_workflow') {
        publishProject(
          await projectApi.clearLegacyWorkflow(
            currentProject,
            currentProject.workflow_definition ?? {
              version: 1,
              nodes: [],
            }
          )
        )
      } else {
        const result = await cloudApi.remove(projectId, rule.id)
        if (currentProject.workflow_automation_id === rule.id) {
          publishProject({
            ...currentProject,
            workflow_automation_id: result.workflowAutomationId,
            version: result.projectVersion,
          })
        }
      }
      setRules(current => current.filter(candidate => candidate.id !== rule.id))
      setRuns(current => current.filter(run => run.ruleId !== rule.id))
      setRunSources(current => current.filter(source => source.ruleId !== rule.id))
    },
    [projectApi, projectId, publishProject, requireManageApi]
  )

  const duplicateRule = useCallback(
    (rule: AutomationUiRule) =>
      persistRule({
        ...rule,
        id: `draft-${crypto.randomUUID()}`,
        persisted: false,
        origin: 'automation',
        legacyDefinition: null,
        version: 1,
        name: duplicateName(rule.name),
        enabled: false,
      }),
    [duplicateName, persistRule]
  )

  const runRule = useCallback(
    async (rule: AutomationUiRule) => {
      if (!api) throw new Error(serviceUnavailableMessage)
      const run = await api.runNow(projectId, rule.id)
      setRuns(current => [
        automationRunFromBackend(run, rule),
        ...current.filter(item => item.id !== run.id),
      ])
    },
    [api, projectId, serviceUnavailableMessage]
  )

  return {
    rules,
    runs,
    loading,
    error,
    eventSourceCatalog,
    reload: () => load({ force: true }),
    refreshRuns,
    persistRule,
    toggleRule,
    duplicateRule,
    deleteRule,
    runRule: api ? runRule : undefined,
  }
}
