import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'

import type { createAgentResourceApi, UnifiedAgentRuntime } from '@/api/agentResources'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { UnifiedModel, UnifiedSkill } from '@/types/api'

type AgentResourceApi = ReturnType<typeof createAgentResourceApi>

interface WeworkAgentResourceCreatorProps {
  api: AgentResourceApi
  namespace: string
  onClose(): void
  onCreated(agent: { name: string; teamId: number }): Promise<void>
  workspaceName: string
}

const fieldClassName =
  'w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-50'

function skillSupportsRuntime(skill: UnifiedSkill, runtime: UnifiedAgentRuntime): boolean {
  return !skill.bindShells?.length || skill.bindShells.includes(runtime)
}

function parseMcpServers(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value || '{}')
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('MCP configuration must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export function WeworkAgentResourceCreator({
  api,
  namespace,
  onClose,
  onCreated,
  workspaceName,
}: WeworkAgentResourceCreatorProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [runtime, setRuntime] = useState<UnifiedAgentRuntime>('Codex')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModelIndex, setSelectedModelIndex] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [mcpConfig, setMcpConfig] = useState('{}')
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<number[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [loadingSkills, setLoadingSkills] = useState(true)
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const [skillLoadError, setSkillLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

    return () => {
      active = false
    }
  }, [api, t])

  const availableSkills = useMemo(
    () => skills.filter(skill => skill.visible !== false && skillSupportsRuntime(skill, runtime)),
    [runtime, skills]
  )
  const selectedSkillSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds])
  const selectedModel =
    selectedModelIndex === '' ? null : (models[Number(selectedModelIndex)] ?? null)

  const createAgent = async () => {
    const technicalName = name.trim()
    if (!technicalName) {
      setError(t('workbench.agent_creator_name_required', '请输入资源名称'))
      return
    }
    if (!selectedModel) {
      setError(t('workbench.agent_creator_model_required', '请选择模型'))
      return
    }

    let mcpServers: Record<string, unknown>
    try {
      mcpServers = parseMcpServers(mcpConfig)
    } catch {
      setError(t('workbench.agent_creator_mcp_invalid', 'MCP 配置必须是有效的 JSON 对象'))
      return
    }

    setSaving(true)
    setError(null)
    try {
      const created = await api.createAgent({
        name: technicalName,
        displayName,
        namespace,
        runtime,
        model: {
          name: selectedModel.name,
          type: selectedModel.type,
          namespace: selectedModel.namespace,
        },
        systemPrompt,
        skills: availableSkills
          .filter(skill => selectedSkillSet.has(skill.id))
          .map(skill => ({
            skillId: skill.id,
            name: skill.name,
            namespace: skill.namespace || 'default',
            isPublic: skill.is_public,
          })),
        mcpServers,
      })
      await onCreated({
        name: created.displayName || created.name,
        teamId: created.id,
      })
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('workbench.agent_creator_create_failed', '创建智能体失败')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-6"
      data-testid="wework-agent-resource-creator-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <section
        aria-labelledby="wework-agent-resource-creator-title"
        aria-modal="true"
        className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-[20px] border border-border bg-popover text-text-primary shadow-xl"
        data-testid="wework-agent-resource-creator"
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 pb-4 pt-5">
          <div className="min-w-0 space-y-1">
            <h2
              className="text-heading-sm font-medium text-text-primary"
              id="wework-agent-resource-creator-title"
            >
              {t('workbench.agent_creator_title', '新建智能体')}
            </h2>
            <p className="text-sm leading-5 text-text-muted">
              {t(
                'workbench.agent_creator_description',
                '创建统一智能体资源，配置执行器、Skill 和 MCP 后加入当前项目。'
              )}
            </p>
          </div>
          <button
            aria-label={t('workbench.close', '关闭')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
            data-testid="wework-agent-resource-creator-close"
            disabled={saving}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-5">
          <section className="space-y-3">
            <h3 className="text-base font-medium text-text-primary">
              {t('workbench.agent_creator_identity', '基本信息')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-sm text-text-secondary">
                <span>{t('workbench.agent_creator_resource_name', '资源名称')}</span>
                <input
                  className={cn('h-10', fieldClassName)}
                  data-testid="wework-agent-resource-name"
                  disabled={saving}
                  onChange={event => setName(event.target.value)}
                  placeholder="code-review-agent"
                  value={name}
                />
              </label>
              <label className="space-y-1.5 text-sm text-text-secondary">
                <span>{t('workbench.agent_creator_display_name', '显示名称')}</span>
                <input
                  className={cn('h-10', fieldClassName)}
                  data-testid="wework-agent-display-name"
                  disabled={saving}
                  onChange={event => setDisplayName(event.target.value)}
                  placeholder={t('workbench.agent_creator_display_name_placeholder', '代码评审')}
                  value={displayName}
                />
              </label>
            </div>
            <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
              <div className="text-sm font-medium text-text-primary">
                {t('workbench.agent_creator_owner', '资源归属')}
              </div>
              <div className="mt-1 text-sm text-text-secondary">{workspaceName}</div>
              <div className="mt-1 text-xs text-text-muted">namespace: {namespace}</div>
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-base font-medium text-text-primary">
              {t('workbench.agent_creator_capabilities', '能力配置')}
            </h3>
            <label className="block space-y-1.5 text-sm text-text-secondary">
              <span>{t('workbench.agent_creator_runtime', '执行器')}</span>
              <select
                className={cn('wework-native-select h-10', fieldClassName)}
                data-testid="wework-agent-runtime"
                disabled={saving}
                onChange={event => setRuntime(event.target.value as UnifiedAgentRuntime)}
                value={runtime}
              >
                <option value="Codex">Codex</option>
                <option value="ClaudeCode">Claude Code</option>
              </select>
            </label>

            <label className="block space-y-1.5 text-sm text-text-secondary">
              <span>{t('workbench.agent_creator_model', '模型')}</span>
              <select
                className={cn('wework-native-select h-10', fieldClassName)}
                data-testid="wework-agent-model"
                disabled={saving || loadingModels}
                onChange={event => setSelectedModelIndex(event.target.value)}
                value={selectedModelIndex}
              >
                <option disabled value="">
                  {t('workbench.agent_creator_model_placeholder', '请选择模型')}
                </option>
                {models.map((model, index) => (
                  <option
                    key={`${model.type}:${model.namespace ?? 'default'}:${model.name}`}
                    value={index}
                  >
                    {model.displayName || model.name}
                  </option>
                ))}
              </select>
              {modelLoadError ? (
                <span
                  className="block rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
                  data-testid="wework-agent-model-load-error"
                  role="alert"
                >
                  {modelLoadError}
                </span>
              ) : null}
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm text-text-secondary">Skill</legend>
              <div
                className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-2"
                data-testid="wework-agent-skills"
              >
                {loadingSkills ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-sm text-text-muted">
                    <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
                    {t('workbench.agent_creator_skills_loading', '正在加载 Skill…')}
                  </div>
                ) : availableSkills.length ? (
                  availableSkills.map(skill => (
                    <label
                      className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted"
                      key={`${skill.namespace}:${skill.id}`}
                    >
                      <input
                        checked={selectedSkillSet.has(skill.id)}
                        className="mt-0.5"
                        data-testid={`wework-agent-skill-${skill.id}`}
                        disabled={saving}
                        onChange={event => {
                          setSelectedSkillIds(current =>
                            event.target.checked
                              ? [...current, skill.id]
                              : current.filter(skillId => skillId !== skill.id)
                          )
                        }}
                        type="checkbox"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-text-primary">
                          {skill.displayName || skill.name}
                        </span>
                        <span className="block text-xs text-text-muted">
                          {skill.namespace || 'default'}
                        </span>
                      </span>
                    </label>
                  ))
                ) : (
                  <div className="px-2 py-3 text-sm text-text-muted">
                    {t('workbench.agent_creator_no_skills', '当前执行器没有可用 Skill')}
                  </div>
                )}
              </div>
              {skillLoadError ? (
                <div
                  className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
                  data-testid="wework-agent-skill-load-error"
                  role="alert"
                >
                  {skillLoadError}
                </div>
              ) : null}
            </fieldset>

            <label className="block space-y-1.5 text-sm text-text-secondary">
              <span>{t('workbench.agent_creator_prompt', '系统提示词')}</span>
              <textarea
                className={cn('min-h-24 resize-y py-2.5', fieldClassName)}
                data-testid="wework-agent-system-prompt"
                disabled={saving}
                onChange={event => setSystemPrompt(event.target.value)}
                placeholder={t(
                  'workbench.agent_creator_prompt_placeholder',
                  '定义智能体职责、约束和输出要求'
                )}
                value={systemPrompt}
              />
            </label>

            <label className="block space-y-1.5 text-sm text-text-secondary">
              <span>MCP</span>
              <textarea
                className={cn('min-h-28 resize-y py-2.5 font-mono text-code', fieldClassName)}
                data-testid="wework-agent-mcp"
                disabled={saving}
                onChange={event => setMcpConfig(event.target.value)}
                placeholder='{"server":{"command":"node","args":["server.mjs"]}}'
                value={mcpConfig}
              />
            </label>
          </section>

          {error ? (
            <p
              className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
              data-testid="wework-agent-resource-creator-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <p className="text-xs text-text-muted">
            {t(
              'workbench.agent_creator_environment_hint',
              '运行设备由项目执行策略在任务开始时选择。'
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button disabled={saving} onClick={onClose} type="button" variant="ghost">
              {t('workbench.cancel', '取消')}
            </Button>
            <Button
              data-testid="wework-agent-resource-create"
              disabled={saving || loadingModels || !selectedModel}
              onClick={() => void createAgent()}
              type="button"
              variant="primary"
            >
              {saving ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              {saving
                ? t('workbench.agent_creator_creating', '创建中…')
                : t('workbench.agent_creator_create', '创建智能体')}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
