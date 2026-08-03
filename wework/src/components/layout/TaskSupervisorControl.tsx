import { AlertCircle, Check, Eye, Loader2, MessageSquareText, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  RuntimeSupervisorMode,
  RuntimeSupervisorState,
  RuntimeSupervisorSuggestion,
  UnifiedModel,
} from '@/types/api'

interface TaskSupervisorControlProps {
  supervisor?: RuntimeSupervisorState | null
  defaultInstructions?: string
  models?: UnifiedModel[]
  onSet: (
    mode: RuntimeSupervisorMode,
    instructions: string,
    modelId: string | null,
    intervalSeconds: number
  ) => Promise<RuntimeSupervisorState | null>
  onClear: () => Promise<void>
  className?: string
}

export function TaskSupervisorControl({
  supervisor,
  defaultInstructions = '',
  models = [],
  onSet,
  onClear,
  className,
}: TaskSupervisorControlProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<RuntimeSupervisorMode>(supervisor?.mode ?? 'suggest')
  const [instructions, setInstructions] = useState(supervisor?.instructions ?? defaultInstructions)
  const [modelId, setModelId] = useState(supervisor?.modelId ?? '')
  const [intervalSeconds, setIntervalSeconds] = useState(supervisor?.intervalSeconds ?? 30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pendingCount =
    supervisor?.suggestions.filter(suggestion => suggestion.status === 'pending').length ?? 0
  const latestSuggestionAt = supervisor?.suggestions.reduce(
    (latest, suggestion) => Math.max(latest, suggestion.createdAt),
    0
  )
  const latestCheckFoundNoCorrection =
    Boolean(supervisor?.lastEvaluatedAt) &&
    (latestSuggestionAt ?? 0) < (supervisor?.lastEvaluatedAt ?? 0)
  const statusLabel =
    supervisor?.status === 'checking'
      ? t('workbench.supervisor_checking')
      : supervisor?.status === 'error'
        ? t('workbench.supervisor_error')
        : latestCheckFoundNoCorrection
          ? t('workbench.supervisor_aligned')
          : t('workbench.supervisor_active')
  const lastCheckedAt = supervisor?.lastEvaluatedAt
    ? new Date(supervisor.lastEvaluatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSet(mode, instructions, modelId || null, intervalSeconds)
      setOpen(false)
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
      setOpen(false)
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={cn('relative flex shrink-0 items-center', className)}>
      <button
        type="button"
        data-testid="task-supervisor-toggle-button"
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs shadow-sm transition-colors',
          supervisor
            ? 'border-border/70 bg-surface text-text-secondary hover:bg-background'
            : 'border-dashed border-border/70 bg-background text-text-muted hover:bg-surface'
        )}
        aria-label={t('workbench.supervisor_title')}
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setMode(supervisor?.mode ?? 'suggest')
            setInstructions(supervisor?.instructions ?? defaultInstructions)
            setModelId(supervisor?.modelId ?? '')
            setIntervalSeconds(supervisor?.intervalSeconds ?? 30)
          }
          setOpen(value => !value)
        }}
      >
        {supervisor?.status === 'error' ? (
          <AlertCircle className="h-4 w-4 text-amber-600" />
        ) : supervisor?.status === 'checking' ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : supervisor ? (
          <ShieldCheck className="h-4 w-4 text-primary" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
        <span>{supervisor ? statusLabel : t('workbench.supervisor_enable')}</span>
        {pendingCount > 0 && (
          <span className="rounded-full bg-text-primary px-1.5 text-background">
            {pendingCount}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="task-supervisor-panel"
          className="absolute bottom-[calc(100%+0.5rem)] right-0 z-popover max-h-[calc(100vh-8rem)] w-80 overflow-y-auto rounded-lg border border-border/80 bg-background p-3 shadow-lg"
        >
          <div className="mb-3">
            <div className="text-sm font-medium text-text-primary">
              {t('workbench.supervisor_title')}
            </div>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {t('workbench.supervisor_description')}
            </p>
            {supervisor && (
              <p
                data-testid="task-supervisor-status"
                className="mt-1 text-xs leading-5 text-text-secondary"
              >
                {supervisor.status === 'checking'
                  ? t('workbench.supervisor_checking_detail')
                  : lastCheckedAt
                    ? t('workbench.supervisor_last_checked', { time: lastCheckedAt })
                    : t('workbench.supervisor_waiting_first_check')}
              </p>
            )}
          </div>

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
              <select
                data-testid="task-supervisor-model"
                value={modelId}
                onChange={event => setModelId(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary outline-none focus:border-primary"
              >
                <option value="">{t('workbench.supervisor_model_current')}</option>
                {models.map(model => (
                  <option key={`${model.type}:${model.name}`} value={model.name}>
                    {model.displayName || model.name}
                  </option>
                ))}
              </select>
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
            {supervisor ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="task-supervisor-disable-button"
                disabled={saving}
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
              disabled={saving}
              onClick={save}
            >
              {saving && <Loader2 className="animate-spin" />}
              {t('workbench.supervisor_save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
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
