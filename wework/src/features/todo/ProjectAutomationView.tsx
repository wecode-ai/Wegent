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
import { PopupMenu } from '@/components/common/MenuSelect'
import { Tooltip } from '@/components/ui/tooltip'
import {
  createSharedWorkspaceAutomationPorts,
  EventSubscriptionPicker,
  ProjectAutomationRulesView,
} from '@wegent/collaboration/automation-ui'
import type { AutomationExecutionCatalog } from '@wegent/collaboration/automation'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { createWeworkAutomationSharedWorkspaceApi } from '@/features/collaboration'

interface ProjectAutomationViewProps {
  api?: NonNullable<WorkbenchServices['deliveryApi']>
  workspaceApi?: SharedWorkspaceApi
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
const automationUiHost = {
  useTranslation,
  PopupMenu,
  Tooltip,
  EventSubscriptionPicker,
}

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
  const { i18n, t } = useTranslation('common')
  const {
    api,
    workspaceApi,
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
  const automationWorkspaceApi = useMemo(() => {
    if (workspaceApi) return workspaceApi
    if (!api) return null
    return createWeworkAutomationSharedWorkspaceApi(
      api,
      projectAutomationApi,
      projectIncomingHookApi
    )
  }, [api, projectAutomationApi, projectIncomingHookApi, workspaceApi])
  const sharedPorts = useMemo(
    () =>
      automationWorkspaceApi
        ? createSharedWorkspaceAutomationPorts<CloudProject>(automationWorkspaceApi)
        : null,
    [automationWorkspaceApi]
  )
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

  if (!sharedPorts) return null

  return (
    <ProjectAutomationRulesView
      automationApi={sharedPorts.automationApi}
      automationCacheSource={workspaceApi ?? projectAutomationApi}
      projectApi={sharedPorts.projectApi}
      incomingHooksApi={sharedPorts.incomingHooksApi}
      locale={i18n.language}
      uiHost={automationUiHost}
      project={project}
      currentUserId={currentUserId}
      canManage={canManageAgents}
      onProjectUpdated={onProjectUpdated}
      onLoadExecutionCatalog={loadExecutionCatalog}
      onLoadExecutionPlugins={loadExecutionPlugins}
      onRunRefreshError={refreshError => {
        console.error('[Wework project automation] run history refresh failed', {
          projectId,
          error: refreshError,
        })
      }}
    />
  )
}
