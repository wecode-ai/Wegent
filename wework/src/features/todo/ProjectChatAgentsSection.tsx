import { Bot, Code2, ListChecks, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { MenuSelect } from '@/components/common/MenuSelect'
import { SectionTitle, SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'
import type { UnifiedModel } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'

interface ProjectChatAgentTemplate {
  name: string
  capabilityDescription: string
  systemPrompt: string
}

const templateButtonClass =
  'flex min-h-20 items-center gap-3.5 rounded-xl border border-border bg-background p-4 text-left transition hover:border-text-tertiary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30'

export function ProjectChatAgentsSection({
  project,
  projectChatAgentApi,
  deviceApi,
  modelApi,
  localProjects,
  runtimeWork,
  canManage,
}: {
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  canManage: boolean
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
  const [editingChatAgent, setEditingChatAgent] = useState<ProjectChatAgent | null>(null)
  const [agentName, setAgentName] = useState('')
  const [agentModel, setAgentModel] = useState('')
  const [agentSystemPrompt, setAgentSystemPrompt] = useState('')
  const [agentCapabilityDescription, setAgentCapabilityDescription] = useState('')
  const [agentVisibility, setAgentVisibility] =
    useState<ProjectChatAgent['visibility']>('creator_admin')
  const [agentExecutionEnvironment, setAgentExecutionEnvironment] =
    useState<ProjectChatAgent['executionEnvironment']>('local')
  const [agentExecutionMode, setAgentExecutionMode] =
    useState<ProjectChatAgent['executionMode']>('auto')
  const [agentExecutionDeviceId, setAgentExecutionDeviceId] = useState<string>('')
  const [agentLocalProjectId, setAgentLocalProjectId] = useState<number | ''>('')
  const [availableDevices, setAvailableDevices] = useState<
    Array<{ device_id: string; device_type?: string; status?: string }>
  >([])
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [agentSaveAttempted, setAgentSaveAttempted] = useState(false)

  useEffect(() => {
    if (!projectChatAgentApi) return
    let active = true
    void projectChatAgentApi
      .list(project.id)
      .then(agents => active && setChatAgents(agents))
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
  }, [project.id, projectChatAgentApi, t])

  useEffect(() => {
    if (!deviceApi?.listDevices) return
    let active = true
    deviceApi
      .listDevices()
      .then(devices => {
        if (active) setAvailableDevices(devices)
      })
      .catch(() => {
        if (active) setAvailableDevices([])
      })
    return () => {
      active = false
    }
  }, [deviceApi])

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

  const activeChatAgents = chatAgents.filter(agent => agent.status === 'active')
  // Runtime-catalog models are discovered on the local device, so a robot
  // bound to cloud execution cannot use them.
  const environmentModels =
    agentExecutionEnvironment === 'cloud'
      ? availableModels.filter(model => model.type !== 'runtime')
      : availableModels
  // A cloud robot can only bind a code project that already has an available
  // workspace on the selected cloud device. The runtime work registry is the
  // same source the device management page uses.
  const bindableCloudProjects = (runtimeWork?.projects ?? []).filter(
    projectWork =>
      projectWork.project.id != null &&
      projectWork.deviceWorkspaces.some(
        workspace => workspace.deviceId === agentExecutionDeviceId && workspace.available
      )
  )
  const executionProjectOptions =
    agentExecutionEnvironment === 'cloud'
      ? bindableCloudProjects.map(projectWork => ({
          value: String(projectWork.project.id),
          label: projectWork.project.name,
        }))
      : localProjects.map(localProject => ({
          value: String(localProject.id),
          label: localProject.name,
        }))
  const currentExecutionProject = agentLocalProjectId === '' ? '' : String(agentLocalProjectId)
  if (
    currentExecutionProject &&
    !executionProjectOptions.some(option => option.value === currentExecutionProject)
  ) {
    const knownName =
      localProjects.find(localProject => String(localProject.id) === currentExecutionProject)
        ?.name ??
      (runtimeWork?.projects ?? []).find(
        projectWork => String(projectWork.project.id) === currentExecutionProject
      )?.project.name
    executionProjectOptions.unshift({
      value: currentExecutionProject,
      label: knownName ?? currentExecutionProject,
    })
  }

  function openCreateChatAgent(template?: ProjectChatAgentTemplate) {
    setAgentSaveAttempted(false)
    setCreatingChatAgent(true)
    setEditingChatAgent(null)
    setAgentName(template?.name ?? t('workbench.project_chat_new_agent'))
    setAgentModel('')
    setAgentSystemPrompt(template?.systemPrompt ?? '')
    setAgentCapabilityDescription(template?.capabilityDescription ?? '')
    setAgentVisibility('creator_admin')
    setAgentExecutionEnvironment('local')
    setAgentExecutionMode('auto')
    setAgentExecutionDeviceId('')
    setAgentLocalProjectId('')
  }

  async function archiveChatAgent(agent: ProjectChatAgent) {
    if (agentBusy || !projectChatAgentApi) return
    setAgentBusy(true)
    try {
      const updated = await projectChatAgentApi.update(project.id, agent.id, {
        version: agent.version,
        status: 'archived',
      })
      setChatAgents(current => current.map(item => (item.id === updated.id ? updated : item)))
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
    setEditingChatAgent(agent)
    setAgentName(agent.name)
    setAgentModel(agent.model ?? '')
    setAgentSystemPrompt(agent.systemPrompt)
    setAgentCapabilityDescription(agent.capabilityDescription ?? '')
    setAgentVisibility(agent.visibility)
    setAgentExecutionEnvironment(localProjectOnly ? 'local' : agent.executionEnvironment)
    setAgentExecutionMode(agent.executionMode)
    setAgentLocalProjectId(agent.localProjectId ?? '')
    const boundDevice = agent.executionDeviceId ?? ''
    const deviceIsLocalCapable = availableDevices.some(
      device =>
        device.device_id === boundDevice &&
        (device.device_type === 'local' || device.device_type === 'app')
    )
    setAgentExecutionDeviceId(
      localProjectOnly && boundDevice && !deviceIsLocalCapable ? '' : boundDevice
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
    if (!agentModel.trim() || !agentExecutionDeviceId) return
    setAgentBusy(true)
    try {
      if (creatingChatAgent) {
        const agent = await projectChatAgentApi.create(project.id, {
          name: agentName.trim(),
          runtime: 'codex',
          model: agentModel.trim(),
          systemPrompt: agentSystemPrompt,
          capabilityDescription: agentCapabilityDescription.trim(),
          visibility: agentVisibility,
          executionEnvironment: agentExecutionEnvironment,
          executionMode: agentExecutionMode,
          executionDeviceId: agentExecutionDeviceId,
          localProjectId: agentLocalProjectId === '' ? null : agentLocalProjectId,
        })
        setChatAgents(current => [...current, agent])
        setCreatingChatAgent(false)
      } else if (editingChatAgent) {
        const updated = await projectChatAgentApi.update(project.id, editingChatAgent.id, {
          version: editingChatAgent.version,
          name: agentName.trim(),
          model: agentModel.trim(),
          systemPrompt: agentSystemPrompt,
          capabilityDescription: agentCapabilityDescription.trim(),
          visibility: agentVisibility,
          executionEnvironment: agentExecutionEnvironment,
          executionMode: agentExecutionMode,
          executionDeviceId: agentExecutionDeviceId || null,
          localProjectId: agentLocalProjectId === '' ? null : agentLocalProjectId,
        })
        setChatAgents(current => current.map(item => (item.id === updated.id ? updated : item)))
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
    <section data-testid="cloud-project-chat-agents" className="mt-8 border-t border-border pt-8">
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
                  {agent.runtime}
                  {agent.model ? ` · ${agent.model}` : ''}
                  {' · '}
                  {agent.executionEnvironment === 'cloud'
                    ? t('workbench.project_chat_agent_env_cloud')
                    : t('workbench.project_chat_agent_env_local')}
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
          width="workspace"
          onClose={() => {
            setCreatingChatAgent(false)
            setEditingChatAgent(null)
          }}
        >
          <div
            className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto border-t border-border md:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)] md:overflow-hidden"
            data-testid="cloud-project-chat-agent-editor"
          >
            <div className="flex min-h-[560px] flex-col px-7 py-6 md:min-h-0">
              <input
                data-testid="cloud-project-chat-agent-name"
                value={agentName}
                autoFocus={creatingChatAgent}
                onChange={event => setAgentName(event.target.value)}
                placeholder={t('workbench.project_chat_agent_name')}
                className="w-full border-0 bg-transparent p-0 text-heading-lg font-semibold tracking-[-0.03em] text-text-primary outline-none placeholder:text-text-tertiary"
              />
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
                className="mt-2 min-h-72 flex-1 resize-none rounded-2xl border border-border bg-background px-5 py-4 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
              />
            </div>

            <div className="min-h-0 border-t border-border px-6 pb-6 pt-1 md:overflow-y-auto md:border-l md:border-t-0">
              <section data-testid="cloud-project-chat-agent-runtime-group">
                <SectionTitle title={t('workbench.project_chat_agent_runtime_group')} />
                <SettingsGroup>
                  <SettingsRow
                    label={t('workbench.project_chat_agent_environment')}
                    description={t('workbench.project_chat_agent_environment_relation')}
                  >
                    <MenuSelect
                      testId="cloud-project-chat-agent-environment"
                      value={agentExecutionEnvironment}
                      pill
                      onChange={value => {
                        const next = value as ProjectChatAgent['executionEnvironment']
                        if (localProjectOnly && next !== 'local') return
                        setAgentExecutionEnvironment(next)
                        // A project binding is resolved against the selected
                        // device, so changing environments clears the old one.
                        if (next !== 'local') setAgentLocalProjectId('')
                        // Runtime-catalog models only exist on the local device,
                        // so a cloud robot cannot keep one as its model.
                        setAgentModel(current => {
                          if (!current || next === 'local') return current
                          const model = availableModels.find(
                            candidate => candidate.name === current
                          )
                          return model?.type === 'runtime' ? '' : current
                        })
                        setAgentExecutionDeviceId(current => {
                          const currentDevice = availableDevices.find(
                            device => device.device_id === current
                          )
                          if (!currentDevice) return ''
                          const matches =
                            next === 'local'
                              ? currentDevice.device_type === 'local' ||
                                currentDevice.device_type === 'app'
                              : currentDevice.device_type === 'cloud' ||
                                currentDevice.device_type === 'remote'
                          return matches ? current : ''
                        })
                      }}
                      options={[
                        { value: 'local', label: t('workbench.project_chat_agent_env_local') },
                        ...(!localProjectOnly
                          ? [{ value: 'cloud', label: t('workbench.project_chat_agent_env_cloud') }]
                          : []),
                      ]}
                    />
                  </SettingsRow>
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
                        setAgentExecutionDeviceId(value)
                        // The bound project must have a workspace on the new device.
                        setAgentLocalProjectId(current => {
                          if (current === '' || agentExecutionEnvironment === 'local')
                            return current
                          const stillAvailable = (runtimeWork?.projects ?? []).some(
                            projectWork =>
                              String(projectWork.project.id) === String(current) &&
                              projectWork.deviceWorkspaces.some(
                                workspace => workspace.deviceId === value && workspace.available
                              )
                          )
                          return stillAvailable ? current : ''
                        })
                      }}
                      options={availableDevices
                        .filter(device =>
                          agentExecutionEnvironment === 'local'
                            ? device.device_type === 'local' || device.device_type === 'app'
                            : device.device_type === 'cloud' || device.device_type === 'remote'
                        )
                        .map(device => ({
                          value: device.device_id,
                          label: `${device.device_id}${device.status ? `（${device.status}）` : ''}`,
                        }))}
                    />
                  </SettingsRow>
                  <SettingsRow
                    label={t('workbench.project_chat_agent_execution_project')}
                    description={t('workbench.project_chat_agent_execution_project_relation')}
                  >
                    <MenuSelect
                      testId="cloud-project-chat-agent-execution-project"
                      value={currentExecutionProject}
                      pill
                      onChange={value => setAgentLocalProjectId(value === '' ? '' : Number(value))}
                      options={[
                        {
                          value: '',
                          label: t('workbench.project_chat_agent_execution_project_none'),
                        },
                        ...executionProjectOptions,
                      ]}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </section>

              <section data-testid="cloud-project-chat-agent-execution-group">
                <SectionTitle title={t('workbench.project_chat_agent_execution_group')} />
                <SettingsGroup>
                  <SettingsRow
                    label={t('workbench.project_chat_agent_model')}
                    description={t('workbench.project_chat_agent_model_relation')}
                    requiredLabel={t('common.required')}
                    error={
                      agentSaveAttempted && !agentModel.trim()
                        ? t('workbench.project_chat_agent_model_placeholder')
                        : undefined
                    }
                  >
                    <MenuSelect
                      testId="cloud-project-chat-agent-model"
                      value={agentModel}
                      pill
                      placeholder={t('workbench.project_chat_agent_model_placeholder')}
                      invalid={agentSaveAttempted && !agentModel.trim()}
                      onChange={setAgentModel}
                      options={[
                        ...(agentModel &&
                        !environmentModels.some(model => model.name === agentModel)
                          ? [{ value: agentModel, label: agentModel }]
                          : []),
                        ...environmentModels.map(model => ({
                          value: model.name,
                          label: model.displayName ?? model.name,
                        })),
                      ]}
                    />
                  </SettingsRow>
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
                </SettingsGroup>
              </section>

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
                setCreatingChatAgent(false)
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
    </section>
  )
}
