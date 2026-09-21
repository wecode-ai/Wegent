import { useEffect, useMemo, useState } from 'react'
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

import type { UnifiedAgentDefinition, UnifiedAgentPluginRef } from '@/api/agentDefinition'
import type { createAgentResourceApi } from '@/api/agentResources'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import type {
  LocalProjectChatAgent,
  createLocalProjectChatAgentApi,
} from '@/api/local/localDelivery'
import { parseAgentMcpServers } from '@/features/collaboration/agentFormModel'
import { useCurrentAgentDevice } from '@/features/collaboration/useCurrentAgentDevice'
import type {
  ProjectPluginCatalogApi,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'
import type { ModelType, UnifiedSkill } from '@/types/api'

type LocalAgentApi = ReturnType<typeof createLocalProjectChatAgentApi>
type SkillApi = Pick<ReturnType<typeof createAgentResourceApi>, 'listSkills'>

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

export function ProjectChatAgentEditor({
  api,
  deviceApi,
  editingAgentId,
  modelApi,
  pluginApi,
  projectId = DEFAULT_WORK_ITEM_PROJECT_ID,
  skillApi,
  onClose,
  onSaved,
}: {
  api: LocalAgentApi
  deviceApi?: Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>
  editingAgentId?: string
  modelApi: WorkbenchServices['modelApi']
  pluginApi?: ProjectPluginCatalogApi
  projectId?: string
  skillApi?: SkillApi
  onClose(): void
  onSaved(): Promise<void>
}) {
  const { t } = useTranslation('common')
  const editing = Boolean(editingAgentId)
  const [name, setName] = useState(createAgentResourceName)
  const [displayName, setDisplayName] = useState('')
  const [namespace, setNamespace] = useState('default')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [model, setModel] = useState('')
  const [modelType, setModelType] = useState<ModelType | undefined>()
  const [modelNamespace, setModelNamespace] = useState('default')
  const [runtime, setRuntime] = useState<LocalProjectChatAgent['runtime']>('codex')
  const [capabilityMode, setCapabilityMode] = useState<UnifiedAgentCapabilityMode>('follow_device')
  const [mcpConfig, setMcpConfig] = useState('{}')
  const [models, setModels] = useState<
    Array<{
      name: string
      displayName?: string
      namespace?: string
      type?: ModelType
    }>
  >([])
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([])
  const [plugins, setPlugins] = useState<UnifiedAgentPluginRef[]>([])
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([])
  const [loadingSkills, setLoadingSkills] = useState(Boolean(skillApi))
  const [loadingPlugins, setLoadingPlugins] = useState(Boolean(pluginApi))
  const [pluginLoadError, setPluginLoadError] = useState<string | null>(null)
  const [loadingAgent, setLoadingAgent] = useState(editing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deviceState = useCurrentAgentDevice(deviceApi, pluginApi)
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

  useEffect(() => {
    let active = true
    void modelApi
      .listModels()
      .then(response => {
        if (!active) return
        setModels(
          response.data.filter(isSupportedModelFamily).map(item => ({
            name: item.name,
            displayName: item.displayName ?? undefined,
            namespace: item.namespace,
            type: item.type,
          }))
        )
      })
      .catch(() => {
        if (active) setModels([])
      })

    if (skillApi) {
      void skillApi
        .listSkills()
        .then(items => {
          if (active) setSkills(items.filter(skill => skill.visible !== false))
        })
        .catch(() => {
          if (active) setSkills([])
        })
        .finally(() => {
          if (active) setLoadingSkills(false)
        })
    }

    if (pluginApi) {
      void pluginApi
        .listPlugins('')
        .then(items => {
          if (active) setPlugins(items)
        })
        .catch(cause => {
          if (!active) return
          setPluginLoadError(
            cause instanceof Error
              ? cause.message
              : t('workbench.agent_creator_plugins_load_failed', '加载插件失败')
          )
        })
        .finally(() => {
          if (active) setLoadingPlugins(false)
        })
    }

    if (editingAgentId) {
      void api
        .list(projectId)
        .then(agents => {
          if (!active) return
          const agent = agents.find(candidate => candidate.id === editingAgentId)
          if (!agent) {
            setError(t('workbench.project_chat_agent_unavailable'))
            return
          }
          setName(agent.name)
          setDisplayName(agent.displayName || agent.name)
          setNamespace(agent.namespace || 'default')
          setSystemPrompt(agent.systemPrompt)
          setModel(agent.model ?? '')
          setModelType(agent.modelType ?? undefined)
          setModelNamespace(agent.modelNamespace || 'default')
          setRuntime(agent.runtime)
          setCapabilityMode(agent.capabilityMode)
          setMcpConfig(JSON.stringify(agent.mcpServers ?? {}, null, 2))
          setSelectedSkillKeys(storedSkillKeys(agent.additionalSkills))
          setSelectedPluginIds(agent.plugins.map(plugin => plugin.id))
          setPlugins(current => {
            const merged = new Map(current.map(plugin => [plugin.id, plugin]))
            agent.plugins.forEach(plugin => merged.set(plugin.id, merged.get(plugin.id) ?? plugin))
            return [...merged.values()]
          })
          setLegacyConfig({
            capabilityDescription: agent.capabilityDescription,
            maxConcurrentExecutions: agent.maxConcurrentExecutions,
            version: agent.version,
            visibility: agent.visibility,
          })
        })
        .catch(cause => {
          if (active) {
            setError(
              cause instanceof Error
                ? cause.message
                : t('workbench.project_chat_agents_load_failed')
            )
          }
        })
        .finally(() => {
          if (active) setLoadingAgent(false)
        })
    }

    return () => {
      active = false
    }
  }, [api, editingAgentId, modelApi, pluginApi, projectId, skillApi, t])

  const selectedSkillSet = useMemo(() => new Set(selectedSkillKeys), [selectedSkillKeys])
  const selectedPluginSet = useMemo(() => new Set(selectedPluginIds), [selectedPluginIds])
  const promptCapabilities = useMemo(
    () => resolveAgentPromptCapabilityReferences(systemPrompt, plugins, skills),
    [plugins, skills, systemPrompt]
  )
  const effectiveSelectedPluginSet = useMemo(
    () => new Set([...selectedPluginSet, ...promptCapabilities.pluginIds]),
    [promptCapabilities.pluginIds, selectedPluginSet]
  )
  const effectiveSelectedSkillSet = useMemo(
    () => new Set([...selectedSkillSet, ...promptCapabilities.skillKeys]),
    [promptCapabilities.skillKeys, selectedSkillSet]
  )

  const save = async () => {
    if (busy) return
    if (!model) {
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
    setBusy(true)
    setError(null)
    try {
      const definition: UnifiedAgentDefinition = {
        name,
        displayName: displayName.trim(),
        namespace,
        capabilityMode,
        runtime: runtime === 'claude_code' ? 'ClaudeCode' : 'Codex',
        model: {
          name: model,
          type: modelType,
          namespace: modelNamespace,
        },
        systemPrompt,
        skills:
          capabilityMode === 'manual'
            ? skills
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
      const input = {
        name: definition.name,
        displayName: definition.displayName,
        namespace: definition.namespace,
        runtime,
        model: definition.model.name,
        modelType: definition.model.type,
        modelNamespace: definition.model.namespace,
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
        workspacePolicy: 'project' as const,
        plugins: definition.plugins,
      }
      if (editingAgentId) {
        await api.update(projectId, editingAgentId, {
          version: legacyConfig.version,
          ...input,
        })
      } else {
        await api.create(projectId, input)
      }
      await onSaved()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_chat_agents_save_failed')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <AgentFormDialog
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
            ? t('workbench.agent_creator_follow_device_summary', '能力：跟随运行设备')
            : t('workbench.agent_creator_manual_summary', '能力：固定到智能体'),
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
              setSelectedSkillKeys(current =>
                selected ? [...current, key] : current.filter(candidate => candidate !== key)
              )
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
          ? t(
              'workbench.agent_editor_description',
              '修改智能体资源的执行器、模型、Skill、插件和 MCP，保存后立即对项目生效。'
            )
          : t(
              'workbench.agent_creator_description',
              '设置名称、模型和提示词即可创建，其他能力默认跟随运行设备。'
            )
      }
      displayName={{
        label: t('workbench.agent_creator_display_name', '智能体名称'),
        onChange: setDisplayName,
        placeholder: t('workbench.agent_creator_display_name_placeholder', '代码评审'),
        testId: 'cloud-project-chat-agent-display-name',
        value: displayName,
      }}
      error={error}
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
      footerHint={
        capabilityMode === 'follow_device'
          ? t(
              'workbench.agent_creator_follow_device_footer',
              '默认使用 Codex，并从任务运行设备获取能力。'
            )
          : t(
              'workbench.agent_creator_manual_footer',
              '默认使用 Codex；所选能力会随智能体同步到执行设备。'
            )
      }
      labels={{
        advanced: t('workbench.agent_creator_advanced', '高级设置'),
        advancedDescription: t(
          'workbench.agent_creator_advanced_description',
          'MCP 与其他运行参数'
        ),
        capabilitiesSection: t('workbench.agent_creator_capabilities', '运行配置'),
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
      model={{
        disabled: loadingAgent,
        label: t('workbench.agent_creator_model', '模型'),
        onChange: value => {
          const selected = models.find(candidate => candidate.name === value)
          setModel(value)
          setModelType(selected?.type)
          setModelNamespace(selected?.namespace || 'default')
        },
        options: [
          ...(model && !models.some(candidate => candidate.name === model)
            ? [{ value: model, label: model }]
            : []),
          ...models.map(item => ({
            value: item.name,
            label: item.displayName || item.name,
          })),
        ],
        placeholder: t('workbench.agent_creator_model_placeholder', '请选择模型'),
        testId: 'cloud-project-chat-agent-model',
        value: model,
      }}
      namespace={namespace}
      onClose={onClose}
      onSave={() => void save()}
      ownerLabel={t('workbench.project_chat_agent_env_local')}
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
      saveDisabled={loadingAgent || !model}
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
