import { useMemo, useState } from 'react'
import { ArrowLeftRight, Check, FolderPlus, HardDrive, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import type {
  DeleteDeviceWorkspaceRequest,
  DeviceInfo,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeProjectWork,
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
  workspaceKind?: string | null
}

interface TaskForkDialogProps {
  open: boolean
  source: RuntimeTaskAddress | null
  runtimeWork: RuntimeWorkListResponse | null
  currentProject?: ProjectWithTasks | null
  devices?: DeviceInfo[]
  requiresStop: boolean
  onOpenChange: (open: boolean) => void
  onStopCurrentResponse: () => Promise<void> | void
  onFork: (target: RuntimeTaskForkTarget) => Promise<void>
  onPrepareDeviceWorkspace?: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onDeleteDeviceWorkspace?: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
}

function targetKey(target: RuntimeTaskForkTarget): string {
  return `${target.deviceId}:${target.workspacePath}`
}

function runtimeTaskMatches(address: RuntimeTaskAddress, workspace: RuntimeDeviceWorkspace) {
  if (workspace.deviceId !== address.deviceId) return false
  const matchedTask = workspace.tasks.some(task => task.taskId === address.taskId)
  if (!matchedTask) return false

  const addressPath = address.workspacePath?.trim()
  if (!addressPath) return true
  return workspace.workspacePath === addressPath
}

function findSourceProjectWork(
  runtimeWork: RuntimeWorkListResponse | null,
  source: RuntimeTaskAddress | null,
  currentProject?: ProjectWithTasks | null
): RuntimeProjectWork | null {
  if (!runtimeWork) return null
  if (source) {
    const matched = runtimeWork.projects.find(project =>
      project.deviceWorkspaces.some(workspace => runtimeTaskMatches(source, workspace))
    )
    if (matched) return matched
  }

  if (currentProject) {
    return (
      runtimeWork.projects.find(
        project => runtimeProjectUiId(project.project) === currentProject.id
      ) ?? null
    )
  }

  if (runtimeWork.projects.length === 1) {
    return runtimeWork.projects[0]
  }

  return null
}

function getDeviceLabel(device: DeviceInfo) {
  return device.name || device.device_id
}

export function TaskForkDialog({
  open,
  source,
  runtimeWork,
  currentProject,
  devices = [],
  requiresStop,
  onOpenChange,
  onStopCurrentResponse,
  onFork,
  onPrepareDeviceWorkspace,
  onDeleteDeviceWorkspace,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
}: TaskForkDialogProps) {
  const { t } = useTranslation('common')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [bindingDialogDeviceId, setBindingDialogDeviceId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sourceProjectWork = useMemo(
    () => findSourceProjectWork(runtimeWork, source, currentProject),
    [currentProject, runtimeWork, source]
  )
  const targetProjectId =
    currentProject?.id ?? (sourceProjectWork ? runtimeProjectUiId(sourceProjectWork.project) : null)
  const projectWorkspaces = useMemo(
    () => sourceProjectWork?.deviceWorkspaces ?? [],
    [sourceProjectWork]
  )
  const sourceDeviceId = source?.deviceId ?? null
  const options = useMemo<TargetOption[]>(() => {
    const seen = new Set<string>()
    const nextOptions: TargetOption[] = []
    projectWorkspaces.forEach(workspace => {
      if (sourceDeviceId && workspace.deviceId === sourceDeviceId) return

      const target = {
        deviceId: workspace.deviceId,
        workspacePath: workspace.workspacePath,
      }
      const key = targetKey(target)
      if (seen.has(key)) return

      seen.add(key)
      const sameWorkspace =
        source?.deviceId === target.deviceId && source.workspacePath === target.workspacePath
      const disabled = sameWorkspace || !workspace.available
      nextOptions.push({
        key,
        target,
        label: workspace.deviceName || workspace.deviceId,
        meta: sameWorkspace
          ? t('workbench.task_fork_current_target', '当前执行目标')
          : [workspace.workspacePath, workspace.workspaceKind === 'worktree' ? 'Worktree' : null]
              .filter(Boolean)
              .join(' · '),
        disabled,
        workspaceKind: workspace.workspaceKind,
      })
    })
    return nextOptions.sort((left, right) => Number(left.disabled) - Number(right.disabled))
  }, [projectWorkspaces, source, sourceDeviceId, t])
  const boundDeviceIds = useMemo(
    () => new Set(projectWorkspaces.map(workspace => workspace.deviceId)),
    [projectWorkspaces]
  )
  const bindableDevices = useMemo(
    () =>
      devices.filter(
        device =>
          device.status === 'online' &&
          device.device_id !== sourceDeviceId &&
          !boundDeviceIds.has(device.device_id) &&
          device.bind_shell === 'claudecode'
      ),
    [boundDeviceIds, devices, sourceDeviceId]
  )

  const enabledOptions = options.filter(option => !option.disabled)
  const selectedOption =
    options.find(option => option.key === selectedKey && !option.disabled) ??
    enabledOptions[0] ??
    null
  const projectForBinding: ProjectWithTasks | null =
    currentProject ?? (sourceProjectWork ? runtimeProjectToProject(sourceProjectWork) : null)

  if (!open || !source) return null

  const handleSubmit = async () => {
    if (submitting) return
    if (!selectedOption) return
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

  const handleDeviceWorkspacePrepared = async (response: DeviceWorkspacePrepareResponse) => {
    setSubmitting(true)
    setError(null)
    try {
      if (requiresStop) {
        await onStopCurrentResponse()
      }
      await onFork({
        deviceId: response.mapping.deviceId,
        workspacePath: response.mapping.workspacePath,
      })
      setBindingDialogDeviceId(null)
      onOpenChange(false)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('workbench.task_fork_failed'))
      throw caughtError
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
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
              <p className="truncate text-xs text-text-muted">{source.taskId}</p>
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

          <p data-testid="task-fork-guidance" className="mt-4 text-xs leading-5 text-text-muted">
            {t(
              'workbench.task_fork_guidance',
              '选择其他设备上的项目工作区，复制后会在目标设备继续。'
            )}
          </p>

          <div className="mt-4 space-y-2" role="radiogroup">
            {options.map(option => {
              const selected = selectedOption?.key === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  data-testid={`task-fork-target-${option.target.deviceId}`}
                  disabled={option.disabled || submitting}
                  onClick={() => {
                    setSelectedKey(option.key)
                    setBindingDialogDeviceId(null)
                  }}
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
            {targetProjectId &&
              onPrepareDeviceWorkspace &&
              bindableDevices.map(device => {
                const selected = bindingDialogDeviceId === device.device_id
                return (
                  <button
                    key={device.device_id}
                    type="button"
                    data-testid={`task-fork-bind-device-${device.device_id}`}
                    disabled={submitting}
                    onClick={() => {
                      setSelectedKey(null)
                      setBindingDialogDeviceId(device.device_id)
                    }}
                    className={cn(
                      'flex min-h-[52px] w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors',
                      selected
                        ? 'border-text-primary bg-surface text-text-primary'
                        : 'border-border bg-background text-text-primary hover:bg-surface'
                    )}
                    aria-checked={selected}
                    role="radio"
                  >
                    <FolderPlus className="h-4 w-4 shrink-0 text-text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {getDeviceLabel(device)}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {t('workbench.task_fork_bind_device_path', '绑定设备路径')}
                      </span>
                    </span>
                    {selected && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                )
              })}
          </div>

          {options.length === 0 && bindableDevices.length === 0 && (
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
      {projectForBinding && bindingDialogDeviceId && onPrepareDeviceWorkspace && (
        <ProjectCreateDialog
          open
          mode="existing"
          project={projectForBinding}
          devices={devices}
          preferredDeviceId={bindingDialogDeviceId}
          onClose={() => setBindingDialogDeviceId(null)}
          onCreateProject={async () => projectForBinding}
          onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
          onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
          onDeviceWorkspacePrepared={handleDeviceWorkspacePrepared}
          showWorkspaceKindSelect
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory ?? (() => Promise.resolve('/'))}
          onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot ?? (() => Promise.resolve('/'))}
          onListDeviceDirectories={onListDeviceDirectories ?? (() => Promise.resolve([]))}
          onCreateDeviceDirectory={onCreateDeviceDirectory ?? (() => Promise.resolve())}
        />
      )}
    </>
  )
}
