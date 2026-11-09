import { useCallback, useEffect, useRef, useState } from 'react'
import { runnerModelKey, type RunnerModelIdentity } from '../agent-form/runnerRouting'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'
import { usePanelData } from '../platform/usePanelData'

export interface TemplateModelConfiguration {
  host: ProjectAgentConfigurationHost
  location: 'local' | 'cloud'
  projectId?: string
  environmentId?: string
}

export function sameTemplateModelScope(
  first: TemplateModelConfiguration | undefined,
  second: TemplateModelConfiguration | undefined
) {
  return Boolean(
    first &&
    second &&
    first.host === second.host &&
    first.location === second.location &&
    first.projectId === second.projectId &&
    first.environmentId === second.environmentId
  )
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
  const [selected, setSelected] = useState('')
  const selection = useRef('')
  const { host, projectId } = configuration
  const load = useCallback(
    () => host.listTemplateAgentModels!(runtime, projectId),
    [host, projectId, runtime]
  )
  const state = usePanelData(load)
  const previousLoad = useRef(load)
  const catalog = state.data?.models ?? []
  const cloudUnavailable = state.data?.cloudModelsUnavailable
  const error = state.error !== undefined
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  }, [onChange])
  useEffect(() => {
    if (previousLoad.current !== load) {
      previousLoad.current = load
      selection.current = ''
      setSelected('')
    }
    if (state.loading || error) {
      change.current(undefined)
      return
    }
    const models = state.data?.models ?? []
    const defaults = models.filter(model => model.is_default)
    const initial =
      models.find(model => runnerModelKey(model) === selection.current) ??
      (defaults.length === 1 ? defaults[0] : undefined)
    selection.current = initial ? runnerModelKey(initial) : ''
    setSelected(selection.current)
    change.current(initial)
  }, [load, state.data, state.loading, error])
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
          value={state.data ? selected : ''}
          disabled={disabled || state.loading || error}
          onChange={event => {
            setSelected(event.target.value)
            selection.current = event.target.value
            onChange(catalog.find(model => runnerModelKey(model) === event.target.value))
          }}
        >
          <option value="">{m.chooseModel}</option>
          {catalog.map(model => (
            <option key={runnerModelKey(model)} value={runnerModelKey(model)}>
              {model.label || model.model_id}
              {model.account_label ? ` · ${model.account_label}` : ''}
            </option>
          ))}
        </select>
      </label>
      {state.loading && <p role="status">{m.loading}</p>}
      {!state.loading && !error && !cloudUnavailable && catalog.length === 0 && <p>{m.noModels}</p>}
      {error && <p role="alert">{m.modelLoadFailed}</p>}
      {!error && !state.loading && cloudUnavailable && (
        <p role="status">{m.cloudModelsUnavailable}</p>
      )}
      <button
        type="button"
        data-testid={`template-model-refresh-${runtime}`}
        disabled={disabled || state.loading}
        onClick={() => void state.refresh()}
      >
        {m.refresh}
      </button>
    </section>
  )
}
