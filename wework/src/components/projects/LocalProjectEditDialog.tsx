import { Folder, FolderPlus, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { shouldUseNativeProjectDirectoryPicker } from '@/e2e/automation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { openNativeProjectDirectoryPickers } from '@/lib/native-directory-picker'
import type { DeviceInfo, RuntimeProjectWork } from '@/types/api'
import { DeviceFolderPicker } from './DeviceFolderPicker'

interface LocalProjectEditDialogProps {
  open: boolean
  projectWork: RuntimeProjectWork | null
  device: DeviceInfo | null
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onClose: () => void
  onSave: (data: {
    deviceId: string
    projectKey: string
    name: string
    roots: string[]
  }) => Promise<void>
  onDelete: () => void
}

function folderName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized
}

function uniqueRoots(roots: string[]): string[] {
  return Array.from(new Set(roots.map(root => root.trim()).filter(Boolean)))
}

export function LocalProjectEditDialog({
  open,
  projectWork,
  device,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onClose,
  onSave,
  onDelete,
}: LocalProjectEditDialogProps) {
  if (!open || !projectWork) return null
  return (
    <LocalProjectEditDialogContent
      key={projectWork.project.key}
      projectWork={projectWork}
      device={device}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
    />
  )
}

function LocalProjectEditDialogContent({
  projectWork,
  device,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onClose,
  onSave,
  onDelete,
}: Omit<LocalProjectEditDialogProps, 'open' | 'projectWork'> & {
  projectWork: RuntimeProjectWork
}) {
  const { t } = useTranslation('common')
  const initialRoots = useMemo(
    () =>
      uniqueRoots(
        projectWork.project.roots?.map(root => root.path) ??
          projectWork.deviceWorkspaces.map(workspace => workspace.workspacePath)
      ),
    [projectWork]
  )
  const [name, setName] = useState(projectWork.project.name)
  const [roots, setRoots] = useState(initialRoots)
  const [submitting, setSubmitting] = useState(false)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deviceId =
    projectWork.project.stateDeviceId?.trim() ||
    projectWork.deviceWorkspaces[0]?.deviceId.trim() ||
    ''

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

  const save = async () => {
    const trimmedName = name.trim()
    if (!trimmedName || roots.length === 0 || !deviceId || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSave({
        deviceId,
        projectKey: projectWork.project.key,
        name: trimmedName,
        roots,
      })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-project-edit-title"
        data-testid="local-project-edit-dialog"
        className="w-full max-w-[560px] rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="local-project-edit-title" className="heading-base">
            {t('workbench.edit_project', '编辑项目')}
          </h2>
          <button
            type="button"
            data-testid="close-local-project-edit-dialog"
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
            data-testid="local-project-name-input"
            aria-label={t('workbench.project_name', '项目名称')}
            value={name}
            autoFocus
            disabled={submitting}
            onChange={event => setName(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none"
          />
        </label>

        <h3 className="mt-5 text-base font-medium">{t('workbench.source_folders', '源文件夹')}</h3>
        <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background">
          {roots.map((root, index) => (
            <div
              key={root}
              data-testid={`local-project-root-${index}`}
              className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
            >
              <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate text-base" title={root}>
                {folderName(root)}
              </span>
              {index === 0 ? (
                <span className="rounded-lg border border-border px-2 py-1 text-sm text-text-secondary">
                  {t('workbench.primary_folder', '主目录')}
                </span>
              ) : (
                <button
                  type="button"
                  data-testid={`make-primary-root-${index}`}
                  disabled={submitting}
                  onClick={() =>
                    setRoots(current => [root, ...current.filter(item => item !== root)])
                  }
                  className="rounded-lg bg-muted px-2 py-1 text-sm hover:bg-border"
                >
                  {t('workbench.make_primary_folder', '设为主目录')}
                </button>
              )}
              <button
                type="button"
                data-testid={`remove-local-project-root-${index}`}
                disabled={submitting || roots.length === 1}
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
            data-testid="add-local-project-folders"
            disabled={submitting}
            onClick={() => void addFolders()}
            className="flex h-11 w-full items-center gap-3 px-3 text-left text-base hover:bg-muted disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4 text-text-secondary" />
            {t('workbench.add_folder', '添加文件夹')}
          </button>
          {showFolderPicker && device && (
            <div className="border-t border-border p-3" data-testid="local-project-folder-picker">
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
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            data-testid="delete-local-project-button"
            disabled={submitting}
            onClick={onDelete}
            className="h-9 rounded-lg bg-red-500/10 px-3 text-sm font-medium text-red-500 hover:bg-red-500/15 disabled:opacity-50"
          >
            {t('workbench.delete_project', '删除项目')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="cancel-local-project-edit-button"
            disabled={submitting}
            onClick={onClose}
            className="h-9 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="save-local-project-button"
            disabled={submitting || !name.trim() || roots.length === 0 || !deviceId}
            onClick={() => void save()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
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
