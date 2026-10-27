import { runnerModelKey, type RunnerEnvironment } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { useAgentRouting } from './useAgentRouting'
import { AgentEnvironmentPicker } from './AgentEnvironmentPicker'

type Routing = ReturnType<typeof useAgentRouting>
const accountSources = (environment: RunnerEnvironment) =>
  [...new Set(environment.models.map(model => model.account_label).filter(Boolean))].join(', ')

const selectClass =
  'wework-native-select h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none keyboard:focus:ring-2 keyboard:focus:ring-focus/20 disabled:opacity-50 md:h-9'

export function AgentEnvironmentFields({
  routing,
  disabled,
  prefix,
  selectionOnly = false,
}: {
  routing: Routing
  disabled: boolean
  prefix: string
  selectionOnly?: boolean
}) {
  const { t } = useTranslation('common')
  const policy = routing.executionPolicy
  const environment =
    policy?.mode === 'fixed'
      ? routing.environments.find(item => item.id === policy.environment_id)
      : undefined
  return (
    <div className="space-y-3">
      <div className="block space-y-1 text-sm">
        <span>{t('workbench.runner_environment')}</span>
        <AgentEnvironmentPicker
          testId={`${prefix}-environment`}
          disabled={disabled}
          loading={routing.environmentLoading}
          environments={routing.environments}
          selectionOnly={selectionOnly}
          projectScoped={routing.hasProject}
          value={
            policy?.mode === 'fixed' ? policy.environment_id : policy ? `policy:${policy.mode}` : ''
          }
          onChange={value =>
            routing.setExecutionPolicy(
              value === 'policy:project_pool'
                ? { mode: 'project_pool' }
                : value === 'policy:user_select'
                  ? { mode: 'user_select' }
                  : { mode: 'fixed', environment_id: value }
            )
          }
        />
      </div>
      {environment ? (
        <p className="text-xs text-text-muted">
          {t(`workbench.runner_owner_${environment.owner_type}`)} ·{' '}
          {t(`workbench.runner_status_${environment.status}`)} ·{' '}
          {accountSources(environment) || t('workbench.runner_account_unknown')}
        </p>
      ) : policy?.mode === 'fixed' && policy.environment_id && !routing.environmentLoading ? (
        <p role="alert" className="text-xs text-destructive">
          {t('workbench.runner_environment_unavailable_hint')}
        </p>
      ) : null}
      {routing.executionPolicy?.mode === 'project_pool' && (
        <p className="text-xs text-text-muted">{t('workbench.runner_project_pool_hint')}</p>
      )}
      {routing.executionPolicy?.mode === 'user_select' && (
        <p className="text-xs text-text-muted">{t('workbench.runner_default_hint')}</p>
      )}
      {routing.candidates
        .filter(environment => environment.catalog_error)
        .map(environment => (
          <p key={environment.id} role="alert" className="text-xs text-destructive">
            {environment.name} ·{' '}
            {environment
              .catalog_error!.split(',')
              .map(code =>
                t(`workbench.runner_catalog_${code.trim()}`, {
                  defaultValue: t('workbench.runner_catalog_error'),
                })
              )
              .join(' · ')}
          </p>
        ))}
      {routing.error && (
        <p role="alert" className="text-xs text-destructive">
          {routing.error}
        </p>
      )}
    </div>
  )
}

