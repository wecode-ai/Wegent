import { useMemo, useState } from 'react'
import { ArrowLeftRight, Check, HardDrive, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskForkTarget,
  RuntimeWorkListResponse,
} from '@/types/api'

interface TargetOption {
  key: string
  target: RuntimeTaskForkTarget
  label: string
  meta: string
  disabled: boolean
}

interface TaskForkDialogProps {
  open: boolean
  source: RuntimeTaskAddress | null
  runtimeWork: RuntimeWorkListResponse | null
  requiresStop: boolean
  onOpenChange: (open: boolean) => void
  onStopCurrentResponse: () => Promise<void> | void
  onFork: (target: RuntimeTaskForkTarget) => Promise<void>
}

function collectRuntimeWorkspaces(
  runtimeWork: RuntimeWorkListResponse | null
): RuntimeDeviceWorkspace[] {
  if (!runtimeWork) return []
  return [
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ...runtimeWork.unmappedDeviceWorkspaces,
  ]
}

function targetKey(target: RuntimeTaskForkTarget): string {
  return `${target.deviceId}:${target.workspacePath}`
}

export function TaskForkDialog({
  open,
  source,
  runtimeWork,
  requiresStop,
  onOpenChange,
  onStopCurrentResponse,
  onFork,
}: TaskForkDialogProps) {
  const { t } = useTranslation('common')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = useMemo<TargetOption[]>(() => {
    const seen = new Set<string>()
    return collectRuntimeWorkspaces(runtimeWork)
      .map(workspace => {
        const target = {
          deviceId: workspace.deviceId,
          workspacePath: workspace.workspacePath,
        }
        const key = targetKey(target)
        if (seen.has(key)) return null
        seen.add(key)
        const sameWorkspace =
          source?.deviceId === target.deviceId && source.workspacePath === target.workspacePath
        const disabled = sameWorkspace || !workspace.available
        return {
          key,
          target,
          label: workspace.deviceName || workspace.deviceId,
          meta: sameWorkspace
            ? t('workbench.task_fork_current_target', '当前执行目标')
            : workspace.workspacePath,
          disabled,
        }
      })
      .filter((option): option is TargetOption => Boolean(option))
      .sort((left, right) => Number(left.disabled) - Number(right.disabled))
  }, [runtimeWork, source, t])

  const enabledOptions = options.filter(option => !option.disabled)
  const selectedOption =
    options.find(option => option.key === selectedKey && !option.disabled) ??
    enabledOptions[0] ??
    null

  if (!open || !source) return null

  const handleSubmit = async () => {
    if (!selectedOption || selectedOption.disabled || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      if (requiresStop) {
        await onStopCurrentResponse()
      }
      await onFork(selectedOption.target)
      onOpenChange(false)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('workbench.task_fork_failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      data-testid="task-fork-dialog-backdrop"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 px-4"
      onMouseDown={() => {
        if (!submitting) onOpenChange(false)
      }}
    >
      <section
        data-testid="task-fork-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-fork-dialog-title"
        className="w-full max-w-[460px] rounded-lg border border-border bg-background p-4 shadow-[0_18px_54px_rgba(0,0,0,0.18)]"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-primary">
            <ArrowLeftRight className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="task-fork-dialog-title" className="truncate text-base font-semibold">
              {t('workbench.task_fork_title', '复制任务')}
            </h2>
            <p className="truncate text-xs text-text-muted">{source.localTaskId}</p>
          </div>
          <button
            type="button"
            data-testid="task-fork-close-button"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            className="flex h-9 min-w-[44px] items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-50"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {requiresStop && (
          <div
            data-testid="task-fork-stop-notice"
            className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            {t('workbench.task_fork_stop_notice', '当前任务正在执行。复制前会先停止当前回复。')}
          </div>
        )}

        <div className="mt-4 space-y-2" role="radiogroup">
          {options.map(option => {
            const selected = selectedOption?.key === option.key
            return (
              <button
                key={option.key}
                type="button"
                data-testid={`task-fork-target-${option.target.deviceId}`}
                disabled={option.disabled || submitting}
                onClick={() => setSelectedKey(option.key)}
                className={cn(
                  'flex min-h-[52px] w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors',
                  selected
                    ? 'border-text-primary bg-surface text-text-primary'
                    : 'border-border bg-background text-text-primary hover:bg-surface',
                  option.disabled && 'cursor-not-allowed opacity-50 hover:bg-background'
                )}
                aria-checked={selected}
                role="radio"
              >
                <HardDrive className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-text-muted">{option.meta}</span>
                </span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        </div>

        {options.length === 0 && (
          <div className="mt-4 rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-muted">
            {t('workbench.task_fork_no_target', '暂无可复制的执行目标')}
          </div>
        )}

        {error && (
          <div
            data-testid="task-fork-error"
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            data-testid="task-fork-cancel-button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('workbench.cancel', '取消')}
          </Button>
          <Button
            type="button"
            data-testid="task-fork-confirm-button"
            variant="primary"
            disabled={!selectedOption || submitting}
            onClick={handleSubmit}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {requiresStop
              ? t('workbench.task_fork_stop_and_confirm', '停止并复制')
              : t('workbench.task_fork_confirm', '复制')}
          </Button>
        </div>
      </section>
    </div>
  )
}
