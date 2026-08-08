import { Bot, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { ProjectWithTasks } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'
import type { UnifiedModel } from '@/types/api'

export function ProjectChatAgentsSection({
  project,
  projectChatAgentApi,
  deviceApi,
  modelApi,
  localProjects,
  canManage,
}: {
  project: CloudProject
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
  localProjects: ProjectWithTasks[]
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
        // Model options are optional; the form still shows the default and the
        // currently configured model even when the list is unavailable.
        if (active) setAvailableModels([])
      })
    return () => {
      active = false
    }
  }, [modelApi])

  const activeChatAgents = chatAgents.filter(agent => agent.status === 'active')

  function openCreateChatAgent() {
    setCreatingChatAgent(true)
    setEditingChatAgent(null)
    setAgentName(t('workbench.project_chat_new_agent'))
    setAgentModel('')
    setAgentSystemPrompt('')
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
    setEditingChatAgent(agent)
    setAgentName(agent.name)
    setAgentModel(agent.model ?? '')
    setAgentSystemPrompt(agent.systemPrompt)
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
      !agentExecutionDeviceId ||
      (!creatingChatAgent && !editingChatAgent)
    )
      return
    setAgentBusy(true)
    try {
      if (creatingChatAgent) {
        const agent = await projectChatAgentApi.create(project.id, {
          name: agentName.trim(),
          runtime: 'codex',
          model: agentModel.trim() || null,
          systemPrompt: agentSystemPrompt,
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
          model: agentModel.trim() || null,
          systemPrompt: agentSystemPrompt,
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
    <section data-testid="cloud-project-chat-agents">
      <div className="flex items-start justify-between gap-4">
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
            onClick={openCreateChatAgent}
            className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> {t('workbench.project_chat_agents_add')}
          </button>
        ) : null}
      </div>
      <div className="mt-4 space-y-1 rounded-xl bg-muted p-1.5">
        {activeChatAgents.length === 0 ? (
          <div className="flex h-14 items-center justify-center text-sm text-text-muted">
            {t('workbench.project_chat_agents_empty')}
          </div>
        ) : (
          activeChatAgents.map(agent => (
            <div
              key={agent.id}
              data-testid={`cloud-project-chat-agent-${agent.id}`}
              className="flex items-center gap-3 rounded-lg bg-background/70 px-3 py-2"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-500/10 text-violet-600">
                <Bot className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{agent.name}</span>
                <span className="block truncate text-xs text-text-muted">
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
              </span>
              {canManage ? (
                <>
                  <button
                    type="button"
                    data-testid={`cloud-project-chat-agent-edit-${agent.id}`}
                    disabled={agentBusy}
                    onClick={() => editChatAgent(agent)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
                    aria-label={t('workbench.project_chat_agents_edit', { name: agent.name })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    data-testid={`cloud-project-chat-agent-remove-${agent.id}`}
                    disabled={agentBusy}
                    onClick={() => void archiveChatAgent(agent)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
                    aria-label={t('workbench.project_chat_agents_remove', { name: agent.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          ))
        )}
      </div>
      {canManage && (creatingChatAgent || editingChatAgent) ? (
        <div className="mt-3 space-y-2 rounded-xl border border-border bg-background p-3">
          <h3 className="text-sm font-semibold">
            {creatingChatAgent
              ? t('workbench.project_chat_agents_add')
              : t('workbench.project_chat_agents_edit', {
                  name: editingChatAgent?.name ?? '',
                })}
          </h3>
          <input
            data-testid="cloud-project-chat-agent-name"
            value={agentName}
            onChange={event => setAgentName(event.target.value)}
            placeholder={t('workbench.project_chat_agent_name')}
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
          />
          <select
            data-testid="cloud-project-chat-agent-model"
            value={agentModel}
            onChange={event => setAgentModel(event.target.value)}
            aria-label={t('workbench.project_chat_agent_model')}
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
          >
            <option value="">{t('workbench.project_chat_agent_model_default')}</option>
            {agentModel && !availableModels.some(model => model.name === agentModel) ? (
              <option value={agentModel}>{agentModel}</option>
            ) : null}
            {availableModels.map(model => (
              <option key={model.name} value={model.name}>
                {model.displayName ?? model.name}
              </option>
            ))}
          </select>
          <textarea
            data-testid="cloud-project-chat-agent-system-prompt"
            value={agentSystemPrompt}
            onChange={event => setAgentSystemPrompt(event.target.value)}
            placeholder={t('workbench.project_chat_agent_prompt')}
            rows={3}
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">
                {t('workbench.project_chat_agent_visibility')}
              </span>
              <select
                data-testid="cloud-project-chat-agent-visibility"
                value={agentVisibility}
                onChange={event =>
                  setAgentVisibility(event.target.value as ProjectChatAgent['visibility'])
                }
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
              >
                <option value="private">
                  {t('workbench.project_chat_agent_visibility_private')}
                </option>
                <option value="creator_admin">
                  {t('workbench.project_chat_agent_visibility_creator_admin')}
                </option>
                <option value="public">
                  {t('workbench.project_chat_agent_visibility_public')}
                </option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">
                {t('workbench.project_chat_agent_environment')}
              </span>
              <select
                data-testid="cloud-project-chat-agent-environment"
                value={agentExecutionEnvironment}
                onChange={event => {
                  const next = event.target.value as ProjectChatAgent['executionEnvironment']
                  if (localProjectOnly && next !== 'local') return
                  setAgentExecutionEnvironment(next)
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
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
              >
                <option value="local">{t('workbench.project_chat_agent_env_local')}</option>
                {!localProjectOnly ? (
                  <option value="cloud">{t('workbench.project_chat_agent_env_cloud')}</option>
                ) : null}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">
                {t('workbench.project_chat_agent_mode')}
              </span>
              <select
                data-testid="cloud-project-chat-agent-mode"
                value={agentExecutionMode}
                onChange={event =>
                  setAgentExecutionMode(event.target.value as ProjectChatAgent['executionMode'])
                }
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
              >
                <option value="auto">{t('workbench.project_chat_agent_mode_auto')}</option>
                <option value="manual_approval">
                  {t('workbench.project_chat_agent_mode_manual')}
                </option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">
              {t('workbench.project_chat_agent_device')}
            </span>
            <select
              data-testid="cloud-project-chat-agent-device"
              value={agentExecutionDeviceId}
              onChange={event => setAgentExecutionDeviceId(event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
            >
              <option value="">{t('workbench.project_chat_agent_device_select')}</option>
              {availableDevices
                .filter(device =>
                  agentExecutionEnvironment === 'local'
                    ? device.device_type === 'local' || device.device_type === 'app'
                    : device.device_type === 'cloud' || device.device_type === 'remote'
                )
                .map(device => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.device_id}
                    {device.status ? `（${device.status}）` : ''}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">
              {t('workbench.project_chat_agent_execution_project')}
            </span>
            <select
              data-testid="cloud-project-chat-agent-execution-project"
              value={agentLocalProjectId}
              onChange={event =>
                setAgentLocalProjectId(event.target.value === '' ? '' : Number(event.target.value))
              }
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
            >
              <option value="">{t('workbench.project_chat_agent_execution_project_none')}</option>
              {localProjects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCreatingChatAgent(false)
                setEditingChatAgent(null)
              }}
              className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="cloud-project-chat-agent-save"
              disabled={agentBusy || !agentName.trim() || !agentExecutionDeviceId}
              onClick={() => void saveChatAgent()}
              className="h-8 rounded-lg bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
            >
              {t('workbench.project_chat_agent_save')}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
