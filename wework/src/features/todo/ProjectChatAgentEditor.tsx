import { createAgentResourceSaveOperation } from '@/features/collaboration/agentResourceSaveOperation'
import {
  AgentEnvironmentFields,
  AgentModelFields,
} from '@/features/collaboration/AgentRoutingFields'
import { useAgentRouting } from '@/features/collaboration/useAgentRouting'
import { useAgentRuntimeSettings } from '@/features/collaboration/useAgentRuntimeSettings'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import {
  AgentCapabilitiesSelector,
  AgentCapabilityModeSelector,
  AgentFormDialog,
  AgentPromptEditor,
  agentPluginBinding,
  createAgentResourceName,
  resolveAgentPromptCapabilityReferences,
  type UnifiedAgentCapabilityMode,
} from '@wegent/collaboration'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useMemo, useState, useSyncExternalStore } from 'react'

import type { UnifiedAgentDefinition, UnifiedAgentPluginRef } from '@/api/agentDefinition'
import type { createAgentResourceApi } from '@/api/agentResources'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import type {
  LocalProjectChatAgent,
  LocalProjectChatAgentModel,
  createLocalProjectChatAgentApi,
} from '@/api/local/localDelivery'
import { parseAgentMcpServers } from '@/features/collaboration/agentFormModel'
import { isDefaultLocalAgentName } from '@/features/collaboration/defaultLocalAgent'
import { useCurrentAgentDevice } from '@/features/collaboration/useCurrentAgentDevice'
import type {
  ProjectPluginCatalogApi,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'
import type { ModelType, UnifiedSkill } from '@/types/api'

export type ProjectChatAgentEditorApi = Pick<
  ReturnType<typeof createLocalProjectChatAgentApi>,
  'list' | 'create' | 'update' | 'listEnvironments' | 'listNativeModels' | 'listModels'
>
type SkillApi = Pick<ReturnType<typeof createAgentResourceApi>, 'listSkills'>

interface EditorModelOption {
  name: string
  displayName?: string
  namespace?: string
  type?: ModelType
}
const EMPTY_MODELS: EditorModelOption[] = []
const EMPTY_SKILLS: UnifiedSkill[] = []
const EMPTY_PLUGINS: UnifiedAgentPluginRef[] = []
const EMPTY_SKILL_REFS: UnifiedAgentDefinition['skills'] = []

function skillKey(skill: { name: string; namespace?: string }): string {
  return `${skill.namespace || 'default'}:${skill.name}`
}

function storedSkillKeys(skills: unknown[] | undefined): string[] {
  if (!skills) return []
  return skills.flatMap(skill => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return []
    const record = skill as Record<string, unknown>
    if (typeof record.name !== 'string' || !record.name) return []
    const namespace =
      typeof record.namespace === 'string' && record.namespace ? record.namespace : 'default'
    return [`${namespace}:${record.name}`]
  })
}

function modelKey(model: LocalProjectChatAgentModel): string {
  return `${model.type ?? ''}:${model.namespace ?? 'default'}:${model.name}`
}

type ProjectChatAgentEditorProps = {
  api: ProjectChatAgentEditorApi
  deviceApi?: Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>
  editingAgentId?: string
  modelApi: WorkbenchServices['modelApi']
  pluginApi?: ProjectPluginCatalogApi
  projectId?: string
  skillApi?: SkillApi
  onClose(): void
  onSaved(agentId: string): Promise<void>
  ownerLabel?: string
}

export function ProjectChatAgentEditor(props: ProjectChatAgentEditorProps) {
  const [owner, setOwner] = useState({ api: props.api, revision: 0 })
  if (owner.api !== props.api) setOwner({ api: props.api, revision: owner.revision + 1 })
  return (
    <ProjectChatAgentEditorContent
      key={JSON.stringify([
        owner.revision,
        props.projectId ?? DEFAULT_WORK_ITEM_PROJECT_ID,
        props.editingAgentId,
      ])}
      {...props}
    />
  )
}

