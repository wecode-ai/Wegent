import '@xyflow/react/dist/style.css'

import { useCallback, useMemo } from 'react'
import type { CloudLoopItem, CloudProject, CloudProjectMember } from '@/api/deliveries'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { ExecutionListApi } from '@/features/todo/ProjectQueueView'
import { modelSelectionIdentityOptions } from '@/features/workbench/runtimeModelSelection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type {
  CloneGitRepositoryInput,
  CreatedRuntimeProject,
  ProjectWithTasks,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import { getLocalExecutorStatus } from '@/desktop/localExecutor'
import { isCurrentAppDevice } from '@/lib/app-device-registration'
import { getDefaultModelOptions, getModelDisplayLabel } from '@/lib/model-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { AutomationRulesView } from './AutomationRulesView.jsx'
import {
  useAutomationCloudState,
  type AutomationExecutionCatalog,
} from '../../../../packages/collaboration/src/automation'

interface ProjectAutomationViewProps {
  api: NonNullable<WorkbenchServices['deliveryApi']>
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  projectAutomationApi?: WorkbenchServices['projectAutomationApi']
  projectIncomingHookApi?: ReturnType<typeof createProjectIncomingHookApi>
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

interface ExecutionCatalogCacheEntry {
  deviceSource: object | undefined
  modelSource: object | undefined
  catalog: AutomationExecutionCatalog
  updatedAt: number
}

interface ExecutionCatalogLoadRequest {
  deviceSource: object | undefined
  modelSource: object | undefined
  promise: Promise<AutomationExecutionCatalog>
}

interface ExecutionPluginCacheEntry {
  pluginSource: object | undefined
  deviceIds: string
  plugins: AutomationExecutionCatalog['plugins']
  updatedAt: number
}

interface ExecutionPluginLoadRequest {
  pluginSource: object | undefined
  deviceIds: string
  promise: Promise<AutomationExecutionCatalog['plugins']>
}

const AUTOMATION_CACHE_FRESH_MS = 30_000
const executionCatalogCache = new Map<string, ExecutionCatalogCacheEntry>()
const executionCatalogLoads = new Map<string, ExecutionCatalogLoadRequest>()
const executionPluginCache = new Map<string, ExecutionPluginCacheEntry>()
const executionPluginLoads = new Map<string, ExecutionPluginLoadRequest>()

function executionCatalogSourcesMatch(
  entry: {
    deviceSource: object | undefined
    modelSource: object | undefined
  },
  deviceSource: object | undefined,
  modelSource: object | undefined
): boolean {
  return entry.deviceSource === deviceSource && entry.modelSource === modelSource
}

async function fetchExecutionCatalog(
  deviceApi: WorkbenchServices['deviceApi'] | undefined,
  modelApi: WorkbenchServices['modelApi'] | undefined,
  unknownDeviceLabel: string
): Promise<AutomationExecutionCatalog> {
  const [devices, modelResponse, localStatus] = await Promise.all([
    deviceApi?.listDevices() ?? Promise.resolve([]),
    modelApi?.listModels() ?? Promise.resolve({ data: [] }),
    getLocalExecutorStatus().catch(() => null),
  ])
  const localDeviceIds = localStatus?.deviceId?.trim() ? [localStatus.deviceId.trim()] : []
  const availableDevices = devices.filter(device => device.status !== 'offline')
  return {
    environments: availableDevices.map(device => {
      const local = isCurrentAppDevice(device, localDeviceIds)
      return {
        deviceId: device.device_id,
        label: local ? '本机' : device.name?.trim() || unknownDeviceLabel,
        executionEnvironment: local ? 'local' : 'cloud',
      }
    }),
    models: modelResponse.data
      .filter(model => model.isActive !== false && !model.compatibilityDisabled)
      .map(model => modelCatalogEntry(model)),
    plugins: [],
  }
}

function modelCatalogEntry(model: UnifiedModel) {
  const configOptions = Object.fromEntries(
    Object.entries(model.config ?? {}).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : []
    )
  )
  return {
    name: model.name,
    label: getModelDisplayLabel(model),
    type: model.type,
    options: {
      ...configOptions,
      ...getDefaultModelOptions(model),
      ...modelSelectionIdentityOptions(model),
    },
  }
}

