import { useMemo, useState } from 'react'
import { Check, Cloud, Copy, HardDrive, Loader2, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { isWeWorkCompatibleDevice } from '@/lib/device-capabilities'
import { cn } from '@/lib/utils'
import type { DeviceInfo, Task, TaskForkRequest } from '@/types/api'

type TargetKey = 'managed' | `device:${string}`

interface TargetOption {
  key: TargetKey
  request: TaskForkRequest
  label: string
  meta: string
  disabled: boolean
  disabledReason?: string
  icon: LucideIcon
}

interface TaskForkDialogProps {
  open: boolean
  task: Task | null
  devices: DeviceInfo[]
  activeDeviceId?: string | null
  requiresStop: boolean
  onOpenChange: (open: boolean) => void
  onStopCurrentResponse: () => Promise<void> | void
  onFork: (request: TaskForkRequest) => Promise<void>
}

function isLocalDevice(device: DeviceInfo): boolean {
  return device.device_type !== 'cloud'
}

function sortDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((left, right) => {
    const leftAvailable = left.status === 'online' ? 0 : left.status === 'busy' ? 1 : 2
    const rightAvailable = right.status === 'online' ? 0 : right.status === 'busy' ? 1 : 2
    if (leftAvailable !== rightAvailable) return leftAvailable - rightAvailable
    return (left.name || left.device_id).localeCompare(right.name || right.device_id)
  })
}

function getDeviceMeta(
  device: DeviceInfo,
  activeDeviceId: string | null | undefined,
  t: ReturnType<typeof useTranslation>['t']
): { disabled: boolean; meta: string } {
  if (device.device_id === activeDeviceId) {
    return {
      disabled: true,
      meta: t('workbench.task_fork_current_target', '当前执行目标'),
    }
  }
  if (!isWeWorkCompatibleDevice(device)) {
    return {
      disabled: true,
      meta: t('workbench.project_device_upgrade_required_short', '需升级'),
    }
  }
  if (device.status === 'offline') {
    return {
      disabled: true,
      meta: t('workbench.project_device_status_offline', '离线'),
    }
  }
  if (device.status === 'busy') {
    return {
      disabled: false,
      meta: t('workbench.project_device_status_busy', '忙碌'),
    }
  }
  return {
    disabled: false,
    meta: t('workbench.project_device_status_online', '在线'),
  }
}

export function TaskForkDialog({
  open,
  task,
  devices,
  activeDeviceId,
  requiresStop,
  onOpenChange,
  onStopCurrentResponse,
  onFork,
}: TaskForkDialogProps) {
  const { t } = useTranslation('common')
  const [selectedKey, setSelectedKey] = useState<TargetKey | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = useMemo<TargetOption[]>(() => {
    const managedDisabled = !activeDeviceId || task?.execution_workspace_source === 'local_path'
    const managedReason =
      task?.execution_workspace_source === 'local_path'
        ? t('workbench.task_fork_local_path_cloud_disabled', '本地目录不能复制到云端执行器')
        : managedDisabled
          ? t('workbench.task_fork_current_target', '当前执行目标')
          : undefined

    const managedOption: TargetOption = {
      key: 'managed',
      request: { target: { type: 'managed' } },
      label: t('workbench.task_fork_cloud_target', '云端执行器'),
      meta: managedReason ?? t('workbench.task_fork_cloud_target_meta', '由 Wegent 托管执行'),
      disabled: managedDisabled,
      disabledReason: managedReason,
      icon: Cloud,
    }

    const localOptions = sortDevices(devices.filter(isLocalDevice)).map(device => {
      const meta = getDeviceMeta(device, activeDeviceId, t)
      const request: TaskForkRequest = {
        target: {
          type: 'device',
          device_id: device.device_id,
        },
      }
      return {
        key: `device:${device.device_id}` as TargetKey,
        request,
        label: device.name || device.device_id,
        meta: meta.meta,
        disabled: meta.disabled,
        disabledReason: meta.disabled ? meta.meta : undefined,
        icon: HardDrive,
      }
    })

    return [managedOption, ...localOptions]
  }, [activeDeviceId, devices, t, task?.execution_workspace_source])

  const enabledOptions = options.filter(option => !option.disabled)
  const selectedOption =
    options.find(option => option.key === selectedKey && !option.disabled) ??
    enabledOptions[0] ??
    null

  if (!open || !task) return null

  const handleSubmit = async () => {
    if (!selectedOption || selectedOption.disabled || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      if (requiresStop) {
        await onStopCurrentResponse()
      }
      await onFork(selectedOption.request)
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
        className="w-full max-w-[420px] rounded-lg border border-border bg-background p-4 shadow-[0_18px_54px_rgba(0,0,0,0.18)]"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-primary">
            <Copy className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="task-fork-dialog-title" className="truncate text-base font-semibold">
              {t('workbench.task_fork_title', '复制任务')}
            </h2>
            <p className="truncate text-xs text-text-muted">{task.title}</p>
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
            const Icon = option.icon
            return (
              <button
                key={option.key}
                type="button"
                data-testid={
                  option.key === 'managed'
                    ? 'task-fork-target-managed'
                    : `task-fork-target-${option.key.slice('device:'.length)}`
                }
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
                title={option.disabledReason}
              >
                <Icon className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-text-muted">{option.meta}</span>
                </span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        </div>

        {enabledOptions.length === 0 && (
          <p data-testid="task-fork-no-target" className="mt-3 text-xs text-text-muted">
            {t('workbench.task_fork_no_target', '暂无可复制的执行目标')}
          </p>
        )}
        {error && (
          <p data-testid="task-fork-error" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="task-fork-cancel-button"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('workbench.cancel', '取消')}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="task-fork-confirm-button"
            disabled={!selectedOption || selectedOption.disabled || submitting}
            onClick={() => {
              void handleSubmit()
            }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting
              ? t('workbench.task_fork_submitting', '正在复制')
              : requiresStop
                ? t('workbench.task_fork_stop_and_confirm', '停止并复制')
                : t('workbench.task_fork_confirm', '复制')}
          </Button>
        </div>
      </section>
    </div>
  )
}