function ProjectChatAgentEditorContent({
  api,
  deviceApi,
  editingAgentId,
  modelApi,
  pluginApi,
  projectId = DEFAULT_WORK_ITEM_PROJECT_ID,
  skillApi,
  onClose,
  onSaved,
  ownerLabel,
}: ProjectChatAgentEditorProps) {
  const { t } = useTranslation('common')
  const editing = Boolean(editingAgentId)
  const [name, setName] = useState(createAgentResourceName)
  const [displayName, setDisplayName] = useState('')
  const [namespace, setNamespace] = useState('default')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [model, setModel] = useState('')
  const [modelType, setModelType] = useState<ModelType | undefined>()
  const [modelNamespace, setModelNamespace] = useState('default')
  const [allowedModels, setAllowedModels] = useState<LocalProjectChatAgentModel[]>([])
  const [runtime, setRuntime] = useState<LocalProjectChatAgent['runtime']>('codex')
  const routing = useAgentRouting(api, runtime, projectId, {
    defer: true,
    creation: !editing,
  })
  const runtimeSettings = useAgentRuntimeSettings(routing)
  const loadRouting = routing.load
  const [selectedCapabilityMode, setCapabilityMode] =
    useState<UnifiedAgentCapabilityMode>('follow_device')
  const [mcpConfig, setMcpConfig] = useState('{}')
  const [skillBindings, setSkillBindings] =
    useState<UnifiedAgentDefinition['skills']>(EMPTY_SKILL_REFS)
  const selectedSkillKeys = useMemo(() => storedSkillKeys(skillBindings), [skillBindings])
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([])
  const [capabilitiesActive, setCapabilitiesActive] = useState(false)
  const [saveOperation] = useState(createAgentResourceSaveOperation)
  const { saving: busy, error: saveError } = useSyncExternalStore(
    saveOperation.subscribe,
    saveOperation.getSnapshot,
    saveOperation.getSnapshot
  )
  const setError = saveOperation.setError
  const deviceState = useCurrentAgentDevice(deviceApi, pluginApi, capabilitiesActive)
  const defaultDeviceAgent = isDefaultLocalAgentName(name)
  const preserveRouting = editing && !routing.changed && !defaultDeviceAgent
  const routingReady = preserveRouting || routing.valid
  const [legacyConfig, setLegacyConfig] = useState<{
    capabilityDescription: string
    maxConcurrentExecutions: number
    version: number
    visibility: LocalProjectChatAgent['visibility']
  }>({
    capabilityDescription: '',
    maxConcurrentExecutions: 1,
    version: 1,
    visibility: 'creator_admin',
  })

  const modelsResource = useMemo(
    () =>
      createAsyncResource('project-agent-models', async () => {
        const response = await modelApi.listModels()
        return response.data.filter(isSupportedModelFamily).map(item => ({
          name: item.name,
          displayName: item.displayName ?? undefined,
          namespace: item.namespace,
          type: item.type,
        }))
      }),
    [modelApi]
  )
  const skillsResource = useMemo(
    () =>
      skillApi
        ? createAsyncResource('project-agent-skills', async () =>
            (await skillApi.listSkills()).filter(skill => skill.visible !== false)
          )
        : null,
    [skillApi]
  )
  const pluginsResource = useMemo(
    () =>
      pluginApi
        ? createAsyncResource('project-agent-plugins', () => pluginApi.listPlugins(''))
        : null,
    [pluginApi]
  )
  const agentResource = useMemo(
    () =>
      editingAgentId
        ? createAsyncResource(
            JSON.stringify([projectId, editingAgentId]),
            async () =>
              (await api.list(projectId)).find(candidate => candidate.id === editingAgentId) ?? null
          )
        : null,
    [api, editingAgentId, projectId]
  )
  const modelSnapshot = useSyncExternalStore(
    defaultDeviceAgent && routing.activated ? modelsResource.subscribe : subscribeIdleResource,
    modelsResource.getSnapshot,
    modelsResource.getSnapshot
  )
  const skillSnapshot = useSyncExternalStore(
    capabilitiesActive && skillsResource ? skillsResource.subscribe : subscribeIdleResource,
    skillsResource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const pluginSnapshot = useSyncExternalStore(
    capabilitiesActive && pluginsResource ? pluginsResource.subscribe : subscribeIdleResource,
    pluginsResource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const agentSnapshot = useSyncExternalStore(
    agentResource?.subscribe ?? subscribeIdleResource,
    agentResource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const models = modelSnapshot.data ?? EMPTY_MODELS
  const skills = skillSnapshot.data ?? EMPTY_SKILLS
  const detail = agentSnapshot.data
  const plugins = useMemo(() => {
    const merged = new Map(
      (pluginSnapshot.data ?? EMPTY_PLUGINS).map(plugin => [plugin.id, plugin])
    )
    detail?.plugins.forEach(plugin => merged.set(plugin.id, merged.get(plugin.id) ?? plugin))
    return [...merged.values()]
  }, [pluginSnapshot.data, detail])
  const loadingSkills = Boolean(skillsResource && !skillSnapshot.settled)
  const loadingPlugins = Boolean(pluginsResource && !pluginSnapshot.settled)
  const loadingAgent = Boolean(agentResource && !agentSnapshot.settled)
  const skillLoadError =
    skillSnapshot.status === 'error'
      ? skillSnapshot.error instanceof Error
        ? skillSnapshot.error.message
        : String(skillSnapshot.error)
      : null
  const pluginLoadError =
    pluginSnapshot.status === 'error'
      ? pluginSnapshot.error instanceof Error
        ? pluginSnapshot.error.message
        : t('workbench.agent_creator_plugins_load_failed', '加载插件失败')
      : null
  const detailError =
    agentSnapshot.status === 'error'
      ? agentSnapshot.error instanceof Error
        ? agentSnapshot.error.message
        : t('workbench.project_chat_agents_load_failed')
      : editing && agentSnapshot.settled && !detail
        ? t('workbench.project_chat_agent_unavailable')
        : null
  const error = saveError || detailError
  const [initializedAgent, setInitializedAgent] = useState<LocalProjectChatAgent | null>(null)
  if (detail && initializedAgent !== detail) {
    setInitializedAgent(detail)
    setName(detail.name)
    setDisplayName(detail.displayName || detail.name)
    setNamespace(detail.namespace || 'default')
    setSystemPrompt(detail.systemPrompt)
    setModel(detail.model ?? '')
    setModelType(detail.modelType ?? undefined)
    setModelNamespace(detail.modelNamespace || 'default')
    setAllowedModels(
      detail.allowedModels ??
        (detail.model
          ? [{ name: detail.model, type: detail.modelType, namespace: detail.modelNamespace }]
          : [])
    )
    setRuntime(detail.runtime)
    loadRouting(detail.executionPolicy, detail.modelPolicy)
    setCapabilityMode(detail.capabilityMode)
    setMcpConfig(JSON.stringify(detail.mcpServers ?? {}, null, 2))
    setSkillBindings(detail.additionalSkills)
    setSelectedPluginIds(detail.plugins.map(plugin => plugin.id))
    setLegacyConfig({
      capabilityDescription: detail.capabilityDescription,
      maxConcurrentExecutions: detail.maxConcurrentExecutions,
      version: detail.version,
      visibility: detail.visibility,
    })
  }

  const selectedSkillSet = useMemo(() => new Set(selectedSkillKeys), [selectedSkillKeys])
  const selectedPluginSet = useMemo(() => new Set(selectedPluginIds), [selectedPluginIds])
  const promptCapabilities = useMemo(
    () => resolveAgentPromptCapabilityReferences(systemPrompt, plugins, skills),
    [plugins, skills, systemPrompt]
  )
  const capabilityMode =
    promptCapabilities.pluginIds.size || promptCapabilities.skillKeys.size
      ? 'manual'
      : selectedCapabilityMode
  const effectiveSelectedPluginSet = useMemo(
    () => new Set([...selectedPluginSet, ...promptCapabilities.pluginIds]),
    [promptCapabilities.pluginIds, selectedPluginSet]
  )
  const effectiveSelectedSkillSet = useMemo(
    () => new Set([...selectedSkillSet, ...promptCapabilities.skillKeys]),
    [promptCapabilities.skillKeys, selectedSkillSet]
  )
  const selectedAllowedModelKeys = useMemo(
    () => new Set(allowedModels.map(modelKey)),
    [allowedModels]
  )
  const availableModelKeys = useMemo(
    () =>
      new Set(
        models.map(candidate =>
          modelKey({
            name: candidate.name,
            type: candidate.type,
            namespace: candidate.namespace || 'default',
          })
        )
      ),
    [models]
  )
  const unavailableAllowedModels = useMemo(
    () => allowedModels.filter(candidate => !availableModelKeys.has(modelKey(candidate))),
    [allowedModels, availableModelKeys]
  )

  const save = async () => {
    if (busy || loadingAgent || (editing && !detail)) return
    if (defaultDeviceAgent ? allowedModels.length === 0 : !routingReady) {
      setError(t('workbench.agent_creator_model_required', '请选择模型'))
      return
    }
    let mcpServers: Record<string, unknown> = {}
    try {
      if (capabilityMode === 'manual') {
        mcpServers = parseAgentMcpServers(mcpConfig)
      }
    } catch {
      setError(t('workbench.agent_creator_mcp_invalid', 'MCP 配置必须是有效的 JSON 对象'))
      return
    }
    const token = saveOperation.begin()
    if (!token) return
    try {
      const primaryModel = defaultDeviceAgent ? allowedModels[0] : null
      const definition: UnifiedAgentDefinition = {
        name,
        displayName: displayName.trim(),
        namespace,
        capabilityMode,
        runtime: runtime === 'claude_code' ? 'ClaudeCode' : 'Codex',
        model: {
          name: primaryModel?.name ?? model,
          type: primaryModel?.type ?? modelType,
          namespace: primaryModel?.namespace ?? modelNamespace,
        },
        systemPrompt,
        skills:
          capabilityMode === 'manual'
            ? !capabilitiesActive || !skillsResource
              ? skillBindings
              : skills
                  .filter(skill => effectiveSelectedSkillSet.has(skillKey(skill)))
                  .map(skill => ({
                    skillId: skill.id,
                    name: skill.name,
                    namespace: skill.namespace || 'default',
                    isPublic: skill.is_public,
                  }))
            : [],
        plugins:
          capabilityMode === 'manual' && runtime === 'codex'
            ? plugins
                .filter(plugin => effectiveSelectedPluginSet.has(plugin.id))
                .map(agentPluginBinding)
            : [],
        mcpServers,
      }
      const modelConfiguration = preserveRouting
        ? {}
        : {
            executionPolicy: defaultDeviceAgent
              ? undefined
              : (routing.executionPolicy ?? undefined),
            modelPolicy: defaultDeviceAgent ? undefined : (routing.modelPolicy ?? undefined),
            model: defaultDeviceAgent
              ? definition.model.name
              : (routing.model?.cloud_model?.name ?? routing.model?.model_id ?? null),
            modelType: defaultDeviceAgent
              ? definition.model.type
              : (routing.model?.cloud_model?.type ?? 'runtime'),
            modelNamespace: defaultDeviceAgent
              ? definition.model.namespace
              : (routing.model?.cloud_model?.namespace ?? 'default'),
            allowedModels: defaultDeviceAgent ? allowedModels : [definition.model],
          }
      const input = {
        ...modelConfiguration,
        name: definition.name,
        displayName: definition.displayName,
        namespace: definition.namespace,
        runtime,
        capabilityDescription: legacyConfig.capabilityDescription,
        capabilityMode: definition.capabilityMode,
        systemPrompt: definition.systemPrompt,
        additionalSkills: definition.skills,
        mcpServers: definition.mcpServers,
        visibility: legacyConfig.visibility,
        executionEnvironment: 'local' as const,
        executionMode: 'auto' as const,
        executionDeviceId: null,
        maxConcurrentExecutions: legacyConfig.maxConcurrentExecutions,
        plugins: definition.plugins,
      }
      const saved = editingAgentId
        ? await api.update(projectId, editingAgentId, { version: legacyConfig.version, ...input })
        : await api.create(projectId, input)
      if (!saveOperation.owns(token)) return
      await onSaved(saved.id)
    } catch (cause) {
      if (!saveOperation.owns(token)) return
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_chat_agents_save_failed')
      )
    } finally {
      saveOperation.finish(token)
    }
  }

  return (
    <AgentFormDialog
      onAdvancedOpen={() => setCapabilitiesActive(true)}
      runtimeSettings={
        defaultDeviceAgent
          ? {
              ...runtimeSettings,
              environment: undefined,
              model: {
                label: t('workbench.project_chat_agent_allowed_models'),
                value: t('workbench.agent_creator_allowed_models_summary', {
                  count: allowedModels.length,
                }),
              },
              error: null,
            }
          : runtimeSettings
      }
      advancedSummary={{
        description:
          capabilityMode === 'follow_device'
            ? t(
                'workbench.agent_creator_follow_device_description',
                '运行时自动使用执行设备上当前用户已有的插件、Skill、MCP 和本地操作能力。'
              )
            : t(
                'workbench.agent_creator_manual_description',
                '将所选插件、Skill 和 MCP 保存到智能体，运行前自动同步到执行设备。'
              ),
        title:
          capabilityMode === 'follow_device'
            ? t('workbench.agent_creator_follow_device_summary', '使用环境能力')
            : t('workbench.agent_creator_manual_summary', '自定义能力'),
      }}
      busy={busy}
      capabilities={
        capabilityMode === 'manual' ? (
          <AgentCapabilitiesSelector
            busy={busy || loadingAgent}
            collapsible={false}
            loadingPlugins={loadingPlugins}
            loadingSkills={loadingSkills}
            onPluginChange={(pluginId, selected) =>
              setSelectedPluginIds(current =>
                selected ? [...current, pluginId] : current.filter(id => id !== pluginId)
              )
            }
            onSkillChange={(skill, selected) => {
              const key = skillKey(skill)
              const entry = skills.find(candidate => skillKey(candidate) === key)
              if (selected && !entry) return
              setSkillBindings(current => {
                const remaining = current.filter(candidate => skillKey(candidate) !== key)
                return selected && entry
                  ? [
                      ...remaining,
                      {
                        skillId: entry.id,
                        name: entry.name,
                        namespace: entry.namespace || 'default',
                        isPublic: entry.is_public,
                      },
                    ]
                  : remaining
              })
            }}
            pluginError={pluginLoadError}
            pluginsEnabled={runtime === 'codex'}
            plugins={plugins}
            selectedPluginIds={effectiveSelectedPluginSet}
            selectedSkillKeys={effectiveSelectedSkillSet}
            requiredPluginIds={promptCapabilities.pluginIds}
            requiredSkillKeys={promptCapabilities.skillKeys}
            skillKey={skillKey}
            skills={skills}
            testIdPrefix="cloud-project-chat-agent"
            title={t('workbench.agent_creator_configured_capabilities', '随智能体配置')}
            labels={{
              add: t('workbench.agent_creator_add', '添加'),
              loadingPlugins: t('workbench.agent_creator_plugins_loading', '正在加载插件…'),
              loadingSkills: t('workbench.agent_creator_skills_loading', '正在加载 Skill…'),
              noneSelected: t('workbench.agent_creator_none_selected', '暂未添加'),
              noPlugins: t('workbench.agent_creator_no_plugins', '当前没有可用插件'),
              noSkills: t('workbench.agent_creator_no_skills', '当前执行器没有可用 Skill'),
              plugins: t('workbench.agent_creator_plugins', '插件'),
              pluginsUnavailable: t(
                'workbench.agent_creator_plugins_codex_only',
                '插件目前仅支持 Codex 执行器'
              ),
              remove: t('workbench.agent_creator_remove', '移除'),
              fromPrompt: t('workbench.agent_creator_from_prompt', '来自提示词'),
              sourceCloud: t('workbench.agent_creator_source_cloud', '云端'),
              sourceLocal: t('workbench.agent_creator_source_local', '本机'),
              sourceLocalCloud: t('workbench.agent_creator_source_local_cloud', '本机与云端'),
              searchPlugins: t('workbench.agent_creator_search_plugins', '搜索插件'),
              searchSkills: t('workbench.agent_creator_search_skills', '搜索 Skill'),
              skills: 'Skill',
            }}
          />
        ) : null
      }
      description={
        editing
          ? t('workbench.agent_editor_description', '修改执行环境、模型和提示词。')
          : t('workbench.agent_creator_description', '定义智能体的职责，按需调整运行设置。')
      }
      displayName={{
        label: t('workbench.agent_creator_display_name', '智能体名称'),
        onChange: setDisplayName,
        placeholder: t('workbench.agent_creator_display_name_placeholder', '代码评审'),
        testId: 'cloud-project-chat-agent-display-name',
        value: displayName,
      }}
      error={error}
      executionControl={
        defaultDeviceAgent ? undefined : (
          <AgentEnvironmentFields
            routing={routing}
            disabled={busy || loadingAgent}
            prefix="cloud-project-chat-agent"
          />
        )
      }
      capabilityMode={
        <AgentCapabilityModeSelector
          busy={busy || loadingAgent}
          capabilityItems={deviceState.capabilityItems}
          capabilitySummary={deviceState.capabilitySummary}
          currentDevice={deviceState.currentDevice}
          labels={{
            devicePreviewHint: t(
              'workbench.agent_creator_device_preview_hint',
              '实际能力以任务运行设备为准，换设备后可能不同。'
            ),
            devicePreviewTitle: t('workbench.agent_creator_device_preview_title', '当前设备预览'),
            devicePreviewUnavailable: t(
              'workbench.agent_creator_device_preview_unavailable',
              '将在任务运行时读取设备能力'
            ),
            followDescription: t(
              'workbench.agent_creator_follow_device_description',
              '运行时自动使用执行设备上当前用户已有的插件、Skill、MCP 和本地操作能力。'
            ),
            followTitle: t('workbench.agent_creator_follow_device_title', '跟随运行设备（推荐）'),
            loadingCapabilities: t(
              'workbench.agent_creator_loading_device_capabilities',
              '正在读取设备能力…'
            ),
            manualDescription: t(
              'workbench.agent_creator_manual_description',
              '将所选插件、Skill 和 MCP 保存到智能体，运行前自动同步到执行设备。'
            ),
            manualReady: t(
              'workbench.agent_creator_manual_ready',
              '系统会确保执行设备具备以下能力后再开始任务。'
            ),
            manualTitle: t('workbench.agent_creator_manual_title', '固定智能体能力'),
            title: t('workbench.agent_creator_capability_source', '能力来源'),
          }}
          loadingCapabilities={deviceState.loading}
          onChange={setCapabilityMode}
          testIdPrefix="cloud-project-chat-agent"
          value={capabilityMode}
        />
      }
      labels={{
        advanced: t('workbench.agent_creator_advanced', '高级设置'),
        advancedDescription: t(
          'workbench.agent_creator_advanced_description',
          'MCP 与其他运行参数'
        ),
        cancel: t('workbench.cancel', '取消'),
        close: t('workbench.close', '关闭'),
        owner: t('workbench.agent_creator_owner', '保存位置'),
      }}
      loading={loadingAgent}
      loadingLabel={t('workbench.agent_editor_loading', '正在加载智能体配置…')}
      mcp={
        capabilityMode === 'manual'
          ? {
              label: 'MCP',
              onChange: setMcpConfig,
              placeholder: '{"server":{"command":"node","args":["server.mjs"]}}',
              testId: 'cloud-project-chat-agent-mcp',
              value: mcpConfig,
            }
          : undefined
      }
      modelControl={
        defaultDeviceAgent ? (
          <fieldset
            className="space-y-2 rounded-lg border border-border p-3"
            data-testid="cloud-project-chat-agent-models"
            disabled={busy || loadingAgent}
          >
            <legend className="px-1 text-sm text-text-secondary">
              {t('workbench.project_chat_agent_allowed_models', '可用模型')}
            </legend>
            <p className="text-xs text-text-muted">
              {t(
                'workbench.project_chat_agent_allowed_models_description',
                '负责人 AI 会根据任务，从这里预先配置的模型中选择。'
              )}
            </p>
            {routing.activated && !modelSnapshot.settled && (
              <p role="status">{t('workbench.local_model_loading_models_action')}</p>
            )}
            {modelSnapshot.status === 'error' && (
              <div role="alert" className="text-sm text-destructive">
                <p>
                  {modelSnapshot.error instanceof Error
                    ? modelSnapshot.error.message
                    : t('workbench.agent_creator_models_load_failed', '加载模型失败')}
                </p>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-project-chat-agent-models-retry"
                  className="min-h-11 underline md:min-h-8"
                  onClick={() => void modelsResource.reload()}
                >
                  {t('workbench.retry')}
                </ControlButton>
              </div>
            )}
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {models.map(candidate => {
                const value = {
                  name: candidate.name,
                  type: candidate.type,
                  namespace: candidate.namespace || 'default',
                }
                const key = modelKey(value)
                return (
                  <label
                    className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm text-text-primary hover:bg-muted"
                    key={key}
                  >
                    <Checkbox
                      checked={selectedAllowedModelKeys.has(key)}
                      data-testid={`cloud-project-chat-agent-model-${candidate.name}`}
                      onCheckedChange={checked =>
                        setAllowedModels(current =>
                          checked === true
                            ? [...current, value]
                            : current.filter(item => modelKey(item) !== key)
                        )
                      }
                    />
                    <span>{candidate.displayName || candidate.name}</span>
                  </label>
                )
              })}
              {unavailableAllowedModels.map(candidate => {
                const key = modelKey(candidate)
                return (
                  <div
                    className="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-sm text-text-muted"
                    data-testid={`cloud-project-chat-agent-model-unavailable-${candidate.name}`}
                    key={key}
                  >
                    <span>
                      {candidate.name}
                      {modelSnapshot.status === 'ready' &&
                        t('workbench.project_chat_agent_model_unavailable', '（当前不可用）')}
                    </span>
                    <ControlButton
                      variant="unstyled"
                      aria-label={`${t(
                        'workbench.project_chat_agent_remove_model',
                        '移除模型'
                      )} ${candidate.name}`}
                      className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                      data-testid={`cloud-project-chat-agent-model-remove-${candidate.name}`}
                      onClick={() =>
                        setAllowedModels(current => current.filter(item => modelKey(item) !== key))
                      }
                      type="button"
                    >
                      {t('workbench.agent_creator_remove', '移除')}
                    </ControlButton>
                  </div>
                )
              })}
            </div>
          </fieldset>
        ) : (
          <AgentModelFields
            routing={routing}
            disabled={busy || loadingAgent}
            prefix="cloud-project-chat-agent"
          />
        )
      }
      namespace={namespace}
      onClose={onClose}
      onSave={() => void save()}
      ownerLabel={ownerLabel ?? t('workbench.project_chat_agent_env_local')}
      prompt={{
        label: t('workbench.agent_creator_prompt', '提示词'),
        onChange: value => {
          setSystemPrompt(value)
          const references = resolveAgentPromptCapabilityReferences(value, plugins, skills)
          if (references.pluginIds.size || references.skillKeys.size) setCapabilityMode('manual')
        },
        placeholder: t(
          'workbench.agent_creator_prompt_placeholder',
          '定义智能体职责、约束和输出要求'
        ),
        testId: 'cloud-project-chat-agent-system-prompt',
        value: systemPrompt,
      }}
      promptEditor={
        <AgentPromptEditor
          onFocus={() => setCapabilitiesActive(true)}
          busy={busy || loadingAgent}
          field={{
            label: t('workbench.agent_creator_prompt', '提示词'),
            onChange: value => {
              setSystemPrompt(value)
              const references = resolveAgentPromptCapabilityReferences(value, plugins, skills)
              if (references.pluginIds.size || references.skillKeys.size)
                setCapabilityMode('manual')
            },
            placeholder: t(
              'workbench.agent_creator_prompt_placeholder',
              '定义智能体职责、约束和输出要求'
            ),
            testId: 'cloud-project-chat-agent-system-prompt',
            value: systemPrompt,
          }}
          plugins={plugins}
          skills={skills}
          translate={(key, fallback, options) =>
            String(t(key, { ...options, defaultValue: fallback ?? key }))
          }
        />
      }
      saveDisabled={
        loadingAgent ||
        (editing && !detail) ||
        (defaultDeviceAgent ? allowedModels.length === 0 : !routingReady) ||
        (capabilityMode === 'manual' &&
          capabilitiesActive &&
          (loadingSkills || loadingPlugins || Boolean(skillLoadError || pluginLoadError)))
      }
      saveLabel={
        editing
          ? t('workbench.agent_editor_save', '保存')
          : t('workbench.agent_creator_create', '创建智能体')
      }
      savingLabel={
        editing
          ? t('workbench.agent_editor_saving', '保存中…')
          : t('workbench.agent_creator_creating', '创建中…')
      }
      testIds={{
        backdrop: 'cloud-project-chat-agent-backdrop',
        close: 'cloud-project-chat-agent-cancel',
        dialog: 'cloud-project-chat-agent-editor',
        error: 'cloud-project-chat-agent-error',
        save: 'cloud-project-chat-agent-save',
      }}
      title={
        editing
          ? t('workbench.agent_editor_title', '编辑智能体')
          : t('workbench.agent_creator_title', '新建智能体')
      }
    />
  )
}
