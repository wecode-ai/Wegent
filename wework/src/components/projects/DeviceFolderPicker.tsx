import { Check, ChevronLeft, Folder, FolderPlus, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
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
  disabled?: boolean
  initialPath?: string
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onConfirm: (result: DeviceFolderPickerResult) => Promise<void> | void
  onCancel: () => void
}

export function DeviceFolderPicker({
  device,
  mode,
  disabled = false,
  initialPath,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onConfirm,
  onCancel,
}: DeviceFolderPickerProps) {
  const { t } = useTranslation('common')
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

  useEffect(() => {
    if (pickerDisabled) return
    let cancelled = false

    async function resolveInitialPath() {
      try {
        const resolved = initialPath || (await onGetDeviceHomeDirectory(device.device_id))
        const nextPath = normalizePath(resolved) || '/'
        if (!cancelled) {
          setCurrentPath(nextPath)
          setPathInput(nextPath)
          setSelectedPath(nextPath)
          setDirectoryQuery('')
        }
      } catch {
        if (!cancelled) {
          setCurrentPath('/')
          setPathInput('/')
          setSelectedPath('/')
          setDirectoryQuery('')
        }
      }
    }

    void resolveInitialPath()
    return () => {
      cancelled = true
    }
  }, [device.device_id, initialPath, onGetDeviceHomeDirectory, pickerDisabled])

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
      setSubmitting(true)
      try {
        await onConfirm({
          deviceId: device.device_id,
          path: selectedPath || currentPath,
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
    <div className="rounded-lg border border-[#d8d8d8] bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-[#e5e5e5] px-3 py-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t('workbench.project_directory_path', '目录地址')}</span>
          <input
            data-testid="device-folder-path-input"
            value={pathInput}
            disabled={pickerDisabled || submitting}
            onChange={event => {
              setPathInput(event.target.value)
              setError(null)
            }}
            onBlur={confirmPathInput}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmPathInput()
              }
            }}
            className="h-9 w-full rounded-md border border-transparent bg-transparent px-1 font-mono text-[13px] text-[#3c4043] outline-none focus:border-[#14b8a6] focus:bg-white focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
            placeholder={t('workbench.project_directory_loading', '正在加载目录...')}
          />
        </label>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-[#606368]">
          <input
            data-testid="device-folder-hidden-toggle"
            type="checkbox"
            checked={showHiddenDirectories}
            disabled={pickerDisabled || submitting}
            onChange={event => setShowHiddenDirectories(event.target.checked)}
            className="h-4 w-4 rounded border-[#d8d8d8] accent-[#14b8a6] disabled:opacity-50"
          />
          {t('workbench.project_show_hidden_directories', '显示隐藏目录')}
        </label>
      </div>

      {mode === 'create' && (
        <div className="flex items-center gap-2 border-b border-[#e5e5e5] px-3 py-2">
          <FolderPlus className="h-4 w-4 shrink-0 text-[#606368]" />
          <input
            data-testid="device-folder-name-input"
            value={folderName}
            disabled={pickerDisabled || submitting}
            onChange={event => {
              setFolderName(event.target.value)
              setError(null)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleConfirm()
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-[#d8d8d8] px-2 text-[13px] outline-none focus:border-text-primary focus:ring-2 focus:ring-text-primary/10 disabled:opacity-60"
            placeholder={t('workbench.project_create_folder_placeholder', '输入文件夹名称')}
          />
        </div>
      )}

      {error && (
        <p
          data-testid="device-folder-picker-error"
          className="border-b border-[#e5e5e5] px-3 py-2 text-xs text-[#c44]"
        >
          {error}
        </p>
      )}

      <div className="max-h-[320px] overflow-auto p-2">
        {!pickerDisabled && currentPath && currentPath !== '/' && (
          <button
            type="button"
            data-testid="device-folder-parent-button"
            onClick={() => browsePath(getParentPath(currentPath))}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-[#3c4043] hover:bg-[#f1f3f4]"
          >
            <ChevronLeft className="h-4 w-4" />
            ..
          </button>
        )}
        {loadingDirectories && (
          <p className="px-2 py-3 text-[13px] text-[#8a8f98]">
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
                  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
                  selected ? 'bg-[#e5f6f4] text-[#0f766e]' : 'text-[#3c4043] hover:bg-[#f1f3f4]',
                ].join(' ')}
              >
                <Folder className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{directory}</span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        {!pickerDisabled && !loadingDirectories && !error && filteredDirectories.length === 0 && (
          <p className="px-2 py-8 text-center text-[13px] text-[#8a8f98]">
            {t('workbench.project_directory_empty', '当前目录下没有子目录')}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-[#e5e5e5] px-3 py-3">
        <button
          type="button"
          data-testid="cancel-device-folder-picker-button"
          disabled={submitting}
          onClick={onCancel}
          className="h-10 rounded-md border border-[#d8d8d8] px-3 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:opacity-50"
        >
          {t('workbench.cancel', '取消')}
        </button>
        <button
          type="button"
          data-testid="confirm-device-folder-picker-button"
          disabled={confirmDisabled}
          onClick={() => void handleConfirm()}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === 'create'
            ? t('workbench.project_create_folder_confirm', '创建')
            : t('workbench.project_directory_select_confirm', '选择')}
        </button>
      </div>
    </div>
  )
}
