import { Folder, FolderPlus, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { shouldUseNativeProjectDirectoryPicker } from '@/e2e/automation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { openNativeProjectDirectoryPickers } from '@/lib/native-directory-picker'
import type { DeviceInfo } from '@/types/api'
import { DeviceFolderPicker } from './DeviceFolderPicker'

interface LocalProjectCreateDialogProps {
  open: boolean
  device: DeviceInfo | null
  initialRoots: string[]
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onClose: () => void
  onCreate: (data: { deviceId: string; name: string; roots: string[] }) => Promise<void>
}

function folderName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized
}

function uniqueRoots(roots: string[]): string[] {
  return Array.from(new Set(roots.map(root => root.trim()).filter(Boolean)))
}

export function LocalProjectCreateDialog({
  open,
  device,
  initialRoots,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onClose,
  onCreate,
}: LocalProjectCreateDialogProps) {
  if (!open || !device) return null
  return (
    <LocalProjectCreateDialogContent
      key={`${device.device_id}:${initialRoots.join('\0')}`}
      device={device}
      initialRoots={initialRoots}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      onClose={onClose}
      onCreate={onCreate}
    />
  )
}

function LocalProjectCreateDialogContent({
  device,
  initialRoots,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onClose,
  onCreate,
}: Omit<LocalProjectCreateDialogProps, 'open' | 'device'> & { device: DeviceInfo }) {
  const { t } = useTranslation('common')
  const [name, setName] = useState('')
  const [roots, setRoots] = useState(() => uniqueRoots(initialRoots))
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscapeKey(onClose, !submitting)

  const addFolders = async () => {
    if (!shouldUseNativeProjectDirectoryPicker()) {
      setShowFolderPicker(true)
      return
    }
    try {
      const selected = await openNativeProjectDirectoryPickers(roots[0])
      if (selected.length > 0) setRoots(current => uniqueRoots([...current, ...selected]))
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError))
    }
  }

  const createProject = async () => {
    const trimmedName = name.trim()
    if (!trimmedName || roots.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onCreate({ deviceId: device.device_id, name: trimmedName, roots })
      onClose()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-project-create-title"
        data-testid="local-project-create-dialog"
        className="w-full max-w-[560px] rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="local-project-create-title" className="heading-base">
            {t('workbench.create_project', '创建项目')}
          </h2>
          <button
            type="button"
            data-testid="close-local-project-create-dialog"
            onClick={onClose}
            disabled={submitting}
            aria-label={t('workbench.close_dialog', '关闭')}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-5 flex h-11 items-center rounded-xl border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
          <Folder className="mx-3 h-4 w-4 shrink-0 text-text-secondary" />
          <span className="h-full w-px bg-border" />
          <input
            data-testid="local-project-create-name-input"
            aria-label={t('workbench.project_name', '项目名称')}
            placeholder={t('workbench.project_name', '项目名称')}
            value={name}
            autoFocus
            disabled={submitting}
            onChange={event => setName(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none placeholder:text-text-muted"
          />
        </label>

        <h3 className="mt-5 text-base font-medium">{t('workbench.source_folders', '源文件夹')}</h3>
        <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background">
          {roots.map((root, index) => (
            <div
              key={root}
              data-testid={`local-project-create-root-${index}`}
              className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
            >
              <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate text-base" title={root}>
                {folderName(root)}
              </span>
              <button
                type="button"
                data-testid={`remove-local-project-create-root-${index}`}
                disabled={submitting}
                onClick={() => setRoots(current => current.filter(item => item !== root))}
                aria-label={t('workbench.remove_source_folder', { name: folderName(root) })}
                className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-30"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            data-testid="add-local-project-create-folders"
            disabled={submitting}
            onClick={() => void addFolders()}
            className="flex h-11 w-full items-center gap-3 px-3 text-left text-base hover:bg-muted disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4 text-text-secondary" />
            {t('workbench.add_folder', '添加文件夹')}
          </button>
          {showFolderPicker && (
            <div
              className="border-t border-border p-3"
              data-testid="local-project-create-folder-picker"
            >
              <DeviceFolderPicker
                device={device}
                mode="select"
                initialPath={roots[0]}
                confirmLabel={t('workbench.add_folder', '添加文件夹')}
                onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
                onListDeviceDirectories={onListDeviceDirectories}
                onCreateDeviceDirectory={onCreateDeviceDirectory}
                onConfirm={({ path }) => {
                  setRoots(current => uniqueRoots([...current, path]))
                  setShowFolderPicker(false)
                }}
                onCancel={() => setShowFolderPicker(false)}
              />
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-local-project-create-button"
            disabled={submitting}
            onClick={onClose}
            className="h-9 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="confirm-local-project-create-button"
            disabled={submitting || !name.trim() || roots.length === 0}
            onClick={() => void createProject()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('workbench.create_project', '创建项目')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
