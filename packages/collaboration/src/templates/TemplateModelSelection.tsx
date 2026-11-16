import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const selectionChosen = useRef(false)
  const { host, projectId } = configuration
  const load = useCallback(
    () => host.listTemplateAgentModels!(runtime, projectId),
    [host, projectId, runtime]
  )
  const state = usePanelData(load)
  const loadCloud = useCallback(
    () => host.listTemplateCloudAgentModels?.(runtime, projectId) ?? Promise.resolve([]),
    [host, projectId, runtime]
  )
  const cloud = usePanelData(loadCloud)
  const previousLoad = useRef(load)
  const catalog = useMemo(
    () => [
      ...new Map(
        [...(cloud.data ?? []), ...(state.data?.models ?? [])].map(model => [
          runnerModelKey(model),
          model,
        ])
      ).values(),
    ],
    [state.data, cloud.data]
  )
  const cloudUnavailable = cloud.error !== undefined
  const error = state.error !== undefined
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  }, [onChange])
  useEffect(() => {
    if (previousLoad.current !== load) {
      previousLoad.current = load
      selection.current = ''
      selectionChosen.current = false
      setSelected('')
    }
    if (state.loading || error) {
      change.current(undefined)
      return
    }
    const models = catalog
    const defaults = models.filter(model => model.is_default)
    const initial =
      models.find(model => runnerModelKey(model) === selection.current) ??
      (!selectionChosen.current && defaults.length === 1 ? defaults[0] : undefined)
    if (initial) selectionChosen.current = true
    selection.current = initial ? runnerModelKey(initial) : ''
    setSelected(selection.current)
    change.current(
      initial?.source === 'cloud' && (cloud.loading || cloudUnavailable) ? undefined : initial
    )
  }, [load, catalog, state.loading, error, cloud.loading, cloudUnavailable])
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
            selectionChosen.current = true
            onChange(catalog.find(model => runnerModelKey(model) === event.target.value))
          }}
        >
          <option value="">{m.chooseModel}</option>
          {catalog.map(model => (
            <option
              key={runnerModelKey(model)}
              value={runnerModelKey(model)}
              disabled={model.source === 'cloud' && (cloud.loading || cloudUnavailable)}
            >
              {model.label || model.model_id}
              {model.account_label ? ` · ${model.account_label}` : ''}
            </option>
          ))}
        </select>
      </label>
      {(state.loading || cloud.loading) && <p role="status">{m.loading}</p>}
      {!state.loading && !cloud.loading && !error && !cloudUnavailable && catalog.length === 0 && (
        <p>{m.noModels}</p>
      )}
      {error && <p role="alert">{m.modelLoadFailed}</p>}
      {!error && !state.loading && cloudUnavailable && (
        <p role="status">{m.cloudModelsUnavailable}</p>
      )}
      <button
        type="button"
        data-testid={`template-model-refresh-${runtime}`}
        disabled={disabled || state.loading || cloud.loading}
        onClick={() => {
          void state.refresh()
          void cloud.refresh()
        }}
      >
        {m.refresh}
      </button>
    </section>
  )
}
