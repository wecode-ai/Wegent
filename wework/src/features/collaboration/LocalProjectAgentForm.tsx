import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  createLocalProjectChatAgentApi,
  LocalProjectChatAgent,
} from '@/api/local/localDelivery'
import type { ProjectSpaceDetailServices } from '@/features/workbench/workbenchServices'
import type { ProjectWithTasks, UnifiedModel, RuntimeProjectPluginRef } from '@/types/api'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

type AgentApi = ReturnType<typeof createLocalProjectChatAgentApi>
type AgentInput = Parameters<AgentApi['create']>[1]

export interface LocalProjectAgentFormProps {
  api: AgentApi
  catalog: Pick<ProjectSpaceDetailServices, 'modelApi' | 'deviceApi' | 'pluginApi'>
  projectId: string
  projects: ProjectWithTasks[]
  agentId: string | null
  onClose(): void
  onSaved(): Promise<void>
}

export function LocalProjectAgentForm({
  api,
  catalog,
  projectId,
  projects,
  agentId,
  onClose,
  onSaved,
}: LocalProjectAgentFormProps) {
  const { t } = useTranslation('common')
  const sectionRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const label = (key: string) => t(`localAgent.${key}`)
  const [agent, setAgent] = useState<LocalProjectChatAgent | null>(null)
  const [draft, setDraft] = useState<AgentInput>({ name: '', runtime: 'codex' })
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [plugins, setPlugins] = useState<RuntimeProjectPluginRef[]>([])
  const [skills, setSkills] = useState('')
  const [mcp, setMcp] = useState('{}')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void (
      agentId
        ? api.list(projectId).then(items => {
            const current = items.find(item => item.id === agentId)
            if (!current) throw new Error(t('localAgent.notFound'))
            return current
          })
        : Promise.resolve(null)
    )
      .then(current => {
        if (!active) return
        setLoaded(true)
        setAgent(current)
        setDraft(current ? { ...current } : { name: '', runtime: 'codex' })
        setSkills(
          (current?.additionalSkills ?? [])
            .map(skill =>
              typeof skill === 'string' ? skill : String((skill as { name?: string }).name ?? '')
            )
            .filter(Boolean)
            .join('\n')
        )
        setMcp(JSON.stringify(current?.mcpServers ?? {}, null, 2))
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, projectId, agentId, revision, t])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState('')
  const [modelsRevision, setModelsRevision] = useState(0)
  useEffect(() => {
    let active = true
    void catalog.modelApi
      .listModels()
      .then(result => {
        if (active) setModels(result.data)
      })
      .catch(cause => {
        if (active) setModelsError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })
    return () => {
      active = false
    }
  }, [catalog.modelApi, modelsRevision])
  const [pluginsRequested, setPluginsRequested] = useState(false)
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [pluginsError, setPluginsError] = useState('')
  const [pluginsRevision, setPluginsRevision] = useState(0)
  useEffect(() => {
    if (!pluginsRequested || !catalog.pluginApi) return
    let active = true
    void catalog.deviceApi
      .listDevices()
      .then(devices => {
        const device = devices.find(item => item.device_type === 'local')
        if (!device) throw new Error(t('localAgent.deviceUnavailable'))
        return catalog.pluginApi!.listPlugins(device.device_id)
      })
      .then(items => {
        if (active) setPlugins(items)
      })
      .catch(cause => {
        if (active) setPluginsError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setPluginsLoading(false)
      })
    return () => {
      active = false
    }
  }, [catalog.deviceApi, catalog.pluginApi, pluginsRequested, pluginsRevision, t])
  const availableModels = models.filter(
    model =>
      model.isActive !== false &&
      !model.compatibilityDisabled &&
      (draft.runtime !== 'claude_code' ||
        !String(model.config?.weworkModelKind).startsWith('codex-'))
  )
  const missingModel = Boolean(
    draft.model && !availableModels.some(model => model.name === draft.model)
  )
  useEffect(() => {
    if (!loading) nameRef.current?.focus()
  }, [loading])
  const update = (patch: Partial<AgentInput>) => setDraft(current => ({ ...current, ...patch }))
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const mcpServers: unknown = JSON.parse(mcp)
      if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers))
        throw new Error(label('invalidMcp'))
      const input: AgentInput = {
        ...draft,
        name: draft.name.trim(),
        executionEnvironment: 'local',
        executionDeviceId: null,
        additionalSkills: skills
          .split('\n')
          .map(name => name.trim())
          .filter(Boolean)
          .map(
            name =>
              agent?.additionalSkills.find(
                skill =>
                  typeof skill === 'object' &&
                  skill !== null &&
                  (skill as { name?: string }).name === name
              ) ?? name
          ),
        mcpServers: mcpServers as Record<string, unknown>,
      }
      if (agent) await api.update(projectId, agent.id, { ...input, version: agent.version })
      else await api.create(projectId, input)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const field = (name: string, control: React.ReactNode) => (
    <label className="grid gap-2 text-sm">
      {label(name)}
      {control}
    </label>
  )
  const selectClass =
    'wework-native-select h-9 rounded-lg border border-border bg-background px-3 text-sm'
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-6"
      data-testid="local-project-agent-backdrop"
    >
      <section
        ref={sectionRef}
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            onClose()
          }
          if (event.key !== 'Tab') return
          const fields = sectionRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'
          )
          if (!fields?.length) return
          const first = fields[0]
          const last = fields[fields.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={label(agentId ? 'edit' : 'create')}
        className="flex max-h-[90dvh] w-full max-w-xl flex-col rounded-xl border border-border bg-popover text-text-primary shadow-xl"
        data-testid="local-project-agent-form"
      >
        <header className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-heading-sm">{label(agentId ? 'edit' : 'create')}</h2>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onClose}
            data-testid="local-project-agent-close"
          >
            {t('common.close')}
          </Button>
        </header>
        <div className="grid gap-4 overflow-y-auto p-4">
          {loading ? (
            <p>{t('common.loading')}</p>
          ) : (
            <>
              {field(
                'name',
                <input
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  ref={nameRef}
                  value={draft.name}
                  onChange={event => update({ name: event.target.value })}
                  data-testid="local-project-agent-name"
                />
              )}
              {field(
                'runtime',
                <select
                  className={selectClass}
                  value={draft.runtime}
                  onChange={event =>
                    update({ runtime: event.target.value as AgentInput['runtime'], model: null })
                  }
                  data-testid="local-project-agent-runtime"
                >
                  <option value="codex">Codex</option>
                  <option value="claude_code">Claude Code</option>
                </select>
              )}
              {field(
                'model',
                <select
                  className={selectClass}
                  value={draft.model ?? ''}
                  onChange={event => update({ model: event.target.value || null })}
                  data-testid="local-project-agent-model"
                >
                  <option value="">{label('runtimeDefault')}</option>
                  {missingModel && <option value={draft.model!}>{draft.model}</option>}
                  {availableModels.map(model => (
                    <option key={model.name} value={model.name}>
                      {model.displayName || model.name}
                    </option>
                  ))}
                </select>
              )}
              {modelsLoading && <p role="status">{label('modelsLoading')}</p>}
              {modelsError && (
                <div role="alert">
                  {t('localAgent.modelsFailed', { error: modelsError })}
                  <Button
                    variant="ghost"
                    data-testid="local-project-agent-models-retry"
                    onClick={() => {
                      setModelsLoading(true)
                      setModelsError('')
                      setModelsRevision(value => value + 1)
                    }}
                  >
                    {label('reload')}
                  </Button>
                </div>
              )}
              {!modelsLoading && !modelsError && missingModel && (
                <p role="alert">{t('localAgent.modelUnavailable', { model: draft.model })}</p>
              )}
              {field(
                'workspace',
                <select
                  className={selectClass}
                  value={draft.localProjectId ?? ''}
                  onChange={event =>
                    update({
                      localProjectId: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                  data-testid="local-project-agent-workspace"
                >
                  <option value="">{label('standalone')}</option>
                  {projects.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
              {field(
                'instructions',
                <textarea
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={draft.systemPrompt ?? ''}
                  onChange={event => update({ systemPrompt: event.target.value })}
                  data-testid="local-project-agent-instructions"
                />
              )}
              {field(
                'approval',
                <select
                  className={selectClass}
                  value={draft.executionMode ?? 'auto'}
                  onChange={event =>
                    update({ executionMode: event.target.value as AgentInput['executionMode'] })
                  }
                  data-testid="local-project-agent-approval"
                >
                  <option value="auto">{label('automatic')}</option>
                  <option value="manual_approval">{label('manual')}</option>
                </select>
              )}
              {field(
                'skills',
                <textarea
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={skills}
                  onChange={event => setSkills(event.target.value)}
                  data-testid="local-project-agent-skills"
                />
              )}
              {field(
                'mcp',
                <textarea
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={mcp}
                  onChange={event => setMcp(event.target.value)}
                  data-testid="local-project-agent-mcp"
                />
              )}
              {catalog.pluginApi && (
                <div className="grid gap-2">
                  <Button
                    variant="ghost"
                    disabled={pluginsLoading}
                    data-testid="local-project-agent-load-plugins"
                    onClick={() => {
                      setPluginsLoading(true)
                      setPluginsError('')
                      setPluginsRequested(true)
                      setPluginsRevision(value => value + 1)
                    }}
                  >
                    {label(pluginsRequested ? 'reloadPlugins' : 'loadPlugins')}
                  </Button>
                  {pluginsLoading && <p role="status">{label('pluginsLoading')}</p>}
                  {pluginsError && (
                    <p role="alert">{t('localAgent.pluginsFailed', { error: pluginsError })}</p>
                  )}
                </div>
              )}
              {plugins.length > 0 && (
                <fieldset className="grid gap-2">
                  <legend className="text-sm">{label('plugins')}</legend>
                  {plugins.map(plugin => (
                    <label key={plugin.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`local-project-agent-plugin-${plugin.id}`}
                        checked={draft.plugins?.some(item => item.id === plugin.id) ?? false}
                        onChange={event =>
                          update({
                            plugins: event.target.checked
                              ? [...(draft.plugins ?? []), plugin]
                              : draft.plugins?.filter(item => item.id !== plugin.id),
                          })
                        }
                      />
                      {plugin.displayName || plugin.pluginName}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          {error && (
            <div role="alert" data-testid="local-project-agent-error">
              {error}
              <Button
                variant="ghost"
                onClick={() => {
                  setLoading(true)
                  setLoaded(false)
                  setError('')
                  setRevision(value => value + 1)
                }}
                data-testid="local-project-agent-retry"
              >
                {label('reload')}
              </Button>
            </div>
          )}
        </div>
        <footer className="flex justify-end border-t border-border p-4">
          <Button
            disabled={
              !loaded ||
              loading ||
              busy ||
              !draft.name.trim() ||
              Boolean(draft.model && (modelsLoading || modelsError || missingModel))
            }
            onClick={() => void save()}
            data-testid="local-project-agent-save"
          >
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
