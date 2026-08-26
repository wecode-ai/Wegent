import {
  Bot,
  Check,
  ChevronDown,
  Code2,
  ListChecks,
  Plug,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import { projectChatAgentWorkspaceBinding, type ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import type {
  CloneGitRepositoryInput,
  CreatedRuntimeProject,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeProjectPluginRef,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { MenuSelect } from '@/components/common/MenuSelect'
import { StandaloneFolderProjectDialog } from '@/components/projects/StandaloneProjectDialogs'
import { SectionTitle, SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { ModelOptions, ModelType, UnifiedModel } from '@/types/api'
import type { Team } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'

interface ProjectChatAgentTemplate {
  name: string
  capabilityDescription: string
  systemPrompt: string
}

type RuntimeConfigurationMode = 'template' | 'custom'

function deviceMatchesEnvironment(
  device: { device_type?: string },
  environment: ProjectChatAgent['executionEnvironment']
) {
  return environment === 'local'
    ? device.device_type === 'local' || device.device_type === 'app'
    : device.device_type === 'cloud' || device.device_type === 'remote'
}

function executionEnvironmentForDevice(device: { device_type?: string } | undefined) {
  return device?.device_type === 'cloud' || device?.device_type === 'remote' ? 'cloud' : 'local'
}

function executionDeviceLabel(device: { device_id: string; name?: string }) {
  const name = device.name?.trim()
  return name && name !== device.device_id ? `${name} · ${device.device_id}` : device.device_id
}

function modelSelectionKey(modelName: string, modelType: ModelType | null | undefined) {
  return `${modelType ?? ''}:${modelName}`
}

function resolveExecutionDevice(
  current: string,
  devices: Array<{
    device_id: string
    device_type?: string
    status?: string
    is_default?: boolean
  }>,
  environment?: ProjectChatAgent['executionEnvironment']
) {
  const matchingDevices = devices.filter(
    device =>
      ['online', 'busy'].includes(device.status ?? '') &&
      (!environment || deviceMatchesEnvironment(device, environment))
  )
  if (matchingDevices.some(device => device.device_id === current)) return current
  const preferredDevice =
    matchingDevices.find(device => device.status === 'online' && device.is_default) ??
    matchingDevices.find(device => device.status === 'online') ??
    matchingDevices.find(device => device.status === 'busy' && device.is_default) ??
    matchingDevices.find(device => device.status === 'busy') ??
    matchingDevices.find(device => device.is_default) ??
    matchingDevices[0]
  return preferredDevice?.device_id ?? ''
}

const templateButtonClass =
  'flex min-h-20 items-center gap-3.5 rounded-xl border border-border bg-background p-4 text-left transition hover:border-text-tertiary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30'

export function ProjectChatAgentsSection({
  project,
  projectChatAgentApi,
  deviceApi,
  modelApi,
  teamApi,
  pluginApi,
  localProjects = [],
  runtimeWork,
  runtimeProfiles = [],
  onCreateLocalCodeProject,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  canManage,
  createRequestKey = 0,
  onAgentsChange,
  onAgentCreated,
  onCreateCancelled,
}: {
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
  teamApi?: WorkbenchServices['teamApi']
  pluginApi?: WorkbenchServices['pluginApi']
  localProjects?: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeProfiles?: RuntimeProfile[]
  onCreateLocalCodeProject?: (data: {
    deviceId: string
    name: string
    roots: string[]
  }) => Promise<CreatedRuntimeProject>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  canManage: boolean
  createRequestKey?: number
  onAgentsChange?: (agents: ProjectChatAgent[]) => void
  onAgentCreated?: (agent: ProjectChatAgent) => void
  onCreateCancelled?: () => void
}) {
  const { t } = useTranslation('common')
  // Local project spaces keep their data on this device, so their robots can
  // only execute on local-capable devices (the local executor or a companion
  // app). A cloud-bound robot would sit in the queue forever because the local
  // store only claims local-environment runs.
  const localProjectOnly = project.project_store === 'local'
  const [chatAgents, setChatAgents] = useState<ProjectChatAgent[]>([])
  const [agentBusy, setAgentBusy] = useState(false)
  const [creatingChatAgent, setCreatingChatAgent] = useState(false)
  const [workflowCreateMode, setWorkflowCreateMode] = useState(false)
  const [showAdvancedAgentFields, setShowAdvancedAgentFields] = useState(false)
  const [editingChatAgent, setEditingChatAgent] = useState<ProjectChatAgent | null>(null)
  const [agentName, setAgentName] = useState('')
  const [agentModel, setAgentModel] = useState('')
  const [agentModelType, setAgentModelType] = useState<ModelType | null>(null)
  const [agentModelOptions, setAgentModelOptions] = useState<ModelOptions>({})
  const [agentSystemPrompt, setAgentSystemPrompt] = useState('')
  const [agentCapabilityDescription, setAgentCapabilityDescription] = useState('')
  const [agentVisibility, setAgentVisibility] =
    useState<ProjectChatAgent['visibility']>('creator_admin')
  const [agentExecutionEnvironment, setAgentExecutionEnvironment] =
    useState<ProjectChatAgent['executionEnvironment']>('local')
  const [agentRuntime, setAgentRuntime] = useState<ProjectChatAgent['runtime']>('codex')
  const [agentWegentTeamId, setAgentWegentTeamId] = useState<number | ''>('')
  const [agentExecutionMode, setAgentExecutionMode] =
    useState<ProjectChatAgent['executionMode']>('auto')
  const [agentMaxConcurrentExecutions, setAgentMaxConcurrentExecutions] = useState(1)
  const [agentWorkspacePolicy, setAgentWorkspacePolicy] =
    useState<ProjectChatAgent['workspacePolicy']>('project')
  const [workspaceGitCheck, setWorkspaceGitCheck] = useState<{
    key: string
    available: boolean
  } | null>(null)
  const [agentRuntimeConfigurationMode, setAgentRuntimeConfigurationMode] =
    useState<RuntimeConfigurationMode>('custom')
  const [agentRuntimeProfileId, setAgentRuntimeProfileId] = useState('')
  const [agentExecutionDeviceId, setAgentExecutionDeviceId] = useState<string>('')
  const [agentLocalProjectId, setAgentLocalProjectId] = useState<number | ''>('')
  const [agentDeviceWorkspaceId, setAgentDeviceWorkspaceId] = useState<number | ''>('')
  const [availableDevices, setAvailableDevices] = useState<DeviceInfo[]>([])
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const [availableTeams, setAvailableTeams] = useState<Team[]>([])
  const [pluginCatalog, setPluginCatalog] = useState<{
    deviceId: string
    plugins: RuntimeProjectPluginRef[]
  } | null>(null)
  const [agentPlugins, setAgentPlugins] = useState<RuntimeProjectPluginRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [agentSaveAttempted, setAgentSaveAttempted] = useState(false)
  const [createCodeProjectOpen, setCreateCodeProjectOpen] = useState(false)
  const [createdCodeProjects, setCreatedCodeProjects] = useState<ProjectWithTasks[]>([])
  const [createdRuntimeProjectKeys, setCreatedRuntimeProjectKeys] = useState<
    Record<number, string>
  >({})
  const handledCreateRequestKey = useRef(0)
  const collectionRevision = useRef(0)
  const agentExecutionEnvironmentRef = useRef(agentExecutionEnvironment)

  useEffect(() => {
    if (!projectChatAgentApi) return
    let active = true
    const requestedAtRevision = collectionRevision.current
    void projectChatAgentApi
      .list(project.id)
      .then(agents => {
        if (!active || requestedAtRevision !== collectionRevision.current) return
        setChatAgents(agents)
        onAgentsChange?.(agents)
      })
      .catch(
        cause =>
          active &&
          setError(
            cause instanceof Error ? cause.message : t('workbench.project_chat_agents_load_failed')
          )
      )
    return () => {
      active = false
    }
  }, [onAgentsChange, project.id, projectChatAgentApi, t])

  useEffect(() => {
    if (!deviceApi?.listDevices) return
    let active = true
    deviceApi
      .listDevices()
      .then(devices => {
        if (!active) return
        setAvailableDevices(devices)
        setAgentExecutionDeviceId(current => {
          const selectedDeviceId = resolveExecutionDevice(
            current,
            devices,
            localProjectOnly ? 'local' : undefined
          )
          const environment = executionEnvironmentForDevice(
            devices.find(device => device.device_id === selectedDeviceId)
          )
          setAgentExecutionEnvironment(environment)
          agentExecutionEnvironmentRef.current = environment
          return selectedDeviceId
        })
      })
      .catch(() => {
        if (active) setAvailableDevices([])
      })
    return () => {
      active = false
    }
  }, [deviceApi, localProjectOnly])

  useEffect(() => {
    if (!modelApi) return
    let active = true
    void modelApi
      .listModels()
      .then(response => {
        if (active) setAvailableModels(response.data.filter(isSupportedModelFamily))
      })
      .catch(() => {
        // Robots must declare a model. When the list is unavailable the form
        // keeps the currently configured model editable, but creating a new
        // robot stays blocked until a model can be selected.
        if (active) setAvailableModels([])
      })
    return () => {
      active = false
    }
  }, [modelApi])

  useEffect(() => {
    if (!teamApi) return
    let active = true
    void teamApi
      .listTeams()
      .then(teams => active && setAvailableTeams(teams.filter(team => team.is_active !== false)))
      .catch(() => active && setAvailableTeams([]))
    return () => {
      active = false
    }
  }, [teamApi])

  const activeChatAgents = chatAgents.filter(agent => agent.status === 'active')
  const selectedRuntimeProfile = runtimeProfiles.find(
    profile => profile.id === agentRuntimeProfileId
  )
  const effectiveExecutionEnvironment =
    agentRuntimeConfigurationMode === 'template' && selectedRuntimeProfile
      ? selectedRuntimeProfile.executionEnvironment
      : agentExecutionEnvironment
  const effectiveExecutionDeviceId =
    agentRuntimeConfigurationMode === 'template' && selectedRuntimeProfile
      ? selectedRuntimeProfile.executionDeviceId
      : agentExecutionDeviceId

  useEffect(() => {
    if (!pluginApi || !effectiveExecutionDeviceId) return
    let active = true
    void pluginApi
      .listPlugins(effectiveExecutionDeviceId)
      .then(plugins => {
        if (!active) return
        setPluginCatalog({ deviceId: effectiveExecutionDeviceId, plugins })
      })
      .catch(() => {
        if (active) setPluginCatalog({ deviceId: effectiveExecutionDeviceId, plugins: [] })
      })
    return () => {
      active = false
    }
  }, [effectiveExecutionDeviceId, pluginApi])
  // Runtime-catalog models are discovered on the local device, so a robot
  // bound to cloud execution cannot use them.
  const environmentModels =
    effectiveExecutionEnvironment === 'cloud'
      ? availableModels.filter(model => model.type !== 'runtime')
      : availableModels
  const connectedDevices = availableDevices.filter(device =>
    ['online', 'busy'].includes(device.status ?? '')
  )
  const availablePlugins =
    pluginCatalog?.deviceId === effectiveExecutionDeviceId ? pluginCatalog.plugins : []
  const pluginsLoading = Boolean(
    pluginApi &&
    effectiveExecutionDeviceId &&
    pluginCatalog?.deviceId !== effectiveExecutionDeviceId
  )
  const visiblePlugins = Array.from(
    new Map([...agentPlugins, ...availablePlugins].map(plugin => [plugin.id, plugin])).values()
  )
  const visibleRuntimeProfiles = runtimeProfiles.filter(
    profile =>
      (!localProjectOnly || profile.executionEnvironment === 'local') &&
      connectedDevices.some(device => device.device_id === profile.executionDeviceId)
  )
  const executionDevices = connectedDevices.filter(
    device => !localProjectOnly || deviceMatchesEnvironment(device, 'local')
  )
  // A cloud robot can only bind a code project that already has an available
  // workspace on the selected cloud device. The runtime work registry is the
  // same source the device management page uses.
  const bindableCloudProjects = (runtimeWork?.projects ?? []).filter(projectWork =>
    projectWork.deviceWorkspaces.some(
      workspace => workspace.deviceId === effectiveExecutionDeviceId && workspace.available
    )
  )
  const availableLocalProjects = Array.from(
    new Map([...localProjects, ...createdCodeProjects].map(item => [item.id, item])).values()
  )
  const executionProjectOptions =
    effectiveExecutionEnvironment === 'cloud'
      ? bindableCloudProjects.map(projectWork => ({
          value: String(runtimeProjectUiId(projectWork.project)),
          label: projectWork.project.name,
        }))
      : availableLocalProjects.map(localProject => ({
          value: String(localProject.id),
          label: localProject.name,
        }))
  const currentExecutionProject = agentLocalProjectId === '' ? '' : String(agentLocalProjectId)
  const selectedRuntimeProjectWork = (runtimeWork?.projects ?? []).find(
    projectWork => runtimeProjectUiId(projectWork.project) === agentLocalProjectId
  )
  const cloudWorkspaceCandidates = (selectedRuntimeProjectWork?.deviceWorkspaces ?? []).filter(
    workspace => workspace.deviceId === effectiveExecutionDeviceId && workspace.available
  )
  const selectedRuntimeProjectKey =
    agentLocalProjectId === ''
      ? ''
      : (createdRuntimeProjectKeys[agentLocalProjectId] ??
        selectedRuntimeProjectWork?.project.key ??
        '')
  const selectedLocalProject = availableLocalProjects.find(item => item.id === agentLocalProjectId)
  const selectedBackendWorkspace = cloudWorkspaceCandidates.find(
    workspace =>
      workspace.id != null &&
      workspace.projectId != null &&
      workspace.projectId === agentLocalProjectId
  )
  const selectedProjectUsesDeviceBinding =
    agentLocalProjectId !== '' &&
    selectedRuntimeProjectKey !== '' &&
    selectedLocalProject?.client_origin !== 'wework' &&
    !selectedBackendWorkspace
  const resolvedAgentDeviceWorkspaceId =
    effectiveExecutionEnvironment === 'cloud' &&
    agentLocalProjectId !== '' &&
    !selectedProjectUsesDeviceBinding
      ? cloudWorkspaceCandidates.some(workspace => workspace.id === agentDeviceWorkspaceId)
        ? agentDeviceWorkspaceId
        : (cloudWorkspaceCandidates[0]?.id ?? '')
      : ''
  if (
    currentExecutionProject &&
    !executionProjectOptions.some(option => option.value === currentExecutionProject)
  ) {
    const knownName =
      availableLocalProjects.find(
        localProject => String(localProject.id) === currentExecutionProject
      )?.name ??
      (runtimeWork?.projects ?? []).find(
        projectWork => String(runtimeProjectUiId(projectWork.project)) === currentExecutionProject
      )?.project.name
    executionProjectOptions.unshift({
      value: currentExecutionProject,
      label: knownName ?? currentExecutionProject,
    })
  }
  const selectedRuntimeWorkspace =
    effectiveExecutionEnvironment === 'cloud'
      ? selectedProjectUsesDeviceBinding
        ? cloudWorkspaceCandidates[0]
        : selectedRuntimeProjectWork?.deviceWorkspaces.find(
            workspace => workspace.id === resolvedAgentDeviceWorkspaceId && workspace.available
          )
      : selectedRuntimeProjectWork?.deviceWorkspaces.find(
          workspace => workspace.deviceId === effectiveExecutionDeviceId && workspace.available
        )
  const selectedLocalProjectDeviceId = selectedLocalProject?.config?.device_id?.trim()
  const selectedLocalProjectPath =
    !selectedLocalProjectDeviceId || selectedLocalProjectDeviceId === effectiveExecutionDeviceId
      ? (selectedLocalProject?.config?.path?.trim() ??
        selectedLocalProject?.config?.workspace?.localPath?.trim())
      : undefined
  const boundWorkspacePath =
    selectedRuntimeWorkspace?.workspacePath.trim() || selectedLocalProjectPath || null
  const workspaceGitCheckKey =
    agentRuntime === 'codex' &&
    agentRuntimeConfigurationMode === 'custom' &&
    agentLocalProjectId !== '' &&
    effectiveExecutionDeviceId &&
    boundWorkspacePath &&
    deviceApi
      ? `${effectiveExecutionDeviceId}:${boundWorkspacePath}`
      : null
  const boundWorkspaceGitAvailable = workspaceGitCheckKey
    ? workspaceGitCheck?.key === workspaceGitCheckKey
      ? workspaceGitCheck.available
      : null
    : false

  useEffect(() => {
    if (!workspaceGitCheckKey || !boundWorkspacePath || !deviceApi) return
    let active = true
    void deviceApi
      .executeCommand(effectiveExecutionDeviceId, {
        command_key: 'git_is_worktree',
        args: [boundWorkspacePath],
        timeout_seconds: 15,
        max_output_bytes: 4096,
      })
      .then(result => {
        if (!active) return
        const output = Array.isArray(result.stdout)
          ? result.stdout.join('\n')
          : typeof result.stdout === 'string'
            ? result.stdout
            : ''
        const available = result.success && output.trim() === 'true'
        setWorkspaceGitCheck({ key: workspaceGitCheckKey, available })
        if (!available) setAgentWorkspacePolicy('project')
      })
      .catch(() => {
        if (!active) return
        setWorkspaceGitCheck({ key: workspaceGitCheckKey, available: false })
        setAgentWorkspacePolicy('project')
      })
    return () => {
      active = false
    }
  }, [boundWorkspacePath, deviceApi, effectiveExecutionDeviceId, workspaceGitCheckKey])

  const openCreateChatAgent = useCallback(
    (template?: ProjectChatAgentTemplate, options?: { workflow?: boolean }) => {
      setAgentSaveAttempted(false)
      setCreatingChatAgent(true)
      setWorkflowCreateMode(Boolean(options?.workflow))
      setShowAdvancedAgentFields(false)
      setEditingChatAgent(null)
      setAgentName(template?.name ?? t('workbench.project_chat_new_agent'))
      setAgentModel('')
      setAgentModelType(null)
      setAgentModelOptions({})
      setAgentSystemPrompt(template?.systemPrompt ?? '')
      setAgentCapabilityDescription(template?.capabilityDescription ?? '')
      setAgentVisibility('creator_admin')
      setAgentExecutionEnvironment('local')
      agentExecutionEnvironmentRef.current = 'local'
      setAgentRuntime('codex')
      setAgentWegentTeamId('')
      setAgentExecutionMode('auto')
      setAgentMaxConcurrentExecutions(1)
      setAgentWorkspacePolicy('project')
      setAgentRuntimeConfigurationMode('custom')
      setAgentRuntimeProfileId('')
      const executionDeviceId = resolveExecutionDevice(
        '',
        availableDevices,
        localProjectOnly ? 'local' : undefined
      )
      const executionEnvironment = executionEnvironmentForDevice(
        availableDevices.find(device => device.device_id === executionDeviceId)
      )
      setAgentExecutionEnvironment(executionEnvironment)
      agentExecutionEnvironmentRef.current = executionEnvironment
      setAgentExecutionDeviceId(executionDeviceId)
      setAgentLocalProjectId('')
      setAgentDeviceWorkspaceId('')
      setAgentPlugins([])
    },
    [
      availableDevices,
      localProjectOnly,
      setAgentDeviceWorkspaceId,
      setAgentLocalProjectId,
      setAgentWorkspacePolicy,
      t,
    ]
  )

  useEffect(() => {
    if (createRequestKey <= handledCreateRequestKey.current) return
    handledCreateRequestKey.current = createRequestKey
    openCreateChatAgent(undefined, { workflow: true })
  }, [createRequestKey, openCreateChatAgent])

  async function archiveChatAgent(agent: ProjectChatAgent) {
    if (agentBusy || !projectChatAgentApi) return
    setAgentBusy(true)
    try {
      const updated = await projectChatAgentApi.update(project.id, agent.id, {
        version: agent.version,
        status: 'archived',
      })
      const nextAgents = chatAgents.map(item => (item.id === updated.id ? updated : item))
      collectionRevision.current += 1
      setChatAgents(nextAgents)
      onAgentsChange?.(nextAgents)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_chat_agents_save_failed')
      )
    } finally {
      setAgentBusy(false)
    }
  }

  function editChatAgent(agent: ProjectChatAgent) {
    setAgentSaveAttempted(false)
    setWorkflowCreateMode(false)
    setShowAdvancedAgentFields(true)
    setEditingChatAgent(agent)
    setAgentName(agent.name)
    setAgentModel(agent.model ?? '')
    setAgentModelType(agent.modelType ?? null)
    setAgentModelOptions(agent.modelOptions ?? {})
    setAgentSystemPrompt(agent.systemPrompt)
    setAgentCapabilityDescription(agent.capabilityDescription ?? '')
    setAgentVisibility(agent.visibility)
    const executionEnvironment = localProjectOnly ? 'local' : agent.executionEnvironment
    setAgentExecutionEnvironment(executionEnvironment)
    agentExecutionEnvironmentRef.current = executionEnvironment
    setAgentRuntime(agent.runtime)
    setAgentWegentTeamId(agent.wegentTeamId ?? '')
    setAgentExecutionMode(agent.executionMode)
    setAgentMaxConcurrentExecutions(agent.maxConcurrentExecutions)
    setAgentWorkspacePolicy(agent.workspacePolicy ?? 'project')
    setAgentRuntimeConfigurationMode(agent.defaultRuntimeProfileId ? 'template' : 'custom')
    setAgentRuntimeProfileId(agent.defaultRuntimeProfileId ?? '')
    setAgentPlugins(agent.plugins ?? [])
    const binding = projectChatAgentWorkspaceBinding(agent)
    const deviceRuntimeProject =
      binding.type === 'device_project'
        ? (runtimeWork?.projects ?? []).find(
            projectWork =>
              projectWork.project.key === binding.runtimeProjectKey &&
              projectWork.deviceWorkspaces.some(
                workspace => workspace.deviceId === binding.deviceId && workspace.available
              )
          )
        : undefined
    setAgentLocalProjectId(
      binding.type === 'backend_project' || binding.type === 'legacy_project'
        ? binding.projectId
        : deviceRuntimeProject
          ? runtimeProjectUiId(deviceRuntimeProject.project)
          : ''
    )
    setAgentDeviceWorkspaceId(
      binding.type === 'backend_project' && binding.deviceWorkspaceId
        ? binding.deviceWorkspaceId
        : ''
    )
    const boundDevice = agent.executionDeviceId ?? ''
    setAgentExecutionDeviceId(
      resolveExecutionDevice(boundDevice, availableDevices, executionEnvironment)
    )
  }

  async function saveChatAgent() {
    if (
      agentBusy ||
      !projectChatAgentApi ||
      !agentName.trim() ||
      (!creatingChatAgent && !editingChatAgent)
    )
      return
    setAgentSaveAttempted(true)
    setError(null)
    if (
      (agentRuntime === 'codex' &&
        (agentRuntimeConfigurationMode === 'template'
          ? !selectedRuntimeProfile
          : !agentExecutionDeviceId)) ||
      (agentRuntime === 'wegent' && agentWegentTeamId === '')
    )
      return
    if (
      agentRuntime === 'codex' &&
      agentRuntimeConfigurationMode === 'custom' &&
      effectiveExecutionEnvironment === 'cloud' &&
      agentLocalProjectId !== '' &&
      !selectedProjectUsesDeviceBinding &&
      resolvedAgentDeviceWorkspaceId === ''
    )
      return
    setAgentBusy(true)
    try {
      if (
        agentRuntime === 'codex' &&
        agentRuntimeConfigurationMode === 'custom' &&
        agentWorkspacePolicy === 'git_worktree' &&
        boundWorkspaceGitAvailable !== true
      ) {
        throw new Error(t('workbench.project_chat_agent_worktree_unavailable'))
      }
      const workspaceBinding =
        agentRuntime !== 'codex' ||
        agentRuntimeConfigurationMode === 'template' ||
        agentLocalProjectId === ''
          ? ({ type: 'standalone' } as const)
          : selectedProjectUsesDeviceBinding
            ? ({
                type: 'device_project',
                deviceId: effectiveExecutionDeviceId,
                runtimeProjectKey: selectedRuntimeProjectKey,
              } as const)
            : ({
                type: 'backend_project',
                projectId: agentLocalProjectId,
                deviceId: effectiveExecutionDeviceId,
                ...(effectiveExecutionEnvironment === 'cloud'
                  ? { deviceWorkspaceId: Number(resolvedAgentDeviceWorkspaceId) }
                  : {}),
              } as const)
      if (creatingChatAgent) {
        const agent = await projectChatAgentApi.create(project.id, {
          name: agentName.trim(),
          runtime: agentRuntime,
          wegentTeamId: agentWegentTeamId === '' ? null : agentWegentTeamId,
          model: agentRuntime === 'codex' ? agentModel.trim() || null : null,
          modelType: agentRuntime === 'codex' ? agentModelType : null,
          modelOptions: agentRuntime === 'codex' ? agentModelOptions : {},
          systemPrompt: agentSystemPrompt,
          capabilityDescription: agentCapabilityDescription.trim(),
          visibility: agentVisibility,
          executionEnvironment: effectiveExecutionEnvironment,
          executionMode: agentExecutionMode,
          maxConcurrentExecutions: agentMaxConcurrentExecutions,
          workspacePolicy: agentWorkspacePolicy,
          defaultRuntimeProfileId:
            agentRuntime === 'codex' && agentRuntimeConfigurationMode === 'template'
              ? agentRuntimeProfileId
              : null,
          executionDeviceId: agentRuntime === 'codex' ? effectiveExecutionDeviceId : null,
          workspaceBinding,
          plugins: agentRuntime === 'codex' ? agentPlugins : [],
        })
        const nextAgents = [...chatAgents, agent]
        collectionRevision.current += 1
        setChatAgents(nextAgents)
        onAgentsChange?.(nextAgents)
        onAgentCreated?.(agent)
        setCreatingChatAgent(false)
        setWorkflowCreateMode(false)
      } else if (editingChatAgent) {
        const updated = await projectChatAgentApi.update(project.id, editingChatAgent.id, {
          version: editingChatAgent.version,
          name: agentName.trim(),
          runtime: agentRuntime,
          wegentTeamId: agentWegentTeamId === '' ? null : agentWegentTeamId,
          model: agentRuntime === 'codex' ? agentModel.trim() || null : null,
          modelType: agentRuntime === 'codex' ? agentModelType : null,
          modelOptions: agentRuntime === 'codex' ? agentModelOptions : {},
          systemPrompt: agentSystemPrompt,
          capabilityDescription: agentCapabilityDescription.trim(),
          visibility: agentVisibility,
          executionEnvironment: effectiveExecutionEnvironment,
          executionMode: agentExecutionMode,
          maxConcurrentExecutions: agentMaxConcurrentExecutions,
          workspacePolicy: agentWorkspacePolicy,
          defaultRuntimeProfileId:
            agentRuntime === 'codex' && agentRuntimeConfigurationMode === 'template'
              ? agentRuntimeProfileId
              : null,
          executionDeviceId: agentRuntime === 'codex' ? effectiveExecutionDeviceId || null : null,
          workspaceBinding,
          plugins: agentRuntime === 'codex' ? agentPlugins : [],
        })
        const nextAgents = chatAgents.map(item => (item.id === updated.id ? updated : item))
        collectionRevision.current += 1
        setChatAgents(nextAgents)
        onAgentsChange?.(nextAgents)
        setEditingChatAgent(null)
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_chat_agents_save_failed')
      )
    } finally {
      setAgentBusy(false)
    }
  }

  return (
    <section
      data-testid="cloud-project-chat-agents"
      className="mt-8 scroll-mt-4 border-t border-border pt-8"
    >
      <div
        className={`flex items-center justify-between gap-3${activeChatAgents.length ? ' mb-3' : ''}`}
      >
        <div>
          <h2 className="text-heading-md font-semibold">
            {t('workbench.project_chat_agents_title')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t('workbench.project_chat_agents_description')}
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            data-testid="cloud-project-chat-agent-add"
            disabled={agentBusy}
            onClick={() => openCreateChatAgent()}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> {t('workbench.project_chat_agents_add')}
          </button>
        ) : null}
      </div>
      <div className="space-y-2" data-testid="cloud-project-chat-agent-list">
        {activeChatAgents.length === 0 ? (
          canManage ? (
            <div className="mt-5 flex min-h-40 flex-col justify-center rounded-2xl border border-dashed border-border p-5">
              <p className="mb-2.5 text-xs font-medium text-text-muted">
                {t('workbench.project_templates_start')}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <button
                  type="button"
                  data-testid="project-chat-agent-template-planning"
                  onClick={() =>
                    openCreateChatAgent({
                      name: t('workbench.project_chat_agent_template_planning_name'),
                      capabilityDescription: t(
                        'workbench.project_chat_agent_template_planning_description'
                      ),
                      systemPrompt: t('workbench.project_chat_agent_template_planning_prompt'),
                    })
                  }
                  className={templateButtonClass}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    <ListChecks className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary">
                      {t('workbench.project_chat_agent_template_planning_name')}
                    </span>
                    <span className="mt-1 block truncate text-xs text-text-muted">
                      {t('workbench.project_chat_agent_template_planning_description')}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="project-chat-agent-template-development"
                  onClick={() =>
                    openCreateChatAgent({
                      name: t('workbench.project_chat_agent_template_development_name'),
                      capabilityDescription: t(
                        'workbench.project_chat_agent_template_development_description'
                      ),
                      systemPrompt: t('workbench.project_chat_agent_template_development_prompt'),
                    })
                  }
                  className={templateButtonClass}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    <Code2 className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary">
                      {t('workbench.project_chat_agent_template_development_name')}
                    </span>
                    <span className="mt-1 block truncate text-xs text-text-muted">
                      {t('workbench.project_chat_agent_template_development_description')}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="project-chat-agent-template-review"
                  onClick={() =>
                    openCreateChatAgent({
                      name: t('workbench.project_chat_agent_template_review_name'),
                      capabilityDescription: t(
                        'workbench.project_chat_agent_template_review_description'
                      ),
                      systemPrompt: t('workbench.project_chat_agent_template_review_prompt'),
                    })
                  }
                  className={templateButtonClass}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary">
                      {t('workbench.project_chat_agent_template_review_name')}
                    </span>
                    <span className="mt-1 block truncate text-xs text-text-muted">
                      {t('workbench.project_chat_agent_template_review_description')}
                    </span>
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 text-center">
              <Bot className="mb-2 h-5 w-5 text-text-tertiary" />
              <p className="text-sm text-text-muted">{t('workbench.project_chat_agents_empty')}</p>
            </div>
          )
        ) : (
          activeChatAgents.map(agent => (
            <div
              key={agent.id}
              role={canManage ? 'button' : undefined}
              tabIndex={canManage ? 0 : undefined}
              data-testid={`cloud-project-chat-agent-${agent.id}`}
              onClick={canManage ? () => editChatAgent(agent) : undefined}
              onKeyDown={
                canManage
                  ? event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        editChatAgent(agent)
                      }
                    }
                  : undefined
              }
              className={`flex w-full items-center gap-4 rounded-xl border border-border px-4 py-3 transition${
                canManage ? ' cursor-pointer hover:border-text-tertiary hover:bg-surface' : ''
              }`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Bot className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{agent.name}</span>
                <span className="mt-0.5 block truncate text-xs text-text-muted">
                  {agent.runtime === 'wegent' ? 'Wegent' : 'Wework'}
                  {agent.model ? ` · ${agent.model}` : ''}
                  {agent.defaultRuntimeProfileId
                    ? ` · ${t('workbench.project_chat_agent_runtime_template_summary', {
                        name:
                          runtimeProfiles.find(
                            profile => profile.id === agent.defaultRuntimeProfileId
                          )?.name ?? agent.defaultRuntimeProfileId,
                      })}`
                    : agent.runtime === 'codex' && agent.executionDeviceId
                      ? ` · ${t('workbench.project_chat_agent_runtime_custom_summary', {
                          device: agent.executionDeviceId,
                        })}`
                      : ''}
                  {agent.runtime === 'wegent'
                    ? ` · ${
                        availableTeams.find(team => team.id === agent.wegentTeamId)?.displayName ||
                        availableTeams.find(team => team.id === agent.wegentTeamId)?.name ||
                        'Wegent'
                      }`
                    : ''}
                  {' · '}
                  {agent.executionMode === 'manual_approval'
                    ? t('workbench.project_chat_agent_mode_manual')
                    : t('workbench.project_chat_agent_mode_auto')}
                  {agent.localProjectId
                    ? ` · ${t('workbench.project_chat_agent_bound_project', {
                        name:
                          localProjects.find(project => project.id === agent.localProjectId)
                            ?.name ?? String(agent.localProjectId),
                      })}`
                    : ''}
                  {agent.createdByUserName
                    ? ` · ${t('workbench.project_chat_agent_creator', {
                        name: agent.createdByUserName,
                      })}`
                    : ''}
                </span>
                {agent.capabilityDescription ? (
                  <span className="mt-1 block truncate text-xs text-text-secondary">
                    {agent.capabilityDescription}
                  </span>
                ) : null}
              </span>
              {canManage ? (
                <span
                  className="shrink-0"
                  onClick={event => event.stopPropagation()}
                  onKeyDown={event => event.stopPropagation()}
                >
                  <button
                    type="button"
                    data-testid={`cloud-project-chat-agent-remove-${agent.id}`}
                    disabled={agentBusy}
                    onClick={() => void archiveChatAgent(agent)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-red-600"
                    aria-label={t('workbench.project_chat_agents_remove', { name: agent.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
      {canManage && (creatingChatAgent || editingChatAgent) ? (
        <CloudTodoModal
          title={
            creatingChatAgent
              ? t('workbench.project_chat_agents_add')
              : t('workbench.project_chat_agents_edit', {
                  name: editingChatAgent?.name ?? '',
                })
          }
          width={workflowCreateMode ? 'workflow' : 'workspace'}
          onClose={() => {
            if (creatingChatAgent) onCreateCancelled?.()
            setCreatingChatAgent(false)
            setWorkflowCreateMode(false)
            setEditingChatAgent(null)
          }}
        >
          <div
            className={
              workflowCreateMode
                ? 'flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-border'
                : 'grid min-h-0 flex-1 grid-cols-1 overflow-y-auto border-t border-border md:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)] md:overflow-hidden'
            }
            data-testid="cloud-project-chat-agent-editor"
          >
            <div
              className={
                workflowCreateMode
                  ? 'flex flex-col px-6 pb-2 pt-5'
                  : 'flex min-h-[560px] flex-col px-7 py-6 md:min-h-0'
              }
            >
              <input
                data-testid="cloud-project-chat-agent-name"
                value={agentName}
                autoFocus={creatingChatAgent}
                onChange={event => setAgentName(event.target.value)}
                placeholder={t('workbench.project_chat_agent_name')}
                className="w-full border-0 bg-transparent p-0 text-heading-lg font-semibold tracking-[-0.03em] text-text-primary outline-none placeholder:text-text-tertiary"
              />
              {workflowCreateMode ? (
                <button
                  type="button"
                  data-testid="cloud-project-chat-agent-advanced-toggle"
                  aria-expanded={showAdvancedAgentFields}
                  onClick={() => setShowAdvancedAgentFields(current => !current)}
                  className="mt-4 flex h-8 items-center gap-1.5 self-start rounded-lg px-2 text-sm text-text-secondary hover:bg-surface"
                >
                  {t('workbench.project_chat_agent_advanced')}
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      showAdvancedAgentFields ? 'rotate-180' : ''
                    }`}
                  />
                </button>
              ) : null}
              {!workflowCreateMode || showAdvancedAgentFields ? (
                <>
                  <label
                    htmlFor="cloud-project-chat-agent-capability-field"
                    className="mt-6 text-sm font-medium text-text-secondary"
                  >
                    {t('workbench.project_chat_agent_capability')}
                  </label>
                  <textarea
                    id="cloud-project-chat-agent-capability-field"
                    data-testid="cloud-project-chat-agent-capability"
                    value={agentCapabilityDescription}
                    onChange={event => setAgentCapabilityDescription(event.target.value)}
                    placeholder={t('workbench.project_chat_agent_capability_placeholder')}
                    className="mt-2 min-h-24 resize-none rounded-2xl border border-border bg-background px-5 py-4 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
                  />
                  <label
                    htmlFor="cloud-project-chat-agent-system-prompt-field"
                    className="mt-6 text-xs font-semibold uppercase tracking-wider text-text-muted"
                  >
                    {t('workbench.project_chat_agent_prompt')}
                  </label>
                  <textarea
                    id="cloud-project-chat-agent-system-prompt-field"
                    data-testid="cloud-project-chat-agent-system-prompt"
                    value={agentSystemPrompt}
                    onChange={event => setAgentSystemPrompt(event.target.value)}
                    placeholder={t('workbench.project_chat_agent_prompt')}
                    className={`mt-2 resize-none rounded-2xl border border-border bg-background px-5 py-4 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary ${
                      workflowCreateMode ? 'min-h-40' : 'min-h-72 flex-1'
                    }`}
                  />
                </>
              ) : null}
            </div>

            <div
              className={
                workflowCreateMode
                  ? 'min-h-0 px-6 pb-6 pt-1'
                  : 'min-h-0 border-t border-border px-6 pb-6 pt-1 md:overflow-y-auto md:border-l md:border-t-0'
              }
            >
              <section data-testid="cloud-project-chat-agent-runtime-group">
                <SectionTitle title={t('workbench.project_chat_agent_runtime_group')} />
                <SettingsGroup>
                  <SettingsRow
                    label={t('workbench.project_chat_agent_runtime_provider')}
                    description={t('workbench.project_chat_agent_runtime_provider_relation')}
                  >
                    <MenuSelect
                      testId="cloud-project-chat-agent-environment"
                      value={agentRuntime}
                      pill
                      onChange={value => {
                        if (value === 'wegent') {
                          if (localProjectOnly) return
                          setAgentRuntime('wegent')
                          setAgentRuntimeProfileId('')
                          setAgentExecutionDeviceId('')
                          setAgentLocalProjectId('')
                          setAgentModel('')
                          setAgentModelType(null)
                          setAgentModelOptions({})
                          return
                        }
                        setAgentRuntime('codex')
                        setAgentWegentTeamId('')
                        setAgentExecutionDeviceId(current => {
                          if (executionDevices.some(device => device.device_id === current)) {
                            return current
                          }
                          return executionDevices[0]?.device_id ?? ''
                        })
                      }}
                      options={[
                        {
                          value: 'codex',
                          label: t('workbench.project_chat_agent_provider_wework'),
                        },
                        ...(!localProjectOnly ? [{ value: 'wegent', label: 'Wegent' }] : []),
                      ]}
                    />
                  </SettingsRow>
                  {agentRuntime === 'wegent' ? (
                    <SettingsRow
                      label={t('workbench.project_chat_agent_wegent_team')}
                      description={t('workbench.project_chat_agent_wegent_team_relation')}
                      requiredLabel={t('common.required')}
                      error={
                        agentSaveAttempted && agentWegentTeamId === ''
                          ? t('workbench.project_chat_agent_wegent_team_select')
                          : undefined
                      }
                    >
                      <MenuSelect
                        testId="cloud-project-chat-agent-wegent-team"
                        value={agentWegentTeamId === '' ? '' : String(agentWegentTeamId)}
                        pill
                        placeholder={t('workbench.project_chat_agent_wegent_team_select')}
                        invalid={agentSaveAttempted && agentWegentTeamId === ''}
                        onChange={value => setAgentWegentTeamId(value ? Number(value) : '')}
                        options={availableTeams.map(team => ({
                          value: String(team.id),
                          label: team.displayName || team.name,
                        }))}
                      />
                    </SettingsRow>
                  ) : (
                    <>
                      <SettingsRow
                        label={t('workbench.project_chat_agent_runtime_configuration')}
                        description={t(
                          'workbench.project_chat_agent_runtime_configuration_relation'
                        )}
                      >
                        <MenuSelect
                          testId="cloud-project-chat-agent-runtime-configuration-mode"
                          value={agentRuntimeConfigurationMode}
                          pill
                          onChange={value => {
                            const mode = value as RuntimeConfigurationMode
                            setAgentRuntimeConfigurationMode(mode)
                            if (mode === 'template') {
                              const profile =
                                visibleRuntimeProfiles.find(
                                  item => item.id === agentRuntimeProfileId
                                ) ?? visibleRuntimeProfiles[0]
                              setAgentRuntimeProfileId(profile?.id ?? '')
                              setAgentModel(profile?.model ?? '')
                              setAgentModelType(profile?.modelType ?? null)
                              setAgentModelOptions(profile?.modelOptions ?? {})
                              setAgentLocalProjectId('')
                              setAgentDeviceWorkspaceId('')
                              return
                            }
                            setAgentRuntimeProfileId('')
                            setAgentModel('')
                            setAgentModelType(null)
                            setAgentModelOptions({})
                            const device =
                              executionDevices.find(
                                item => item.device_id === agentExecutionDeviceId
                              ) ?? executionDevices[0]
                            const environment = executionEnvironmentForDevice(device)
                            setAgentExecutionDeviceId(device?.device_id ?? '')
                            setAgentExecutionEnvironment(environment)
                            agentExecutionEnvironmentRef.current = environment
                          }}
                          options={[
                            {
                              value: 'custom',
                              label: t('workbench.project_chat_agent_runtime_custom'),
                            },
                            {
                              value: 'template',
                              label: t('workbench.project_chat_agent_runtime_template'),
                            },
                          ]}
                        />
                      </SettingsRow>
                      {agentRuntimeConfigurationMode === 'template' ? (
                        <SettingsRow
                          label={t('workbench.project_chat_agent_runtime_template_label')}
                          description={t('workbench.project_chat_agent_runtime_template_relation')}
                          requiredLabel={t('common.required')}
                          error={
                            agentSaveAttempted && !selectedRuntimeProfile
                              ? t('workbench.project_chat_agent_runtime_template_select')
                              : undefined
                          }
                        >
                          <div className="flex flex-col items-end gap-1.5">
                            <MenuSelect
                              testId="cloud-project-chat-agent-runtime-profile"
                              value={agentRuntimeProfileId}
                              pill
                              placeholder={t(
                                'workbench.project_chat_agent_runtime_template_select'
                              )}
                              invalid={agentSaveAttempted && !selectedRuntimeProfile}
                              onChange={value => {
                                setAgentRuntimeProfileId(value)
                                const profile = visibleRuntimeProfiles.find(
                                  item => item.id === value
                                )
                                setAgentModel(profile?.model ?? '')
                                setAgentModelType(profile?.modelType ?? null)
                                setAgentModelOptions(profile?.modelOptions ?? {})
                              }}
                              options={visibleRuntimeProfiles.map(profile => ({
                                value: profile.id,
                                label: profile.name,
                              }))}
                            />
                            {visibleRuntimeProfiles.length === 0 ? (
                              <span className="text-xs text-text-muted">
                                {t('workbench.project_chat_agent_runtime_template_empty')}
                              </span>
                            ) : null}
                          </div>
                        </SettingsRow>
                      ) : (
                        <>
                          <SettingsRow
                            label={t('workbench.project_chat_agent_device')}
                            description={t('workbench.project_chat_agent_device_relation')}
                            requiredLabel={t('common.required')}
                            error={
                              agentSaveAttempted && !agentExecutionDeviceId
                                ? t('workbench.project_chat_agent_device_select')
                                : undefined
                            }
                          >
                            <MenuSelect
                              testId="cloud-project-chat-agent-device"
                              value={agentExecutionDeviceId}
                              pill
                              placeholder={t('workbench.project_chat_agent_device_select')}
                              invalid={agentSaveAttempted && !agentExecutionDeviceId}
                              onChange={value => {
                                const device = executionDevices.find(
                                  item => item.device_id === value
                                )
                                const environment = executionEnvironmentForDevice(device)
                                setAgentExecutionDeviceId(value)
                                setAgentExecutionEnvironment(environment)
                                agentExecutionEnvironmentRef.current = environment
                                setAgentDeviceWorkspaceId('')
                                setAgentWorkspacePolicy('project')
                                if (agentModel && environment === 'cloud') {
                                  const model = availableModels.find(
                                    candidate =>
                                      candidate.name === agentModel &&
                                      (!agentModelType || candidate.type === agentModelType)
                                  )
                                  if (model?.type === 'runtime') {
                                    setAgentModel('')
                                    setAgentModelType(null)
                                    setAgentModelOptions({})
                                  }
                                }
                                // The bound project must have a workspace on the new device.
                                setAgentLocalProjectId(current => {
                                  if (current === '' || environment === 'local') return current
                                  const stillAvailable = (runtimeWork?.projects ?? []).some(
                                    projectWork =>
                                      runtimeProjectUiId(projectWork.project) === current &&
                                      projectWork.deviceWorkspaces.some(
                                        workspace =>
                                          workspace.deviceId === value && workspace.available
                                      )
                                  )
                                  return stillAvailable ? current : ''
                                })
                              }}
                              options={executionDevices.map(device => ({
                                value: device.device_id,
                                label: executionDeviceLabel(device),
                              }))}
                            />
                          </SettingsRow>
                          <SettingsRow
                            label={t('workbench.project_chat_agent_execution_project')}
                            description={t(
                              'workbench.project_chat_agent_execution_project_relation'
                            )}
                          >
                            <MenuSelect
                              testId="cloud-project-chat-agent-execution-project"
                              value={currentExecutionProject}
                              pill
                              onChange={value => {
                                const projectId = value === '' ? '' : Number(value)
                                setAgentLocalProjectId(projectId)
                                setAgentWorkspacePolicy('project')
                                if (projectId === '' || effectiveExecutionEnvironment !== 'cloud') {
                                  setAgentDeviceWorkspaceId('')
                                  return
                                }
                                const candidates = (runtimeWork?.projects ?? [])
                                  .find(
                                    projectWork =>
                                      runtimeProjectUiId(projectWork.project) === projectId
                                  )
                                  ?.deviceWorkspaces.filter(
                                    workspace =>
                                      workspace.deviceId === effectiveExecutionDeviceId &&
                                      workspace.available
                                  )
                                const workspaceId = candidates?.[0]?.id
                                setAgentDeviceWorkspaceId(
                                  typeof workspaceId === 'number' ? workspaceId : ''
                                )
                              }}
                              options={[
                                {
                                  value: '',
                                  label: t('workbench.project_chat_agent_execution_project_none'),
                                },
                                ...executionProjectOptions,
                              ]}
                              action={
                                Boolean(effectiveExecutionDeviceId) &&
                                onCreateLocalCodeProject &&
                                onGetDeviceHomeDirectory &&
                                onListDeviceDirectories &&
                                onCreateDeviceDirectory
                                  ? {
                                      label: t('workbench.project_chat_agent_create_code_project'),
                                      testId: 'cloud-project-chat-agent-create-code-project',
                                      icon: <Plus className="h-4 w-4 text-text-secondary" />,
                                      onSelect: () => setCreateCodeProjectOpen(true),
                                    }
                                  : undefined
                              }
                            />
                          </SettingsRow>
                        </>
                      )}
                    </>
                  )}
                </SettingsGroup>
              </section>

              {agentRuntime === 'codex' ? (
                <section data-testid="cloud-project-chat-agent-plugins-group">
                  <SectionTitle title={t('workbench.project_chat_agent_plugins_group')} />
                  <SettingsGroup>
                    <div className="px-4 py-3">
                      <p className="text-sm text-text-muted">
                        {t('workbench.project_chat_agent_plugins_relation')}
                      </p>
                      <div
                        className="mt-3 max-h-64 space-y-1 overflow-y-auto"
                        data-testid="cloud-project-chat-agent-plugins"
                      >
                        {visiblePlugins.map(plugin => {
                          const selected = agentPlugins.some(item => item.id === plugin.id)
                          return (
                            <button
                              key={plugin.id}
                              type="button"
                              data-testid={`cloud-project-chat-agent-plugin-${plugin.id}`}
                              aria-pressed={selected}
                              onClick={() =>
                                setAgentPlugins(current =>
                                  selected
                                    ? current.filter(item => item.id !== plugin.id)
                                    : [...current, plugin]
                                )
                              }
                              className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-surface"
                            >
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
                                <Plug className="h-4 w-4" aria-hidden="true" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-text-primary">
                                  {plugin.displayName}
                                </span>
                                <span className="block truncate text-xs text-text-muted">
                                  {plugin.marketplaceId}
                                </span>
                              </span>
                              <span
                                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                                  selected
                                    ? 'border-text-primary bg-text-primary text-background'
                                    : 'border-border text-transparent'
                                }`}
                              >
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              </span>
                            </button>
                          )
                        })}
                        {pluginsLoading ? (
                          <p className="px-2 py-2 text-sm text-text-muted">
                            {t('workbench.project_chat_agent_plugins_loading')}
                          </p>
                        ) : visiblePlugins.length === 0 ? (
                          <p className="px-2 py-2 text-sm text-text-muted">
                            {t('workbench.project_chat_agent_plugins_empty')}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </SettingsGroup>
                </section>
              ) : null}

              <section data-testid="cloud-project-chat-agent-execution-group">
                <SectionTitle title={t('workbench.project_chat_agent_execution_group')} />
                <SettingsGroup>
                  {agentRuntime === 'codex' ? (
                    <SettingsRow
                      label={t('workbench.project_chat_agent_model')}
                      description={t('workbench.project_chat_agent_model_relation')}
                    >
                      <MenuSelect
                        testId="cloud-project-chat-agent-model"
                        value={agentModel ? modelSelectionKey(agentModel, agentModelType) : ''}
                        pill
                        placeholder={t('workbench.project_chat_agent_model_placeholder')}
                        onChange={value => {
                          const selected = environmentModels.find(
                            model => modelSelectionKey(model.name, model.type) === value
                          )
                          if (!selected) {
                            setAgentModel('')
                            setAgentModelType(null)
                            setAgentModelOptions({})
                            return
                          }
                          const execution = selectedModelExecutionFields(selected, {})
                          setAgentModel(execution.modelId ?? '')
                          setAgentModelType(execution.modelType ?? null)
                          setAgentModelOptions(execution.modelOptions ?? {})
                        }}
                        options={[
                          ...(agentModel &&
                          !environmentModels.some(
                            model =>
                              model.name === agentModel &&
                              (!agentModelType || model.type === agentModelType)
                          )
                            ? [
                                {
                                  value: modelSelectionKey(agentModel, agentModelType),
                                  label: agentModel,
                                },
                              ]
                            : []),
                          ...environmentModels.map(model => ({
                            value: modelSelectionKey(model.name, model.type),
                            label: model.displayName ?? model.name,
                          })),
                        ]}
                      />
                    </SettingsRow>
                  ) : null}
                  {!workflowCreateMode ? (
                    <>
                      <SettingsRow label={t('workbench.project_chat_agent_mode')}>
                        <MenuSelect
                          testId="cloud-project-chat-agent-mode"
                          value={agentExecutionMode}
                          pill
                          onChange={value =>
                            setAgentExecutionMode(value as ProjectChatAgent['executionMode'])
                          }
                          options={[
                            { value: 'auto', label: t('workbench.project_chat_agent_mode_auto') },
                            {
                              value: 'manual_approval',
                              label: t('workbench.project_chat_agent_mode_manual'),
                            },
                          ]}
                        />
                      </SettingsRow>
                      <SettingsRow
                        label={t('workbench.project_chat_agent_max_concurrent_executions')}
                        description={t(
                          'workbench.project_chat_agent_max_concurrent_executions_relation'
                        )}
                      >
                        <input
                          type="number"
                          min={1}
                          max={20}
                          step={1}
                          data-testid="cloud-project-chat-agent-max-concurrent-executions"
                          value={agentMaxConcurrentExecutions}
                          onChange={event =>
                            setAgentMaxConcurrentExecutions(
                              Math.max(1, Math.min(20, Number(event.target.value) || 1))
                            )
                          }
                          className="h-8 w-20 rounded-lg border border-border bg-background px-2 text-right text-sm text-text-primary outline-none focus:border-text-tertiary"
                        />
                      </SettingsRow>
                      {agentRuntime === 'codex' && agentRuntimeConfigurationMode === 'custom' ? (
                        <SettingsRow
                          label={t('workbench.project_chat_agent_workspace_policy')}
                          description={t(
                            boundWorkspaceGitAvailable === true
                              ? 'workbench.project_chat_agent_workspace_policy_relation'
                              : 'workbench.project_chat_agent_workspace_policy_requires_git'
                          )}
                        >
                          <MenuSelect
                            testId="cloud-project-chat-agent-workspace-policy"
                            value={agentWorkspacePolicy}
                            pill
                            onChange={value =>
                              setAgentWorkspacePolicy(value as ProjectChatAgent['workspacePolicy'])
                            }
                            options={[
                              {
                                value: 'project',
                                label: t('workbench.project_chat_agent_workspace_policy_project'),
                              },
                              {
                                value: 'git_worktree',
                                label: t('workbench.project_chat_agent_workspace_policy_worktree'),
                                disabled: boundWorkspaceGitAvailable !== true,
                              },
                            ]}
                          />
                        </SettingsRow>
                      ) : null}
                    </>
                  ) : null}
                </SettingsGroup>
              </section>

              {!workflowCreateMode ? (
                <section data-testid="cloud-project-chat-agent-access-group">
                  <SectionTitle title={t('workbench.project_chat_agent_access_group')} />
                  <SettingsGroup>
                    <SettingsRow
                      label={t('workbench.project_chat_agent_visibility')}
                      description={t('workbench.project_chat_agent_visibility_relation')}
                    >
                      <MenuSelect
                        testId="cloud-project-chat-agent-visibility"
                        value={agentVisibility}
                        pill
                        onChange={value =>
                          setAgentVisibility(value as ProjectChatAgent['visibility'])
                        }
                        options={[
                          {
                            value: 'private',
                            label: t('workbench.project_chat_agent_visibility_private'),
                          },
                          {
                            value: 'creator_admin',
                            label: t('workbench.project_chat_agent_visibility_creator_admin'),
                          },
                          {
                            value: 'public',
                            label: t('workbench.project_chat_agent_visibility_public'),
                          },
                        ]}
                      />
                    </SettingsRow>
                  </SettingsGroup>
                </section>
              ) : null}

              {error ? (
                <p
                  className="mt-4 text-sm text-red-600"
                  data-testid="cloud-project-chat-agent-error"
                >
                  {error}
                </p>
              ) : null}
            </div>
          </div>

          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
            <button
              type="button"
              data-testid="cloud-project-chat-agent-cancel"
              onClick={() => {
                if (creatingChatAgent) onCreateCancelled?.()
                setCreatingChatAgent(false)
                setWorkflowCreateMode(false)
                setEditingChatAgent(null)
              }}
              className="h-8 rounded-lg px-3 text-sm hover:bg-surface"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="cloud-project-chat-agent-save"
              disabled={agentBusy || !projectChatAgentApi || !agentName.trim()}
              onClick={() => void saveChatAgent()}
              className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-40"
            >
              {t('workbench.project_chat_agent_save')}
            </button>
          </footer>
        </CloudTodoModal>
      ) : null}
      {error && !creatingChatAgent && !editingChatAgent ? (
        <p className="mt-3 text-xs text-destructive">{error}</p>
      ) : null}
      {onCreateLocalCodeProject &&
      onGetDeviceHomeDirectory &&
      onListDeviceDirectories &&
      onCreateDeviceDirectory ? (
        <StandaloneFolderProjectDialog
          key={createCodeProjectOpen ? effectiveExecutionDeviceId : 'code-project-closed'}
          open={createCodeProjectOpen}
          mode="existing"
          devices={availableDevices}
          preferredDeviceId={effectiveExecutionDeviceId}
          fixedDeviceId={effectiveExecutionDeviceId}
          chooseProjectSource
          preferNativeLocalPicker={false}
          layer="system-popover"
          onClose={() => setCreateCodeProjectOpen(false)}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onListDeviceDirectories={onListDeviceDirectories}
          onCreateDeviceDirectory={onCreateDeviceDirectory}
          onCloneGitRepository={onCloneGitRepository}
          onOpenStandaloneWorkspace={async (deviceId, workspacePath, name, roots) => {
            const created = await onCreateLocalCodeProject({
              deviceId,
              name: name ?? workspacePath,
              roots: roots ?? [workspacePath],
            })
            setCreatedCodeProjects(current =>
              current.some(project => project.id === created.id) ? current : [...current, created]
            )
            setCreatedRuntimeProjectKeys(current => ({
              ...current,
              [created.id]: created.runtimeProjectKey,
            }))
            setAgentLocalProjectId(created.id)
            setAgentDeviceWorkspaceId('')
            setAgentWorkspacePolicy('project')
          }}
        />
      ) : null}
    </section>
  )
}
