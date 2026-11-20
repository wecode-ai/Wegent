import { useAgentRouting } from '@/features/collaboration/useAgentRouting'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { runnerSupportsModel } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createRunnerSelectionSource,
  type PendingRunnerSelection as Pending,
} from './runnerSelectionSource'
import { AgentEnvironmentFields, AgentModelFields } from './AgentRoutingFields'

function SelectionDialog({ pending, close }: { pending: Pending; close(): void }) {
  const { t } = useTranslation('common')
  const api = useMemo(
    () => ({
      listEnvironments: async () => pending.request.environments,
      listNativeModels: async (environment: import('@wegent/collaboration').RunnerEnvironment) =>
        environment,
      listModels: async () => pending.request.cloud_models,
    }),
    [pending]
  )
  const routing = useAgentRouting(api, pending.request.runtime, 'execution', {
    cloudOnly: pending.request.cloud_only,
  })
  const legacyFixedModel =
    pending.request.model_policy.mode === 'fixed' && !pending.request.model_policy.model.source
  const modelAvailable = legacyFixedModel
    ? routing.candidates.some(environment =>
        runnerSupportsModel(environment, pending.request.model_policy.model!)
      )
    : routing.modelAvailable
  const loadRouting = routing.load
  const [initialized, setInitialized] = useState<Pending | null>(null)
  // Routing load only initializes React state owned by this dialog.
  if (initialized !== pending) {
    setInitialized(pending)
    loadRouting(
      pending.request.execution_policy.mode === 'user_select'
        ? undefined
        : pending.request.execution_policy,
      pending.request.model_policy.mode === 'fixed' ? pending.request.model_policy : undefined
    )
  }
  const cancel = () => {
    pending.reject(new Error(t('workbench.runner_selection_cancelled')))
    close()
  }
  const dialogRef = useDialogKeyboard<HTMLElement>(cancel, true, 'select:not([disabled])')
  const confirm = () => {
    pending.resolve({
      ...(pending.request.execution_policy.mode === 'user_select'
        ? { execution_policy: routing.executionPolicy! }
        : {}),
      ...(pending.request.model_policy.mode === 'user_select' ? { model: routing.model! } : {}),
    })
    close()
  }
  const valid =
    routing.executionPolicy !== null &&
    modelAvailable &&
    routing.candidates.some(
      environment => routing.model && runnerSupportsModel(environment, routing.model)
    ) &&
    routing.executionPolicy?.mode !== 'user_select' &&
    (pending.request.model_policy.mode === 'fixed' || routing.model !== null)
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="runner-selection-title"
        className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-popover p-5 shadow-lg"
        data-testid="runner-selection-dialog"
      >
        <h2 id="runner-selection-title" className="text-sm font-semibold">
          {t('workbench.runner_selection_title')}
        </h2>
        {pending.request.recovery_from_environment_id && (
          <p className="text-sm text-muted-foreground" data-testid="runner-selection-recovery">
            {t('workbench.runner_selection_recovery')}
          </p>
        )}
        <AgentEnvironmentFields
          selectionOnly
          routing={routing}
          disabled={pending.request.execution_policy.mode !== 'user_select'}
          prefix="runner-selection"
        />
        <AgentModelFields
          selectionOnly
          routing={{
            ...routing,
            modelMode: 'fixed',
            modelAvailable,
            modelPolicy: routing.model ? { mode: 'fixed', model: routing.model } : null,
          }}
          disabled={pending.request.model_policy.mode === 'fixed'}
          prefix="runner-selection"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="runner-selection-cancel" onClick={cancel}>
            {t('workbench.cancel')}
          </Button>
          <Button disabled={!valid} data-testid="runner-selection-confirm" onClick={confirm}>
            {t('workbench.runner_selection_confirm')}
          </Button>
        </div>
      </section>
    </div>
  )
}
export function RunnerSelectionHost() {
  const [source] = useState(createRunnerSelectionSource)
  const queue = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const current = queue[0]
  return current ? (
    <SelectionDialog key={current.id} pending={current} close={() => source.close(current)} />
  ) : null
}
