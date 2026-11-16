import { Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { isImeEnterEvent } from '@/lib/ime'
import { cn } from '@/lib/utils'
import type { DeviceInfo } from '@/types/api'
import { getPreferredStandaloneWorkspaceDevice } from './standaloneProjectDevices'
import { joinPath } from './device-folder-path'

function getUniqueProjectDirectoryName(baseName: string, existingNames: string[]): string {
  const existingNameSet = new Set(existingNames.map(name => name.trim()).filter(Boolean))
  if (!existingNameSet.has(baseName)) return baseName

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`
    if (!existingNameSet.has(candidate)) return candidate
  }

  return `${baseName} ${Date.now()}`
}

export function StandaloneBlankProjectDialog({
  open,
  devices,
  preferredDeviceId,
  layer = 'modal',
  onClose,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenStandaloneWorkspace,
}: {
  open: boolean
  devices: DeviceInfo[]
  preferredDeviceId?: string | null
  layer?: 'modal' | 'system-popover'
  onClose: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string,
    projectRoots?: string[]
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const [projectName, setProjectName] = useState('New project')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targetDevice = useMemo(
    () => getPreferredStandaloneWorkspaceDevice(devices, preferredDeviceId, 'existing'),
    [devices, preferredDeviceId]
  )

  useEscapeKey(onClose, open && !submitting)

  if (!open) return null

  const submit = async () => {
    const trimmedName = projectName.trim()
    if (!trimmedName || submitting) return
    if (!targetDevice) {
      setError(t('workbench.no_local_project_device', '暂无可用本地设备'))
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const homeDirectory = await onGetDeviceHomeDirectory(targetDevice.device_id)
      const documentsPath = joinPath(homeDirectory, 'Documents')
      await onCreateDeviceDirectory(targetDevice.device_id, documentsPath)
      const existingDirectoryNames = await onListDeviceDirectories(
        targetDevice.device_id,
        documentsPath
      )
      const projectDirectoryName = getUniqueProjectDirectoryName(
        trimmedName,
        existingDirectoryNames
      )
      const workspacePath = joinPath(documentsPath, projectDirectoryName)
      await onCreateDeviceDirectory(targetDevice.device_id, workspacePath)
      await onOpenStandaloneWorkspace?.(targetDevice.device_id, workspacePath, trimmedName)
      onClose()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t('workbench.project_create_failed', '项目创建失败')
      )
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center bg-black/35 px-4',
        layer === 'system-popover' ? 'z-system-popover' : 'z-modal'
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="standalone-blank-project-dialog"
        className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 text-text-primary shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="heading-base">
              {t('workbench.blank_project_name_title', '为项目命名')}
            </h2>
            <p className="mt-2 text-sm leading-5 text-text-secondary">
              {t('workbench.blank_project_name_desc', '保持简短且易识别')}
            </p>
          </div>
          <button
            type="button"
            data-testid="close-standalone-blank-project-dialog"
            disabled={submitting}
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <input
          data-testid="standalone-blank-project-name-input"
          value={projectName}
          autoFocus
          onFocus={event => event.currentTarget.select()}
          disabled={submitting}
          onChange={event => {
            setProjectName(event.target.value)
            setError(null)
          }}
          onKeyDown={event => {
            if (isImeEnterEvent(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          className="mt-5 h-12 w-full rounded-xl border border-border bg-transparent px-4 text-base text-text-primary outline-none keyboard:focus:border-primary keyboard:focus:ring-2 keyboard:focus:ring-primary/10 disabled:opacity-50"
        />
        {error && <p className="mt-3 text-xs text-destructive wework:text-red-500">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-standalone-blank-project-button"
            disabled={submitting}
            onClick={onClose}
            className="h-10 rounded-xl border border-border px-5 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="save-standalone-blank-project-button"
            disabled={!projectName.trim() || submitting || !targetDevice}
            onClick={() => void submit()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-text-primary px-5 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('workbench.save', '保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
