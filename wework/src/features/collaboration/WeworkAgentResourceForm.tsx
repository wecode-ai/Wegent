import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AgentCapabilitiesSelector,
  AgentCapabilityModeSelector,
  AgentFormDialog,
  AgentPromptEditor,
  agentPluginBinding,
  resolveAgentPromptCapabilityReferences,
  type UnifiedAgentCapabilityMode,
} from '@wegent/collaboration'

import type {
  AgentResourceDetail,
  createAgentResourceApi,
  UnifiedAgentRuntime,
  UnifiedAgentSpec,
} from '@/api/agentResources'
import type {
  ProjectPluginCatalogApi,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { UnifiedModel, UnifiedSkill } from '@/types/api'
import { parseAgentMcpServers } from './agentFormModel'
import { useCurrentAgentDevice } from './useCurrentAgentDevice'

type AgentResourceApi = ReturnType<typeof createAgentResourceApi>

interface WeworkAgentResourceFormProps {
  api: AgentResourceApi
  /** Team id of the Agent resource to edit. Omit to create a new resource. */
  editingTeamId?: number
  deviceApi?: Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>
  namespace: string
  onClose(): void
  onSaved(agent: { name: string; teamId: number }): Promise<void>
  pluginApi?: ProjectPluginCatalogApi
  workspaceName: string
}

function modelIndex(models: UnifiedModel[], model: AgentResourceDetail['model']): string {
  if (!model.name) return ''
  const exact = models.findIndex(
    candidate =>
      candidate.name === model.name &&
      (model.type ? candidate.type === model.type : true) &&
      (candidate.namespace || 'default') === (model.namespace || 'default')
  )
  const found = exact >= 0 ? exact : models.findIndex(candidate => candidate.name === model.name)
  return found >= 0 ? String(found) : ''
}

/** Resolve bound Skill names to catalog ids; refs written by older clients may lack ids. */
function boundSkillIds(detail: AgentResourceDetail, catalog: UnifiedSkill[]): number[] {
  return detail.skills
    .map(skill => skill.skillId || catalog.find(entry => entry.name === skill.name)?.id || 0)
    .filter(skillId => skillId > 0)
}

export function WeworkAgentResourceForm({
  api,
  deviceApi,
  editingTeamId,
  namespace,
  onClose,
  onSaved,
  pluginApi,
  workspaceName,
}: WeworkAgentResourceFormProps) {
  const { t } = useTranslation()
  const editing = editingTeamId != null
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [runtime, setRuntime] = useState<UnifiedAgentRuntime>('Codex')
  const [capabilityMode, setCapabilityMode] = useState<UnifiedAgentCapabilityMode>('follow_device')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModelIndex, setSelectedModelIndex] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [mcpConfig, setMcpConfig] = useState('{}')
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<number[]>([])
  const [plugins, setPlugins] = useState<AgentResourceDetail['plugins']>([])
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([])
  const [detail, setDetail] = useState<AgentResourceDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(editing)
  const [loadingModels, setLoadingModels] = useState(true)
  const [loadingSkills, setLoadingSkills] = useState(true)
  const [loadingPlugins, setLoadingPlugins] = useState(Boolean(pluginApi))
  const [detailLoadError, setDetailLoadError] = useState<string | null>(null)
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const [skillLoadError, setSkillLoadError] = useState<string | null>(null)
  const [pluginLoadError, setPluginLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelPrefilled = useRef(false)
  const skillsPrefilled = useRef(false)
  const deviceState = useCurrentAgentDevice(deviceApi, pluginApi)

  useEffect(() => {
    let active = true

    void api
      .listModels()
      .then(loadedModels => {
        if (!active) return
        setModels(
          loadedModels.filter(model => model.isActive !== false && !model.compatibilityDisabled)
        )
      })
      .catch(cause => {
        if (!active) return
        setModelLoadError(
          cause instanceof Error
            ? cause.message
            : t('workbench.agent_creator_models_load_failed', '加载模型失败')
        )
      })
      .finally(() => {
        if (active) setLoadingModels(false)
      })

    void api
      .listSkills()
      .then(loadedSkills => {
        if (active) setSkills(loadedSkills)
      })
      .catch(cause => {
        if (!active) return
        setSkillLoadError(
          cause instanceof Error
            ? cause.message
            : t('workbench.agent_creator_skills_load_failed', '加载 Skill 失败')
        )
      })
      .finally(() => {
        if (active) setLoadingSkills(false)
      })

    if (pluginApi) {
      void pluginApi
        .listPlugins('')
        .then(loadedPlugins => {
          if (active) setPlugins(loadedPlugins)
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

    return () => {
      active = false
    }
  }, [api, pluginApi, t])

  useEffect(() => {
    if (editingTeamId == null) return
    let active = true
    void api
      .getAgent(editingTeamId)
      .then(loaded => {
        if (!active) return
        setDetail(loaded)
        setName(loaded.name)
        setDisplayName(loaded.displayName)
        if (loaded.runtime) setRuntime(loaded.runtime)
        setSystemPrompt(loaded.systemPrompt)
        setMcpConfig(JSON.stringify(loaded.mcpServers ?? {}, null, 2))
        setCapabilityMode(loaded.capabilityMode)
        setSelectedPluginIds(loaded.plugins.map(plugin => plugin.id))
      })
      .catch(cause => {
        if (!active) return
        setDetailLoadError(
          cause instanceof Error
            ? cause.message
            : t('workbench.agent_editor_load_failed', '加载智能体配置失败')
        )
      })
      .finally(() => {
        if (active) setLoadingDetail(false)
      })
    return () => {
      active = false
    }
  }, [api, editingTeamId, t])

  useEffect(() => {
    if (!detail || modelPrefilled.current || loadingModels) return
    modelPrefilled.current = true
    setSelectedModelIndex(modelIndex(models, detail.model))
  }, [detail, loadingModels, models])

  useEffect(() => {
    if (!detail || skillsPrefilled.current || loadingSkills) return
    skillsPrefilled.current = true
    setSelectedSkillIds(boundSkillIds(detail, skills))
  }, [detail, loadingSkills, skills])

  const availableSkills = useMemo(() => skills.filter(skill => skill.visible !== false), [skills])
  const selectedSkillSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds])
  const availablePlugins = useMemo(() => {
    const merged = new Map(plugins.map(plugin => [plugin.id, plugin]))
    detail?.plugins.forEach(plugin => merged.set(plugin.id, merged.get(plugin.id) ?? plugin))
    return [...merged.values()]
  }, [detail, plugins])
  const selectedPluginSet = useMemo(() => new Set(selectedPluginIds), [selectedPluginIds])
  const promptCapabilities = useMemo(
    () => resolveAgentPromptCapabilityReferences(systemPrompt, availablePlugins, availableSkills),
    [availablePlugins, availableSkills, systemPrompt]
  )
  const effectiveSelectedPluginSet = useMemo(
    () => new Set([...selectedPluginSet, ...promptCapabilities.pluginIds]),
    [promptCapabilities.pluginIds, selectedPluginSet]
  )
  const effectiveSelectedSkillIds = useMemo(
    () => new Set([...selectedSkillSet, ...promptCapabilities.skillIds]),
    [promptCapabilities.skillIds, selectedSkillSet]
  )
  const selectedModel =
    selectedModelIndex === '' ? null : (models[Number(selectedModelIndex)] ?? null)

  const saveAgent = async () => {
    const technicalName = name.trim()
    if (!technicalName) {
      setError(t('workbench.agent_creator_name_required', '请输入资源名称'))
      return
    }
    if (!selectedModel) {
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

    const spec: UnifiedAgentSpec = {
      name: technicalName,
      displayName,
      namespace: detail?.namespace ?? namespace,
      capabilityMode,
      runtime,
      model: {
        name: selectedModel.name,
        type: selectedModel.type,
        namespace: selectedModel.namespace,
      },
      systemPrompt,
      skills:
        capabilityMode === 'manual'
          ? availableSkills
              .filter(skill => effectiveSelectedSkillIds.has(skill.id))
              .map(skill => ({
                skillId: skill.id,
                name: skill.name,
                namespace: skill.namespace || 'default',
                isPublic: skill.is_public,
              }))
          : [],
      plugins:
        capabilityMode === 'manual' && runtime === 'Codex'
          ? availablePlugins
              .filter(plugin => effectiveSelectedPluginSet.has(plugin.id))
              .map(agentPluginBinding)
          : [],
      mcpServers,
    }

    setSaving(true)
    setError(null)
    try {
      const saved = detail
        ? await api.updateAgent({ teamId: detail.teamId, botId: detail.botId }, spec)
        : await api.createAgent(spec)
      await onSaved({
        name: saved.displayName || saved.name,
        teamId: saved.id,
      })
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : editing
            ? t('workbench.agent_editor_save_failed', '保存智能体失败')
            : t('workbench.agent_creator_create_failed', '创建智能体失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || loadingDetail
  // A Shell this form cannot represent must not be silently rewritten on save.
  const unsupportedRuntime = Boolean(detail && !detail.runtime)

  const formError = error || detailLoadError

  return (
    <AgentFormDialog
      advanced={
        <>
          {unsupportedRuntime ? (
            <p
              className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
              data-testid="wework-agent-resource-form-unsupported"
              role="alert"
            >
              {t(
                'workbench.agent_editor_unsupported_runtime',
                '这个智能体使用此表单不支持的执行器，请在 Wegent 资源库中修改。'
              )}
              {` (${detail?.shellName || 'unknown'})`}
            </p>
          ) : null}
          {modelLoadError ? (
            <p
              className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
              data-testid="wework-agent-model-load-error"
              role="alert"
            >
              {modelLoadError}
            </p>
          ) : null}
        </>
      }
      busy={busy}
      capabilities={
        capabilityMode === 'manual' ? (
          <AgentCapabilitiesSelector
            busy={busy}
            collapsible={false}
            loadingPlugins={loadingPlugins}
            loadingSkills={loadingSkills}
            onPluginChange={(pluginId, selected) =>
              setSelectedPluginIds(current =>
                selected ? [...current, pluginId] : current.filter(id => id !== pluginId)
              )
            }
            onSkillChange={(skill, selected) =>
              setSelectedSkillIds(current =>
                selected ? [...current, skill.id] : current.filter(skillId => skillId !== skill.id)
              )
            }
            pluginError={pluginLoadError}
            pluginsEnabled={runtime === 'Codex'}
            plugins={availablePlugins}
            selectedPluginIds={effectiveSelectedPluginSet}
            selectedSkillKeys={new Set([...effectiveSelectedSkillIds].map(String))}
            requiredPluginIds={promptCapabilities.pluginIds}
            requiredSkillKeys={new Set([...promptCapabilities.skillIds].map(String))}
            skillError={skillLoadError}
            skillKey={skill => String(skill.id)}
            skills={availableSkills}
            testIdPrefix="wework-agent"
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
          : t('workbench.agent_creator_description', '创建后可在当前空间和项目中复用。')
      }
      displayName={{
        label: t('workbench.agent_creator_display_name', '显示名称'),
        onChange: setDisplayName,
        placeholder: t('workbench.agent_creator_display_name_placeholder', '代码评审'),
        testId: 'wework-agent-display-name',
        value: displayName,
      }}
      error={formError}
      capabilityMode={
        <AgentCapabilityModeSelector
          busy={busy}
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
              '任务在哪台设备运行，就使用该设备上当前用户可用的插件、Skill、MCP 和本地能力。'
            ),
            followTitle: t('workbench.agent_creator_follow_device_title', '跟随运行设备（推荐）'),
            loadingCapabilities: t(
              'workbench.agent_creator_loading_device_capabilities',
              '正在读取设备能力…'
            ),
            manualDescription: t(
              'workbench.agent_creator_manual_description',
              '能力随智能体保存，系统会在运行前将所选插件、Skill 和 MCP 同步到执行设备。'
            ),
            manualReady: t(
              'workbench.agent_creator_manual_ready',
              '系统会确保执行设备具备以下能力后再开始任务。'
            ),
            manualTitle: t('workbench.agent_creator_manual_title', '手动选择能力'),
            title: t('workbench.agent_creator_capability_source', '能力来源'),
          }}
          loadingCapabilities={deviceState.loading}
          onChange={setCapabilityMode}
          testIdPrefix="wework-agent"
          value={capabilityMode}
        />
      }
      footerHint={
        capabilityMode === 'follow_device'
          ? t(
              'workbench.agent_creator_follow_device_footer',
              '实际能力以任务运行设备为准，换设备后可能不同。'
            )
          : t('workbench.agent_creator_manual_footer', '所选能力将随智能体同步到执行设备。')
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
        owner: t('workbench.agent_creator_owner', '资源归属'),
      }}
      loading={loadingDetail}
      loadingLabel={t('workbench.agent_editor_loading', '正在加载智能体配置…')}
      mcp={
        capabilityMode === 'manual'
          ? {
              label: 'MCP',
              onChange: setMcpConfig,
              placeholder: '{"server":{"command":"node","args":["server.mjs"]}}',
              testId: 'wework-agent-mcp',
              value: mcpConfig,
            }
          : undefined
      }
      model={{
        disabled: loadingModels,
        label: t('workbench.agent_creator_model', '模型'),
        onChange: setSelectedModelIndex,
        options: models.map((model, index) => ({
          label: model.displayName || model.name,
          value: String(index),
        })),
        placeholder: t('workbench.agent_creator_model_placeholder', '请选择模型'),
        testId: 'wework-agent-model',
        value: selectedModelIndex,
      }}
      name={{
        disabled: editing,
        label: t('workbench.agent_creator_resource_name', '资源名称'),
        onChange: setName,
        placeholder: 'code-review-agent',
        testId: 'wework-agent-resource-name',
        value: name,
      }}
      namespace={detail?.namespace ?? namespace}
      onClose={onClose}
      onSave={() => void saveAgent()}
      ownerLabel={workspaceName}
      prompt={{
        label: t('workbench.agent_creator_prompt', '系统提示词'),
        onChange: value => {
          setSystemPrompt(value)
          const references = resolveAgentPromptCapabilityReferences(
            value,
            availablePlugins,
            availableSkills
          )
          if (references.pluginIds.size || references.skillIds.size) setCapabilityMode('manual')
        },
        placeholder: t(
          'workbench.agent_creator_prompt_placeholder',
          '定义智能体职责、约束和输出要求'
        ),
        testId: 'wework-agent-system-prompt',
        value: systemPrompt,
      }}
      promptEditor={
        <AgentPromptEditor
          busy={busy}
          field={{
            label: t('workbench.agent_creator_prompt', '系统提示词'),
            onChange: value => {
              setSystemPrompt(value)
              const references = resolveAgentPromptCapabilityReferences(
                value,
                availablePlugins,
                availableSkills
              )
              if (references.pluginIds.size || references.skillIds.size) setCapabilityMode('manual')
            },
            placeholder: t(
              'workbench.agent_creator_prompt_placeholder',
              '定义智能体职责、约束和输出要求'
            ),
            testId: 'wework-agent-system-prompt',
            value: systemPrompt,
          }}
          plugins={availablePlugins}
          skills={availableSkills}
          translate={(key, fallback, options) =>
            String(t(key, { ...options, defaultValue: fallback ?? key }))
          }
        />
      }
      runtime={{
        label: t('workbench.agent_creator_runtime', '执行器'),
        onChange: value => setRuntime(value as UnifiedAgentRuntime),
        options: [
          { label: 'Codex', value: 'Codex' },
          { label: 'Claude Code', value: 'ClaudeCode' },
        ],
        testId: 'wework-agent-runtime',
        value: runtime,
      }}
      saveDisabled={loadingModels || unsupportedRuntime || !selectedModel || (editing && !detail)}
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
        backdrop: 'wework-agent-resource-creator-backdrop',
        close: 'wework-agent-resource-creator-close',
        dialog: 'wework-agent-resource-creator',
        error: 'wework-agent-resource-creator-error',
        save: 'wework-agent-resource-create',
      }}
      title={
        editing
          ? t('workbench.agent_editor_title', '编辑智能体')
          : t('workbench.agent_creator_title', '新建智能体')
      }
    />
  )
}
