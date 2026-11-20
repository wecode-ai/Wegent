import { useTranslation } from '@/hooks/useTranslation'
import { runnerModelKey, type RunnerEnvironment } from '@wegent/collaboration'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AgentEnvironmentPicker } from './AgentEnvironmentPicker'
import type { useAgentRouting } from './useAgentRouting'

type Routing = ReturnType<typeof useAgentRouting>
const accountSources = (environment: RunnerEnvironment) =>
  [...new Set(environment.models.map(model => model.account_label).filter(Boolean))].join(', ')

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
          open={routing.environmentPickerOpen}
          onOpenChange={routing.setEnvironmentPickerOpen}
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
      {selectionOnly &&
        !routing.environmentLoading &&
        !routing.environments.some(item => item.project_authorized) && (
          <p
            role="status"
            className="text-xs text-text-muted"
            data-testid={`${prefix}-environment-empty`}
          >
            {t('workbench.runner_environment_setup_hint')}
          </p>
        )}
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

  const modelValue = chooseAtRuntime
    ? 'user_select'
    : routing.model
      ? runnerModelKey(routing.model)
      : ''

  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-sm">
        <span>{t('workbench.agent_creator_model')}</span>
        <SelectRoot
          disabled={disabled || routing.loading || !environmentSelected}
          value={normalizeSelectValue(modelValue)}
          onValueChange={selectedValue => {
            if (selectedValue === null) return
            if (selectedValue === 'user_select') {
              routing.setModelMode('user_select')
              routing.setModel(null)
              return
            }
            const selected = routing.models.find(item => runnerModelKey(item) === selectedValue)
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
          <SelectTrigger
            className="w-full"
            data-testid={`${prefix}-model`}
            data-value={modelValue}
          />
          <SelectContent data-testid={`${prefix}-model-menu`}>
            <SelectItem value="" disabled>
              {t('workbench.agent_creator_model_placeholder')}
            </SelectItem>
            {!selectionOnly && (
              <SelectItem value="user_select">{t('workbench.runner_user_select')}</SelectItem>
            )}
            {routing.model && !routing.modelAvailable && (
              <SelectItem
                value={String(runnerModelKey(routing.model))}
                disabled={!routing.persistedModelSupported}
              >
                {routing.model.model_id}
                {!routing.persistedModelSupported &&
                  !routing.loading &&
                  !routing.nativeLoading &&
                  ` · ${t('workbench.runner_model_unavailable')}`}
              </SelectItem>
            )}
            {routing.models.map(model => (
              <SelectItem key={runnerModelKey(model)} value={String(runnerModelKey(model))}>
                {model.label} ·{' '}
                {t(
                  model.source === 'cloud'
                    ? 'workbench.runner_model_cloud'
                    : 'workbench.runner_model_native'
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
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
          <div
            className="space-y-2 text-sm text-text-secondary"
            role="status"
            data-testid={`${prefix}-model-empty`}
          >
            <p>{t('workbench.runner_no_models')}</p>
            {!selectionOnly && routing.executionPolicy?.mode === 'project_pool' && (
              <>
                <p>{t('workbench.runner_automatic_native_hint')}</p>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`${prefix}-choose-device`}
                  disabled={disabled || routing.environmentLoading}
                  className="rounded-md px-2 py-1 text-text-primary underline underline-offset-4 outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70 hover:bg-muted disabled:opacity-40"
                  onClick={() => routing.setEnvironmentPickerOpen(true)}
                >
                  {t('workbench.runner_specify_device')}
                </ControlButton>
              </>
            )}
          </div>
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
        !routing.persistedModelSupported &&
        !(routing.nativeLoading && routing.model.source !== 'cloud') &&
        !routing.loading && (
          <p role="alert" className="text-xs text-destructive">
            {t('workbench.runner_model_conflict')}
          </p>
        )}
    </div>
  )
}
