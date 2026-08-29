import { Check, ChevronLeft, Folder, FolderPlus, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { isImeEnterEvent } from '@/lib/ime'
import type { DeviceInfo } from '@/types/api'
import {
  directoryMatchesQuery,
  getParentPath,
  getPathSearchParts,
  joinPath,
  normalizePath,
} from './device-folder-path'

export type DeviceFolderPickerMode = 'select' | 'create'

export interface DeviceFolderPickerResult {
  deviceId: string
  path: string
  action: DeviceFolderPickerMode
}

interface DeviceFolderPickerProps {
  device: DeviceInfo
  mode: DeviceFolderPickerMode
  variant?: 'default' | 'remote'
  disabled?: boolean
  initialPath?: string
  confirmLabel?: string
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onConfirm: (result: DeviceFolderPickerResult) => Promise<void> | void
  onCancel: () => void
}

export function DeviceFolderPicker({
  device,
  mode,
  variant = 'default',
  disabled = false,
  initialPath,
  confirmLabel,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onConfirm,
  onCancel,
}: DeviceFolderPickerProps) {
  const { t } = useTranslation('common')
  const remoteLayout = variant === 'remote'
  const pickerDisabled = disabled || !device.device_id
  const [currentPath, setCurrentPath] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false)
  const [loadingDirectories, setLoadingDirectories] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pathInputEditedRef = useRef(false)

  useEffect(() => {
    pathInputEditedRef.current = false
  }, [device.device_id, initialPath])

  useEffect(() => {
    if (pickerDisabled) return
    let cancelled = false

    async function resolveInitialPath() {
      try {
        const resolved = initialPath || (await onGetDeviceHomeDirectory(device.device_id))
        const nextPath = normalizePath(resolved) || '/'
        if (!cancelled && !pathInputEditedRef.current) {
          setCurrentPath(nextPath)
          setPathInput(nextPath)
          setSelectedPath(nextPath)
          setDirectoryQuery('')
        }
      } catch (loadError) {
        if (!cancelled && !pathInputEditedRef.current) {
          setCurrentPath('')
          setPathInput('')
          setSelectedPath('')
          setDirectoryQuery('')
          setError(
            loadError instanceof Error
              ? loadError.message
              : t('workbench.project_home_directory_load_failed', '无法读取 home 目录')
          )
        }
      }
    }

    void resolveInitialPath()
    return () => {
      cancelled = true
    }
  }, [device.device_id, initialPath, onGetDeviceHomeDirectory, pickerDisabled, t])

  useEffect(() => {
    if (pickerDisabled || !currentPath) return
    let cancelled = false

    async function loadDirectories() {
      setLoadingDirectories(true)
      setError(null)
      try {
        const items = await onListDeviceDirectories(device.device_id, currentPath)
        if (!cancelled) {
          setDirectories([...items].sort((left, right) => left.localeCompare(right)))
        }
      } catch (loadError) {
        if (!cancelled) {
          setDirectories([])
          setError(
            loadError instanceof Error
              ? loadError.message
              : t('workbench.project_directory_load_failed', '目录加载失败')
          )
        }
      } finally {
        if (!cancelled) setLoadingDirectories(false)
      }
    }

    void loadDirectories()
    return () => {
      cancelled = true
    }
  }, [currentPath, device.device_id, onListDeviceDirectories, pickerDisabled, t])

  const visibleDirectories = useMemo(
    () =>
      showHiddenDirectories
        ? directories
        : directories.filter(directory => !directory.startsWith('.')),
    [directories, showHiddenDirectories]
  )
  const filteredDirectories = useMemo(
    () => visibleDirectories.filter(directory => directoryMatchesQuery(directory, directoryQuery)),
    [directoryQuery, visibleDirectories]
  )

  const browsePath = (path: string) => {
    pathInputEditedRef.current = true
    const normalized = normalizePath(path) || '/'
    setCurrentPath(normalized)
    setPathInput(normalized)
    setDirectoryQuery('')
    setSelectedPath(normalized)
    setError(null)
  }

  const confirmPathInput = () => {
    const normalized = normalizePath(pathInput) || '/'
    if (normalized === currentPath) {
      browsePath(normalized)
      return
    }

    const { parentPath, query } = getPathSearchParts(pathInput)
    const matchingDirectories =
      parentPath === currentPath
        ? visibleDirectories.filter(directory => directoryMatchesQuery(directory, query))
        : []

    if (query && matchingDirectories.length === 1) {
      browsePath(joinPath(parentPath, matchingDirectories[0]))
      return
    }

    if (query) {
      setCurrentPath(parentPath)
      setDirectoryQuery(query)
      setSelectedPath(normalized)
      setError(null)
      return
    }

    browsePath(parentPath)
  }

  const handleConfirm = async () => {
    if (pickerDisabled || submitting) return
    setError(null)

    if (mode === 'select') {
      const normalizedInput = normalizePath(pathInput)
      const path =
        normalizedInput && normalizedInput !== currentPath
          ? normalizedInput
          : selectedPath || currentPath
      setSubmitting(true)
      try {
        await onConfirm({
          deviceId: device.device_id,
          path,
          action: mode,
        })
      } catch (confirmError) {
        setError(
          confirmError instanceof Error
            ? confirmError.message
            : t('workbench.project_directory_select_failed', '项目打开失败')
        )
      } finally {
        setSubmitting(false)
      }
      return
    }

    const trimmedFolderName = folderName.trim()
    if (!trimmedFolderName || !currentPath) return
    if (trimmedFolderName.includes('/')) {
      setError(t('workbench.project_create_folder_name_error', '文件夹名称不能包含 /'))
      return
    }

    const nextPath = joinPath(currentPath, trimmedFolderName)
    setSubmitting(true)
    try {
      await onCreateDeviceDirectory(device.device_id, nextPath)
      await onConfirm({
        deviceId: device.device_id,
        path: nextPath,
        action: mode,
      })
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : t('workbench.project_create_folder_failed', '新建文件夹失败')
      )
    } finally {
      setSubmitting(false)
    }
  }

  const confirmDisabled =
    pickerDisabled ||
    submitting ||
    (mode === 'select' ? !selectedPath && !currentPath : !folderName.trim() || !currentPath)

  return (
    <div
      className={
        remoteLayout
          ? 'space-y-3'
          : 'rounded-lg border border-border bg-background text-text-primary'
      }
    >
      <div
        className={
          remoteLayout
            ? 'flex items-center gap-3'
            : 'flex items-center justify-between gap-3 border-b border-border px-3 py-2'
        }
      >
        {remoteLayout && (
          <button
            type="button"
            data-testid="device-folder-parent-button"
            disabled={pickerDisabled || submitting || !currentPath || currentPath === '/'}
            onClick={() => browsePath(getParentPath(currentPath))}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-40"
            aria-label={t('workbench.project_directory_parent', '返回上级目录')}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <label
          className={
            remoteLayout
              ? 'min-w-0 flex-1 rounded-[10px] border border-border bg-background px-3'
              : 'min-w-0 flex-1'
          }
        >
          <span className="sr-only">{t('workbench.project_directory_path', '目录地址')}</span>
          <input
            data-testid="device-folder-path-input"
            value={pathInput}
            disabled={pickerDisabled || submitting}
            onChange={event => {
              pathInputEditedRef.current = true
              setPathInput(event.target.value)
              setSelectedPath('')
              setError(null)
            }}
            onBlur={confirmPathInput}
            onKeyDown={event => {
              if (isImeEnterEvent(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmPathInput()
              }
            }}
            className={
              remoteLayout
                ? 'h-10 w-full border border-transparent bg-transparent font-mono text-sm text-text-primary outline-none disabled:opacity-60'
                : 'h-9 w-full rounded-md border border-transparent bg-transparent px-1 font-mono text-sm text-text-primary outline-none focus:border-focus focus:bg-background focus:ring-2 focus:ring-focus/20 disabled:opacity-60'
            }
            placeholder={t('workbench.project_directory_loading', '正在加载目录...')}
          />
        </label>
        {!remoteLayout && (
          <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-text-secondary">
            <input
              data-testid="device-folder-hidden-toggle"
              type="checkbox"
              checked={showHiddenDirectories}
              disabled={pickerDisabled || submitting}
              onChange={event => setShowHiddenDirectories(event.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary disabled:opacity-50"
            />
            {t('workbench.project_show_hidden_directories', '显示隐藏目录')}
          </label>
        )}
      </div>

      {mode === 'create' && (
        <div className={'flex items-center gap-2 border-b border-border px-3 py-2'}>
          <FolderPlus className="h-4 w-4 shrink-0 text-text-secondary" />
          <input
            data-testid="device-folder-name-input"
            value={folderName}
            disabled={pickerDisabled || submitting}
            onChange={event => {
              setFolderName(event.target.value)
              setError(null)
            }}
            onKeyDown={event => {
              if (isImeEnterEvent(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleConfirm()
              }
            }}
            className={
              remoteLayout
                ? 'h-10 min-w-0 flex-1 rounded-xl border border-border bg-muted px-3 text-sm text-text-primary outline-none focus:border-text-secondary disabled:opacity-60'
                : 'h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-60'
            }
            placeholder={t('workbench.project_create_folder_placeholder', '输入文件夹名称')}
          />
        </div>
      )}

      {error && (
        <p
          data-testid="device-folder-picker-error"
          className="border-b border-border px-3 py-2 text-xs text-red-500"
        >
          {error}
        </p>
      )}

      <div
        data-testid="device-folder-directory-list"
        className={
          remoteLayout
            ? 'h-[280px] overflow-auto rounded-[10px] border border-border bg-background p-2'
            : 'max-h-[320px] overflow-auto p-2'
        }
      >
        {!remoteLayout && !pickerDisabled && currentPath && currentPath !== '/' && (
          <button
            type="button"
            data-testid="device-folder-parent-button"
            onClick={() => browsePath(getParentPath(currentPath))}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text-primary hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
            ..
          </button>
        )}
        {loadingDirectories && (
          <p className="px-2 py-3 text-sm text-text-secondary">
            {t('workbench.project_directory_loading', '正在加载目录...')}
          </p>
        )}
        {!loadingDirectories &&
          filteredDirectories.map(directory => {
            const childPath = joinPath(currentPath, directory)
            const selected = selectedPath === childPath
            return (
              <button
                key={childPath}
                type="button"
                data-testid="device-folder-entry-button"
                onClick={() => setSelectedPath(childPath)}
                onDoubleClick={() => browsePath(childPath)}
                className={[
                  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                  selected ? 'bg-muted text-text-primary' : 'text-text-primary hover:bg-muted',
                ].join(' ')}
              >
                <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{directory}</span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        {!pickerDisabled && !loadingDirectories && !error && filteredDirectories.length === 0 && (
          <p className="px-2 py-8 text-center text-sm text-text-secondary">
            {t('workbench.project_directory_empty', '当前目录下没有子目录')}
          </p>
        )}
      </div>

      <div
        className={
          remoteLayout
            ? 'flex justify-end gap-2 px-0 pb-0 pt-1'
            : 'flex justify-end gap-2 border-t border-border px-3 py-3'
        }
      >
        <button
          type="button"
          data-testid="cancel-device-folder-picker-button"
          disabled={submitting}
          onClick={onCancel}
          className={
            remoteLayout
              ? 'h-9 rounded-[10px] px-4 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50'
              : 'h-10 rounded-md border border-border px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50'
          }
        >
          {t('workbench.cancel', '取消')}
        </button>
        <button
          type="button"
          data-testid="confirm-device-folder-picker-button"
          disabled={confirmDisabled}
          onClick={() => void handleConfirm()}
          className={
            remoteLayout
              ? 'inline-flex h-9 items-center gap-2 rounded-[10px] bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50'
              : 'inline-flex h-10 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50'
          }
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel ??
            (mode === 'create'
              ? t('workbench.project_create_folder_confirm', '创建')
              : t('workbench.project_directory_select_confirm', '选择'))}
        </button>
      </div>
    </div>
  )
}
