import { useEffect, useRef, useState } from 'react'
import {
  runnerModelKey,
  type RunnerModel,
  type RunnerModelIdentity,
} from '../agent-form/runnerRouting'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'

export interface TemplateModelConfiguration {
  host: ProjectAgentConfigurationHost
  location: 'local' | 'cloud'
  projectId?: string
  environmentId?: string
}

export function TemplateModelSelection({
  runtime,
  configuration,
  locale,
  disabled,
  onChange,
  showRuntime = false,
}: {
  runtime: RunnerModelIdentity['runtime']
  configuration: TemplateModelConfiguration
  locale: CollaborationLocale
  disabled: boolean
  onChange(model: RunnerModelIdentity | undefined): void
  showRuntime?: boolean
}) {
  const m = templateMessages[locale]
  const [catalog, setCatalog] = useState<RunnerModel[] | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState('')
  const selection = useRef('')
  const { host, projectId } = configuration
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  }, [onChange])
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    change.current(undefined)
    void host.listTemplateAgentModels!(runtime, projectId).then(
      models => {
        if (!active) return
        setCatalog(models)
        const defaults = models.filter(model => model.is_default)
        const initial =
          models.find(model => runnerModelKey(model) === selection.current) ??
          (defaults.length === 1 ? defaults[0] : undefined)
        setSelected(initial ? runnerModelKey(initial) : '')
        selection.current = initial ? runnerModelKey(initial) : ''
        change.current(initial)
        setLoading(false)
      },
      () => {
        if (active) {
          setError(true)
          setLoading(false)
        }
      }
    )
    return () => {
      active = false
    }
  }, [host, projectId, runtime, revision])
  return (
    <section className="collaboration-template-create-section">
      <label className="collaboration-template-field">
        <span>
          {showRuntime
            ? `${m.agentModel} · ${runtime === 'codex' ? 'Codex' : 'Claude Code'}`
            : m.agentModel}
        </span>
        <select
          data-testid={`template-model-${runtime}`}
          value={selected}
          disabled={disabled || loading || error}
          onChange={event => {
            setSelected(event.target.value)
            selection.current = event.target.value
            onChange(catalog?.find(model => runnerModelKey(model) === event.target.value))
          }}
        >
          <option value="">{m.chooseModel}</option>
          {catalog?.map(model => (
            <option key={runnerModelKey(model)} value={runnerModelKey(model)}>
              {model.label || model.model_id}
              {model.account_label ? ` · ${model.account_label}` : ''}
            </option>
          ))}
        </select>
      </label>
      {loading && <p role="status">{m.loading}</p>}
      {!loading && !error && catalog?.length === 0 && <p>{m.noModels}</p>}
      {error && <p role="alert">{m.modelLoadFailed}</p>}
      <button
        type="button"
        data-testid={`template-model-refresh-${runtime}`}
        disabled={disabled || loading}
        onClick={() => setRevision(value => value + 1)}
      >
        {m.refresh}
      </button>
    </section>
  )
}