async function fetchExecutionPlugins(
  pluginApi: WorkbenchServices['pluginApi'] | undefined,
  deviceIds: string[]
): Promise<AutomationExecutionCatalog['plugins']> {
  if (!pluginApi || deviceIds.length === 0) return []
  const pluginGroups = await Promise.all(deviceIds.map(deviceId => pluginApi.listPlugins(deviceId)))
  return Array.from(
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
}

export function ProjectAutomationView(props: ProjectAutomationViewProps) {
  const { t } = useTranslation('common')
  const {
    api,
    project,
    projectAutomationApi,
    projectIncomingHookApi,
    deviceApi,
    modelApi,
    pluginApi,
    currentUserId = project.current_user_id,
    canManageAgents,
    onProjectUpdated,
  } = props
  const projectId = String(project.id)
  const cacheKey = `${projectId}:${String(currentUserId ?? '')}`
  const cloudApi = useMemo(
    () =>
      projectAutomationApi
        ? {
            list: (targetProjectId: string) => projectAutomationApi.list(targetProjectId),
            create: (
              targetProjectId: string,
              input: Parameters<typeof projectAutomationApi.create>[1]
            ) => projectAutomationApi.create(targetProjectId, input),
            migrateWorkflow: (
              targetProjectId: string,
              input: Parameters<typeof projectAutomationApi.migrateWorkflow>[1]
            ) => projectAutomationApi.migrateWorkflow(targetProjectId, input),
            update: (
              targetProjectId: string,
              automationId: string,
              input: Parameters<typeof projectAutomationApi.update>[2]
            ) => projectAutomationApi.update(targetProjectId, automationId, input),
            remove: (targetProjectId: string, automationId: string) =>
              projectAutomationApi.delete(targetProjectId, automationId),
            runNow: (targetProjectId: string, automationId: string) =>
              projectAutomationApi.runNow(targetProjectId, automationId),
            listRuns: (targetProjectId: string, automationId: string) =>
              projectAutomationApi.listRuns(targetProjectId, automationId),
          }
        : undefined,
    [projectAutomationApi]
  )
  const projectApi = useMemo(
    () => ({
      clearLegacyWorkflow: (currentProject: CloudProject) =>
        api.updateCloudProject(currentProject.id, {
          version: currentProject.version,
          workflow_definition: {
            version: Math.max(1, currentProject.workflow_definition?.version ?? 1),
            stage_mode: 'none',
            advancement_policy: 'manual',
            coordinator_prompt: '',
            approval_policy: 'required',
            ai_automation_rule_id: null,
            execution_config: null,
            nodes: [],
          },
        }),
    }),
    [api]
  )
  const automation = useAutomationCloudState<CloudProject>({
    api: cloudApi,
    cacheSource: projectAutomationApi,
    projectApi,
    incomingHooksApi: projectIncomingHookApi,
    project,
    currentUserId,
    canManage: canManageAgents,
    legacyUpgradeRequiredMessage: t(
      'cloud_project.legacy_workflow_upgrade_required',
      '旧版 Issue 编排需要由项目管理员完成自动升级'
    ),
    serviceUnavailableMessage: '当前项目没有可用的自动化服务',
    managePermissionMessage: '当前账号没有管理自动化的权限',
    runtimeUserRequiredMessage: '当前项目缺少可用的 Runtime 用户',
    duplicateName: name => `${name} 副本`,
    onProjectUpdated,
    onRunRefreshError: refreshError => {
      console.error('[Wework project automation] run history refresh failed', {
        projectId,
        error: refreshError,
      })
    },
  })

  const loadExecutionCatalog = useCallback(async (): Promise<AutomationExecutionCatalog> => {
    const cached = executionCatalogCache.get(cacheKey)
    if (
      cached &&
      executionCatalogSourcesMatch(cached, deviceApi, modelApi) &&
      Date.now() - cached.updatedAt < AUTOMATION_CACHE_FRESH_MS
    ) {
      return cached.catalog
    }
    let request = executionCatalogLoads.get(cacheKey)
    if (!request || !executionCatalogSourcesMatch(request, deviceApi, modelApi)) {
      const promise = fetchExecutionCatalog(
        deviceApi,
        modelApi,
        t('workbench.environment_device_unknown', '未知设备')
      )
      request = {
        deviceSource: deviceApi,
        modelSource: modelApi,
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
      catalog,
      updatedAt: Date.now(),
    })
    return catalog
  }, [cacheKey, deviceApi, modelApi, t])

  const loadExecutionPlugins = useCallback(async (): Promise<
    AutomationExecutionCatalog['plugins']
  > => {
    const catalog = await loadExecutionCatalog()
    const deviceIds = catalog.environments.map(environment => environment.deviceId)
    const deviceKey = deviceIds.join('\n')
    const cached = executionPluginCache.get(cacheKey)
    if (
      cached &&
      cached.pluginSource === pluginApi &&
      cached.deviceIds === deviceKey &&
      Date.now() - cached.updatedAt < AUTOMATION_CACHE_FRESH_MS
    ) {
      return cached.plugins
    }
    let request = executionPluginLoads.get(cacheKey)
    if (!request || request.pluginSource !== pluginApi || request.deviceIds !== deviceKey) {
      const promise = fetchExecutionPlugins(pluginApi, deviceIds)
      request = {
        pluginSource: pluginApi,
        deviceIds: deviceKey,
        promise,
      }
      executionPluginLoads.set(cacheKey, request)
      const clearRequest = () => {
        if (executionPluginLoads.get(cacheKey)?.promise === promise) {
          executionPluginLoads.delete(cacheKey)
        }
      }
      void promise.then(clearRequest, clearRequest)
    }
    const plugins = await request.promise
    executionPluginCache.set(cacheKey, {
      pluginSource: pluginApi,
      deviceIds: deviceKey,
      plugins,
      updatedAt: Date.now(),
    })
    return plugins
  }, [cacheKey, loadExecutionCatalog, pluginApi])

  return (
    <AutomationRulesView
      rules={automation.rules}
      runs={automation.runs}
      loading={automation.loading}
      error={automation.error}
      canManage={canManageAgents}
      projectTags={project.tags}
      eventSourceCatalog={automation.eventSourceCatalog}
      projectIncomingHookApi={projectIncomingHookApi}
      projectId={projectId}
      project={project}
      onReload={automation.reload}
      onLoadExecutionCatalog={loadExecutionCatalog}
      onLoadExecutionPlugins={loadExecutionPlugins}
      onLoadRuns={automation.refreshRuns}
      onRunRule={automation.runRule}
      onSaveRule={automation.persistRule}
      onToggleRule={automation.toggleRule}
      onDuplicateRule={automation.duplicateRule}
      onDeleteRule={automation.deleteRule}
    />
  )
}
