import { AlertCircle, Check, Loader2, MessageSquareText, Play, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { getDefaultModelOptions } from '@/lib/model-ui'
import { cn } from '@/lib/utils'
import type {
  ModelOptions,
  ModelSelectionConfig,
  RuntimeSupervisorMode,
  RuntimeSupervisorState,
  RuntimeSupervisorSuggestion,
  UnifiedModel,
} from '@/types/api'

export interface TaskSupervisorConfig {
  mode: RuntimeSupervisorMode
  instructions: string
  modelSelection: ModelSelectionConfig | null
  intervalSeconds: number
}

interface TaskSupervisorControlProps {
  open: boolean
  supervisor?: RuntimeSupervisorState | null
  initialConfig?: TaskSupervisorConfig | null
  defaultModelSelection?: ModelSelectionConfig | null
  defaultIntervalSeconds?: number
  defaultInstructions?: string
  models?: UnifiedModel[]
  onOpenChange: (open: boolean) => void
  onSet: (
    mode: RuntimeSupervisorMode,
    instructions: string,
    modelSelection: ModelSelectionConfig | null,
    intervalSeconds: number
  ) => Promise<RuntimeSupervisorState | null>
  onClear: () => Promise<void>
  onRunNow?: () => Promise<RuntimeSupervisorState | null>
  className?: string
}

export function TaskSupervisorControl({
  open,
  supervisor,
  initialConfig,
  defaultModelSelection,
  defaultIntervalSeconds = 30,
  defaultInstructions = '',
  models = [],
  onOpenChange,
  onSet,
  onClear,
  onRunNow,
  className,
}: TaskSupervisorControlProps) {
  if (!open) return null

  return (
    <TaskSupervisorDialogContent
      key={`${supervisor?.mode ?? initialConfig?.mode ?? 'disabled'}:${supervisor?.modelSelection?.modelName ?? initialConfig?.modelSelection?.modelName ?? defaultModelSelection?.modelName ?? ''}:${supervisor?.intervalSeconds ?? initialConfig?.intervalSeconds ?? defaultIntervalSeconds}`}
      supervisor={supervisor}
      initialConfig={initialConfig}
      defaultModelSelection={defaultModelSelection}
      defaultIntervalSeconds={defaultIntervalSeconds}
      defaultInstructions={defaultInstructions}
      models={models}
      onOpenChange={onOpenChange}
      onSet={onSet}
      onClear={onClear}
      onRunNow={onRunNow}
      className={className}
    />
  )
}

interface TaskSupervisorStatusButtonProps {
  supervisor: RuntimeSupervisorState
  onClick: () => void
  onRunNow?: () => Promise<RuntimeSupervisorState | null>
}

export function TaskSupervisorStatusButton({
  supervisor,
  onClick,
  onRunNow,
}: TaskSupervisorStatusButtonProps) {
  const { t } = useTranslation('common')
  const [runningNow, setRunningNow] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const pendingCount = supervisor.suggestions.filter(
    suggestion => suggestion.status === 'pending'
  ).length
  const latestSuggestionAt = supervisor.suggestions.reduce(
    (latest, suggestion) => Math.max(latest, suggestion.createdAt),
    0
  )
  const latestCheckFoundNoCorrection =
    Boolean(supervisor.lastEvaluatedAt) && latestSuggestionAt < (supervisor.lastEvaluatedAt ?? 0)
  const statusLabel =
    supervisor.status === 'checking'
      ? t('workbench.supervisor_checking')
      : supervisor.status === 'error'
        ? t('workbench.supervisor_error')
        : latestCheckFoundNoCorrection
          ? t('workbench.supervisor_aligned')
          : t('workbench.supervisor_active')
  const nextCheckAt = supervisor.lastEvaluatedAt
    ? supervisor.lastEvaluatedAt + (supervisor.intervalSeconds ?? 30) * 1_000
    : null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!nextCheckAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [nextCheckAt])

  const nextCheckLabel = nextCheckAt
    ? t('workbench.supervisor_next_check', {
        time: formatCountdown(Math.max(0, nextCheckAt - now)),
      })
    : t('workbench.supervisor_waiting_first_check')

  const runNow = async () => {
    if (!onRunNow) return
    setRunningNow(true)
    setRunError(null)
    try {
      await onRunNow()
    } catch (error) {
      setRunError(error instanceof Error ? error.message : t('workbench.supervisor_run_now_failed'))
    } finally {
      setRunningNow(false)
    }
  }

  return (
    <div className="w-full">
      <div
        data-testid="task-supervisor-status-row"
        className="flex min-h-11 w-full items-center gap-2"
      >
        <button
          type="button"
          data-testid="task-supervisor-toggle-button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-2 text-left text-sm text-text-primary hover:bg-hover"
        >
          <span
            data-testid="task-supervisor-status-icon"
            aria-label={statusLabel}
            title={statusLabel}
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary"
          >
            {supervisor.status === 'error' ? (
              <AlertCircle className="h-[18px] w-[18px] text-amber-600" />
            ) : supervisor.status === 'checking' ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            ) : latestCheckFoundNoCorrection ? (
              <Check className="h-[18px] w-[18px] text-green-500" />
            ) : (
              <ShieldCheck className="h-[18px] w-[18px]" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{t('workbench.supervisor_title')}</span>
          <span
            data-testid="task-supervisor-status-next-check"
            className="shrink-0 text-xs text-text-muted"
          >
            {nextCheckLabel}
          </span>
          {pendingCount > 0 && (
            <span className="rounded-full bg-text-primary px-1.5 text-xs text-background">
              {pendingCount}
            </span>
          )}
        </button>
        {onRunNow && (
          <button
            type="button"
            data-testid="task-supervisor-status-run-now-button"
            disabled={runningNow || supervisor.status === 'checking'}
            onClick={() => void runNow()}
            aria-label={t('workbench.supervisor_run_now')}
            title={t('workbench.supervisor_run_now')}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
          >
            {runningNow ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
      {runError && <p className="ml-[30px] text-xs text-red-600">{runError}</p>}
    </div>
  )
}

function TaskSupervisorDialogContent({
  supervisor,
  initialConfig,
  defaultModelSelection,
  defaultIntervalSeconds = 30,
  defaultInstructions = '',
  models = [],
  onOpenChange,
  onSet,
  onClear,
  onRunNow,
  className,
}: Omit<TaskSupervisorControlProps, 'open'>) {
  const { t } = useTranslation('common')
  const configuredModelSelection: ModelSelectionConfig | null | undefined =
    supervisor?.modelSelection ?? initialConfig?.modelSelection ?? defaultModelSelection
  const configuredModelFromCatalog = models.find(model =>
    modelMatchesSelection(model, configuredModelSelection)
  )
  const configuredModel = configuredModelFromCatalog ?? modelFromSelection(configuredModelSelection)
  const selectableModels =
    configuredModel && !configuredModelFromCatalog ? [configuredModel, ...models] : models
  const [mode, setMode] = useState<RuntimeSupervisorMode>(
    supervisor?.mode ?? initialConfig?.mode ?? 'auto'
  )
  const [instructions, setInstructions] = useState(
    supervisor?.instructions ?? initialConfig?.instructions ?? defaultInstructions
  )
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null)
  const selectedModel =
    selectedModelKey &&
    selectableModels.some(candidate => modelSelectionKey(candidate) === selectedModelKey)
      ? (selectableModels.find(candidate => modelSelectionKey(candidate) === selectedModelKey) ??
        null)
      : (configuredModel ?? selectableModels[0] ?? null)
  const [selectedModelOptions, setSelectedModelOptions] = useState<ModelOptions>(
    configuredModelSelection?.options ?? getDefaultModelOptions(selectedModel)
  )
  const modelKey = modelSelectionKey(selectedModel ?? undefined)
  const [intervalSeconds, setIntervalSeconds] = useState(
    supervisor?.intervalSeconds ?? initialConfig?.intervalSeconds ?? defaultIntervalSeconds
  )
  const [saving, setSaving] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastCheckedAt = supervisor?.lastEvaluatedAt
    ? formatCheckTime(supervisor.lastEvaluatedAt)
    : null
  const nextCheckAt = supervisor?.lastEvaluatedAt
    ? formatCheckTime(
        supervisor.lastEvaluatedAt + (supervisor.intervalSeconds ?? intervalSeconds) * 1_000
      )
    : null
  useEscapeKey(() => {
    if (!saving && !runningNow) onOpenChange(false)
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const modelSelection = selectedModel
        ? {
            modelName: selectedModel.name,
            modelType: selectedModel.type,
            options: {
              ...selectedModelOptions,
              ...(selectedModel.namespace
                ? { weworkCloudModelNamespace: selectedModel.namespace }
                : {}),
              ...(selectedModel.resourceUserId !== undefined
                ? {
                    weworkCloudModelResourceUserId: String(selectedModel.resourceUserId),
                  }
                : {}),
            },
          }
        : null
      await onSet(mode, instructions, modelSelection, intervalSeconds)
      onOpenChange(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const disable = async () => {
    setSaving(true)
    setError(null)
    try {
      await onClear()
      onOpenChange(false)
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    if (!onRunNow) return
    setRunningNow(true)
    setError(null)
    try {
      await onRunNow()
    } catch (runError) {
      setError(
        runError instanceof Error ? runError.message : t('workbench.supervisor_run_now_failed')
      )
    } finally {
      setRunningNow(false)
    }
  }

  return createPortal(
    <div
      data-testid="task-supervisor-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 px-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving && !runningNow) {
          onOpenChange(false)
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-supervisor-dialog-title"
        className={cn(
          'max-h-[calc(100vh-2rem)] w-full max-w-[420px] overflow-y-auto rounded-2xl border border-border/80 bg-background p-5 text-text-primary shadow-xl',
          className
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="task-supervisor-dialog-title" className="text-sm font-medium text-text-primary">
              {t('workbench.supervisor_title')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {t('workbench.supervisor_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="task-supervisor-close-button"
            autoFocus
            disabled={saving || runningNow}
            onClick={() => onOpenChange(false)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-40"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {supervisor && (
          <div
            data-testid="task-supervisor-status"
            className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2 text-xs leading-5 text-text-secondary"
          >
            <div className="min-w-0">
              <p>
                {supervisor.status === 'checking'
                  ? t('workbench.supervisor_checking_detail')
                  : lastCheckedAt
                    ? t('workbench.supervisor_last_checked', { time: lastCheckedAt })
                    : t('workbench.supervisor_waiting_first_check')}
              </p>
              {supervisor.status !== 'checking' && nextCheckAt && (
                <p data-testid="task-supervisor-next-check" className="text-text-muted">
                  {t('workbench.supervisor_next_check', { time: nextCheckAt })}
                </p>
              )}
            </div>
            {onRunNow && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="task-supervisor-run-now-button"
                disabled={saving || runningNow || supervisor.status === 'checking'}
                onClick={runNow}
                className="shrink-0"
              >
                {runningNow && <Loader2 className="animate-spin" />}
                {t('workbench.supervisor_run_now')}
              </Button>
            )}
          </div>
        )}

        <div data-testid="task-supervisor-panel" className="w-full">
          <label className="block text-xs font-medium text-text-secondary">
            {t('workbench.supervisor_mode')}
          </label>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {(['suggest', 'auto'] as const).map(option => (
              <button
                key={option}
                type="button"
                data-testid={`task-supervisor-mode-${option}`}
                className={cn(
                  'rounded-md border px-2 py-1.5 text-xs',
                  mode === option
                    ? 'border-text-primary bg-text-primary text-background'
                    : 'border-border bg-background text-text-secondary hover:bg-surface'
                )}
                onClick={() => setMode(option)}
              >
                {t(`workbench.supervisor_mode_${option}`)}
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-text-secondary">
              {t('workbench.supervisor_model')}
              <div
                data-testid="task-supervisor-model"
                data-value={modelKey}
                className="mt-1 min-w-0"
              >
                <ModelSelector
                  models={selectableModels}
                  selectedModel={selectedModel}
                  selectedModelOptions={selectedModelOptions}
                  disabled={saving || runningNow || selectableModels.length === 0}
                  onSelectModel={model => {
                    if (!model) return false
                    setSelectedModelKey(modelSelectionKey(model))
                    setSelectedModelOptions(getDefaultModelOptions(model))
                    return true
                  }}
                  onSelectModelAndOptions={(model, options) => {
                    setSelectedModelKey(modelSelectionKey(model))
                    setSelectedModelOptions(options)
                  }}
                  onSelectModelOption={(optionId, value) =>
                    setSelectedModelOptions(current => ({ ...current, [optionId]: value }))
                  }
                  menuPlacement="below"
                  buttonClassName="!w-full rounded-md border border-border bg-background px-2 hover:bg-surface"
                  menuClassName="w-72"
                />
              </div>
            </label>
            <label className="block text-xs font-medium text-text-secondary">
              {t('workbench.supervisor_frequency')}
              <select
                data-testid="task-supervisor-frequency"
                value={intervalSeconds}
                onChange={event => setIntervalSeconds(Number(event.target.value))}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary outline-none focus:border-primary"
              >
                {[10, 30, 60, 300].map(seconds => (
                  <option key={seconds} value={seconds}>
                    {t(`workbench.supervisor_frequency_${seconds}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label
            className="mt-3 block text-xs font-medium text-text-secondary"
            htmlFor="task-supervisor-instructions"
          >
            {t('workbench.supervisor_instructions')}
          </label>
          <textarea
            id="task-supervisor-instructions"
            data-testid="task-supervisor-instructions"
            value={instructions}
            onChange={event => setInstructions(event.target.value)}
            placeholder={t('workbench.supervisor_instructions_placeholder')}
            className="mt-1 min-h-24 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
          />

          {supervisor?.lastError && (
            <p className="mt-2 text-xs text-amber-700">{supervisor.lastError}</p>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          <div className="mt-3 flex items-center justify-between gap-2">
            {supervisor || initialConfig ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="task-supervisor-disable-button"
                disabled={saving || runningNow}
                onClick={disable}
              >
                {t('workbench.supervisor_disable')}
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              data-testid="task-supervisor-save-button"
              disabled={saving || runningNow || !modelKey}
              onClick={save}
            >
              {saving && <Loader2 className="animate-spin" />}
              {t('workbench.supervisor_save')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function modelSelectionKey(model: UnifiedModel | undefined): string {
  if (!model) return ''
  return [
    model.type,
    model.name,
    model.namespace ?? '',
    model.resourceUserId === undefined ? '' : String(model.resourceUserId),
  ].join(':')
}

function modelMatchesSelection(
  model: UnifiedModel,
  selection: ModelSelectionConfig | null | undefined
): boolean {
  if (!selection || model.name !== selection.modelName) return false
  if (selection.modelType && model.type !== selection.modelType) return false
  const namespace = selection.options?.weworkCloudModelNamespace
  if (namespace && model.namespace !== namespace) return false
  const resourceUserId = selection.options?.weworkCloudModelResourceUserId
  return !resourceUserId || String(model.resourceUserId) === resourceUserId
}

function modelFromSelection(
  selection: ModelSelectionConfig | null | undefined
): UnifiedModel | undefined {
  if (!selection?.modelName || !selection.modelType) return undefined
  const namespace = selection.options?.weworkCloudModelNamespace
  const resourceUserIdValue = selection.options?.weworkCloudModelResourceUserId
  const resourceUserId = resourceUserIdValue === undefined ? undefined : Number(resourceUserIdValue)
  if (resourceUserId !== undefined && (!Number.isInteger(resourceUserId) || resourceUserId < 0)) {
    return undefined
  }
  return {
    name: selection.modelName,
    type: selection.modelType,
    ...(namespace ? { namespace } : {}),
    ...(resourceUserId !== undefined ? { resourceUserId } : {}),
  }
}

function formatCheckTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatCountdown(durationMs: number): string {
  const totalSeconds = Math.ceil(durationMs / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts = [minutes, seconds]
  if (hours > 0) parts.unshift(hours)
  return parts.map(part => String(part).padStart(2, '0')).join(':')
}

interface SupervisorSuggestionCardsProps {
  suggestions: RuntimeSupervisorSuggestion[]
  onAccept: (suggestion: RuntimeSupervisorSuggestion) => Promise<void>
  onDismiss: (suggestion: RuntimeSupervisorSuggestion) => Promise<void>
}

export function SupervisorSuggestionCards({
  suggestions,
  onAccept,
  onDismiss,
}: SupervisorSuggestionCardsProps) {
  const { t } = useTranslation('common')
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const visible = suggestions.filter(suggestion => suggestion.status === 'pending').slice(-2)
  if (visible.length === 0) return null

  const resolve = async (
    suggestion: RuntimeSupervisorSuggestion,
    action: (suggestion: RuntimeSupervisorSuggestion) => Promise<void>
  ) => {
    setResolvingId(suggestion.id)
    try {
      await action(suggestion)
    } finally {
      setResolvingId(null)
    }
  }

  return (
    <div data-testid="task-supervisor-suggestions" className="mb-2 space-y-2">
      {visible.map(suggestion => (
        <div
          key={suggestion.id}
          data-testid="task-supervisor-suggestion"
          className="rounded-lg border border-border/80 bg-surface px-3 py-2.5 shadow-sm"
        >
          <div className="flex items-start gap-2">
            <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-text-secondary">
                {t('workbench.supervisor_suggestion')}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-text-primary">
                {suggestion.message}
              </p>
              {suggestion.rationale && (
                <p className="mt-1 text-xs leading-5 text-text-muted">{suggestion.rationale}</p>
              )}
            </div>
          </div>
          <div className="mt-2 flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="task-supervisor-dismiss-suggestion"
              disabled={resolvingId === suggestion.id}
              onClick={() => void resolve(suggestion, onDismiss)}
            >
              <X />
              {t('workbench.supervisor_dismiss')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              data-testid="task-supervisor-accept-suggestion"
              disabled={resolvingId === suggestion.id}
              onClick={() => void resolve(suggestion, onAccept)}
            >
              <Check />
              {t('workbench.supervisor_send_correction')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