export function AgentModelFields({
  routing,
  disabled,
  prefix,
  selectionOnly = false,
}: {
  routing: Routing
  disabled: boolean
  prefix: string
  selectionOnly?: boolean
}) {
  const { t } = useTranslation('common')
  const environmentSelected = Boolean(
    routing.executionPolicy &&
    (routing.executionPolicy.mode !== 'fixed' || routing.executionPolicy.environment_id)
  )

  const chooseAtRuntime = !selectionOnly && routing.modelMode === 'user_select'
  const sources =
    !chooseAtRuntime && routing.model
      ? routing.candidates.flatMap(environment => {
          const model = environment.models.find(
            candidate => runnerModelKey(candidate) === runnerModelKey(routing.model!)
          )
          return model ? [{ environment, account: model.account_label }] : []
        })
      : []

  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-sm">
        <span>{t('workbench.agent_creator_model')}</span>
        <select
          className={selectClass}
          data-testid={`${prefix}-model`}
          disabled={disabled || routing.loading || !environmentSelected}
          value={
            chooseAtRuntime ? 'user_select' : routing.model ? runnerModelKey(routing.model) : ''
          }
          onChange={event => {
            if (event.target.value === 'user_select') {
              routing.setModelMode('user_select')
              routing.setModel(null)
              return
            }
            const selected = routing.models.find(
              item => runnerModelKey(item) === event.target.value
            )
            routing.setModelMode('fixed')
            routing.setModel(
              selected
                ? {
                    runtime: selected.runtime,
                    provider: selected.provider,
                    model_id: selected.model_id,
                    source: selected.source ?? 'native',
                    ...(selected.cloud_model ? { cloud_model: selected.cloud_model } : {}),
                  }
                : null
            )
          }}
        >
          <option value="" disabled>
            {t('workbench.agent_creator_model_placeholder')}
          </option>
          {!selectionOnly && (
            <option value="user_select">{t('workbench.runner_user_select')}</option>
          )}
          {routing.model && !routing.modelAvailable && (
            <option value={runnerModelKey(routing.model)} disabled>
              {routing.model.model_id}
              {!routing.loading &&
                !routing.nativeLoading &&
                ` · ${t('workbench.runner_model_unavailable')}`}
            </option>
          )}
          {routing.models.map(model => (
            <option key={runnerModelKey(model)} value={runnerModelKey(model)}>
              {model.label} ·{' '}
              {t(
                model.source === 'cloud'
                  ? 'workbench.runner_model_cloud'
                  : 'workbench.runner_model_native'
              )}
            </option>
          ))}
        </select>
      </label>
      {chooseAtRuntime && (
        <p className="text-xs text-text-muted">
          {t(
            routing.executionPolicy?.mode === 'fixed'
              ? 'workbench.runner_model_at_fixed_runtime_hint'
              : 'workbench.runner_model_at_runtime_hint'
          )}
        </p>
      )}
      {!environmentSelected && (
        <p className="text-xs text-text-muted">
          {t('workbench.runner_model_requires_environment')}
        </p>
      )}
      {environmentSelected &&
        !routing.loading &&
        !routing.nativeLoading &&
        routing.models.length === 0 &&
        !chooseAtRuntime && (
          <p className="text-xs text-text-muted">{t('workbench.runner_no_models')}</p>
        )}
      {sources.length > 0 && (
        <ul
          aria-label={t('workbench.runner_model_sources')}
          className="max-h-24 space-y-1 overflow-y-auto text-xs text-text-muted"
          data-testid={`${prefix}-model-sources`}
        >
          {sources.map(({ environment, account }) => (
            <li key={environment.id}>
              {routing.executionPolicy?.mode === 'fixed' ? (
                t('workbench.runner_account_source', {
                  source: account || t('workbench.runner_account_unknown'),
                })
              ) : (
                <>
                  {environment.name} · {t(`workbench.runner_owner_${environment.owner_type}`)} ·{' '}
                  {account || t('workbench.runner_account_unknown')} ·{' '}
                  {t(`workbench.runner_status_${environment.status}`)}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {environmentSelected &&
        routing.modelMode === 'fixed' &&
        routing.model &&
        !routing.modelAvailable &&
        !(routing.nativeLoading && routing.model.source !== 'cloud') &&
        !routing.loading && (
          <p role="alert" className="text-xs text-destructive">
            {t('workbench.runner_model_conflict')}
          </p>
        )}
    </div>
  )
}
