import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { runnerModelKey, type RunnerModelIdentity } from '../agent-form/runnerRouting'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'
import { createTemplateModelCatalog } from './templateModelCatalog'

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
  const { host, projectId, environmentId, location } = configuration
  const source = useMemo(
    () =>
      createTemplateModelCatalog(runtime, {
        host,
        projectId,
        environmentId,
        location,
      }),
    [runtime, host, projectId, environmentId, location]
  )
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, onChange),
    [source, onChange]
  )
  const { catalog, selected, loading, cloudLoading, error, cloudUnavailable } =
    useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
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
          onChange={event => source.select(event.target.value)}
        >
          <option value="">{m.chooseModel}</option>
          {catalog.map(model => (
            <option
              key={runnerModelKey(model)}
              value={runnerModelKey(model)}
              disabled={model.source === 'cloud' && (cloudLoading || cloudUnavailable)}
            >
              {model.label || model.model_id}
              {model.account_label ? ` · ${model.account_label}` : ''}
            </option>
          ))}
        </select>
      </label>
      {(loading || cloudLoading) && <p role="status">{m.loading}</p>}
      {!loading && !cloudLoading && !error && !cloudUnavailable && catalog.length === 0 && (
        <p>{m.noModels}</p>
      )}
      {error && <p role="alert">{m.modelLoadFailed}</p>}
      {!error && !loading && cloudUnavailable && <p role="status">{m.cloudModelsUnavailable}</p>}
      <button
        type="button"
        data-testid={`template-model-refresh-${runtime}`}
        disabled={disabled || loading || cloudLoading}
        onClick={() => source.refresh()}
      >
        {m.refresh}
      </button>
    </section>
  )
}
