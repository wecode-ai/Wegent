import { Check, Plug } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import type {
  LocalProjectChatAgent,
  createLocalProjectChatAgentApi,
} from '@/api/local/localDelivery'
import { MenuSelect } from '@/components/common/MenuSelect'
import { SectionTitle, SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'
import type { RuntimeProjectPluginRef } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'

type LocalAgentApi = ReturnType<typeof createLocalProjectChatAgentApi>

export function ProjectChatAgentEditor({
  api,
  editingAgentId,
  modelApi,
  pluginApi,
  onClose,
  onSaved,
}: {
  api: LocalAgentApi
  editingAgentId?: string
  modelApi: WorkbenchServices['modelApi']
  pluginApi?: { listPlugins(deviceId: string): Promise<RuntimeProjectPluginRef[]> }
  onClose(): void
  onSaved(): Promise<void>
}) {
  const { t } = useTranslation('common')
  const editing = Boolean(editingAgentId)
  const [name, setName] = useState('')
  const [capabilityDescription, setCapabilityDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<Array<{ name: string; displayName?: string }>>([])
  const [plugins, setPlugins] = useState<RuntimeProjectPluginRef[]>([])
  const [selectedPlugins, setSelectedPlugins] = useState<RuntimeProjectPluginRef[]>([])
  const [maxConcurrentExecutions, setMaxConcurrentExecutions] = useState(1)
  const [visibility, setVisibility] = useState<LocalProjectChatAgent['visibility']>('creator_admin')
  const [version, setVersion] = useState(1)
  const [loadingPlugins, setLoadingPlugins] = useState(Boolean(pluginApi))
  const [loadingAgent, setLoadingAgent] = useState(editing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void modelApi
      .listModels()
      .then(response => {
        if (!active) return
        setModels(
          response.data
            .filter(isSupportedModelFamily)
            .map(item => ({ name: item.name, displayName: item.displayName ?? undefined }))
        )
      })
      .catch(() => {
        if (active) setModels([])
      })

    if (pluginApi) {
      void pluginApi
        .listPlugins('local-device')
        .then(items => {
          if (active) setPlugins(items)
        })
        .catch(() => {
          if (active) setPlugins([])
        })
        .finally(() => {
          if (active) setLoadingPlugins(false)
        })
    }

    if (editingAgentId) {
      void api
        .list(DEFAULT_WORK_ITEM_PROJECT_ID)
        .then(agents => {
          if (!active) return
          const agent = agents.find(candidate => candidate.id === editingAgentId)
          if (!agent) {
            setError(t('workbench.project_chat_agent_unavailable'))
            return
          }
          setName(agent.name)
          setCapabilityDescription(agent.capabilityDescription)
          setSystemPrompt(agent.systemPrompt)
          setModel(agent.model ?? '')
          setSelectedPlugins(agent.plugins)
          setMaxConcurrentExecutions(agent.maxConcurrentExecutions)
          setVisibility(agent.visibility)
          setVersion(agent.version)
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
  }, [api, editingAgentId, modelApi, pluginApi, t])

  const visiblePlugins = useMemo(
    () =>
      Array.from(
        new Map([...selectedPlugins, ...plugins].map(plugin => [plugin.id, plugin])).values()
      ),
    [plugins, selectedPlugins]
  )

  const save = async () => {
    if (busy || loadingAgent || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const input = {
        name: name.trim(),
        runtime: 'codex' as const,
        model: model || null,
        capabilityDescription: capabilityDescription.trim(),
        systemPrompt,
        visibility,
        executionEnvironment: 'local' as const,
        executionMode: 'auto' as const,
        executionDeviceId: null,
        maxConcurrentExecutions,
        workspacePolicy: 'project' as const,
        plugins: selectedPlugins,
      }
      if (editingAgentId) {
        await api.update(DEFAULT_WORK_ITEM_PROJECT_ID, editingAgentId, {
          version,
          ...input,
        })
      } else {
        await api.create(DEFAULT_WORK_ITEM_PROJECT_ID, input)
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
    <CloudTodoModal
      onSubmit={save}
      pending={busy}
      onClose={onClose}
      title={
        editing
          ? t('workbench.project_chat_agents_edit', { name })
          : t('workbench.project_chat_agents_add')
      }
      width="workspace"
    >
      <div
        className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto border-t border-border md:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)] md:overflow-hidden"
        data-testid="cloud-project-chat-agent-editor"
      >
        <div className="flex min-h-[560px] flex-col px-7 py-6 md:min-h-0">
          <input
            autoFocus={!editing}
            className="w-full border-0 bg-transparent p-0 text-heading-lg font-semibold tracking-[-0.03em] text-text-primary outline-none placeholder:text-text-tertiary"
            data-testid="cloud-project-chat-agent-name"
            disabled={busy || loadingAgent}
            onChange={event => setName(event.target.value)}
            placeholder={t('workbench.project_chat_agent_name')}
            value={name}
          />
          <label
            className="mt-6 text-sm font-medium text-text-secondary"
            htmlFor="cloud-project-chat-agent-capability-field"
          >
            {t('workbench.project_chat_agent_capability')}
          </label>
          <textarea
            className="mt-2 min-h-24 resize-none rounded-2xl border border-border bg-background px-5 py-4 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
            data-testid="cloud-project-chat-agent-capability"
            disabled={busy || loadingAgent}
            id="cloud-project-chat-agent-capability-field"
            onChange={event => setCapabilityDescription(event.target.value)}
            placeholder={t('workbench.project_chat_agent_capability_placeholder')}
            value={capabilityDescription}
          />
          <label
            className="mt-6 text-xs font-semibold uppercase tracking-wider text-text-muted"
            htmlFor="cloud-project-chat-agent-system-prompt-field"
          >
            {t('workbench.project_chat_agent_prompt')}
          </label>
          <textarea
            className="mt-2 min-h-72 flex-1 resize-none rounded-2xl border border-border bg-background px-5 py-4 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
            data-testid="cloud-project-chat-agent-system-prompt"
            disabled={busy || loadingAgent}
            id="cloud-project-chat-agent-system-prompt-field"
            onChange={event => setSystemPrompt(event.target.value)}
            placeholder={t('workbench.project_chat_agent_prompt')}
            value={systemPrompt}
          />
        </div>

        <div className="min-h-0 border-t border-border px-6 pb-6 pt-1 md:overflow-y-auto md:border-l md:border-t-0">
          <section data-testid="cloud-project-chat-agent-runtime-group">
            <SectionTitle title={t('workbench.project_chat_agent_runtime_group')} />
            <SettingsGroup>
              <SettingsRow
                description={t('workbench.project_chat_agent_codex_only')}
                label={t('workbench.project_chat_agent_runtime_provider')}
              >
                <span
                  className="rounded-full bg-surface px-2 py-1 text-sm font-medium"
                  data-testid="cloud-project-chat-agent-environment"
                >
                  Codex
                </span>
              </SettingsRow>
            </SettingsGroup>
          </section>

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
                    const selected = selectedPlugins.some(item => item.id === plugin.id)
                    return (
                      <button
                        aria-pressed={selected}
                        className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-surface"
                        data-testid={`cloud-project-chat-agent-plugin-${plugin.id}`}
                        disabled={busy || loadingAgent}
                        key={plugin.id}
                        onClick={() =>
                          setSelectedPlugins(current =>
                            selected
                              ? current.filter(item => item.id !== plugin.id)
                              : [...current, plugin]
                          )
                        }
                        type="button"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
                          <Plug aria-hidden="true" className="h-4 w-4" />
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
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    )
                  })}
                  {loadingPlugins ? (
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

          <section data-testid="cloud-project-chat-agent-execution-group">
            <SectionTitle title={t('workbench.project_chat_agent_execution_group')} />
            <SettingsGroup>
              <SettingsRow
                description={t('workbench.project_chat_agent_model_relation')}
                label={t('workbench.project_chat_agent_model')}
              >
                <MenuSelect
                  disabled={busy || loadingAgent}
                  onChange={setModel}
                  options={[
                    ...(model && !models.some(candidate => candidate.name === model)
                      ? [{ value: model, label: model }]
                      : []),
                    ...models.map(item => ({
                      value: item.name,
                      label: item.displayName || item.name,
                    })),
                  ]}
                  pill
                  placeholder={t('workbench.project_chat_agent_model_placeholder')}
                  testId="cloud-project-chat-agent-model"
                  value={model}
                />
              </SettingsRow>
              <SettingsRow
                description={t('workbench.project_chat_agent_max_concurrent_executions_relation')}
                label={t('workbench.project_chat_agent_max_concurrent_executions')}
              >
                <input
                  className="h-8 w-20 rounded-lg border border-border bg-background px-2 text-right text-sm text-text-primary outline-none focus:border-text-tertiary"
                  data-testid="cloud-project-chat-agent-max-concurrent-executions"
                  disabled={busy || loadingAgent}
                  max={20}
                  min={1}
                  onChange={event =>
                    setMaxConcurrentExecutions(
                      Math.max(1, Math.min(20, Number(event.target.value) || 1))
                    )
                  }
                  step={1}
                  type="number"
                  value={maxConcurrentExecutions}
                />
              </SettingsRow>
            </SettingsGroup>
          </section>

          <section data-testid="cloud-project-chat-agent-access-group">
            <SectionTitle title={t('workbench.project_chat_agent_access_group')} />
            <SettingsGroup>
              <SettingsRow
                description={t('workbench.project_chat_agent_visibility_relation')}
                label={t('workbench.project_chat_agent_visibility')}
              >
                <MenuSelect
                  disabled={busy || loadingAgent}
                  onChange={value => setVisibility(value as LocalProjectChatAgent['visibility'])}
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
                  pill
                  testId="cloud-project-chat-agent-visibility"
                  value={visibility}
                />
              </SettingsRow>
            </SettingsGroup>
          </section>

          {error ? (
            <p className="mt-4 text-sm text-red-600" data-testid="cloud-project-chat-agent-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
        <button
          className="h-8 rounded-lg px-3 text-sm hover:bg-surface"
          data-testid="cloud-project-chat-agent-cancel"
          disabled={busy}
          onClick={onClose}
          type="button"
        >
          {t('common.cancel')}
        </button>
        <button
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-40"
          data-testid="cloud-project-chat-agent-save"
          disabled={busy || loadingAgent || !name.trim()}
          type="submit"
        >
          {t('workbench.project_chat_agent_save')}
        </button>
      </footer>
    </CloudTodoModal>
  )
}
