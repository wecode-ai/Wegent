import { Check, ChevronLeft, Folder, FolderPlus, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  variant?: 'light' | 'remoteDark'
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
  variant = 'light',
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
  const dark = variant === 'remoteDark'
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
      } catch (loadError) {
        if (!cancelled) {
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
    <div className={dark ? 'space-y-3' : 'rounded-lg border border-[#d8d8d8] bg-white'}>
      <div
        className={
          dark
            ? 'flex items-center gap-3'
            : 'flex items-center justify-between gap-3 border-b border-[#e5e5e5] px-3 py-2'
        }
      >
        {dark && (
          <button
            type="button"
            data-testid="device-folder-parent-button"
            disabled={pickerDisabled || submitting || !currentPath || currentPath === '/'}
            onClick={() => browsePath(getParentPath(currentPath))}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[#9a9a9a] hover:bg-white/5 hover:text-white disabled:opacity-40"
            aria-label={t('workbench.project_directory_parent', '返回上级目录')}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <label
          className={
            dark
              ? 'min-w-0 flex-1 rounded-[10px] border border-[#555] bg-[#2b2b2b] px-3'
              : 'min-w-0 flex-1'
          }
        >
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
              if (isImeEnterEvent(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmPathInput()
              }
            }}
            className={
              dark
                ? 'h-10 w-full border border-transparent bg-transparent font-mono text-sm text-white outline-none disabled:opacity-60'
                : 'h-9 w-full rounded-md border border-transparent bg-transparent px-1 font-mono text-sm text-[#3c4043] outline-none focus:border-[#14b8a6] focus:bg-white focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60'
            }
            placeholder={t('workbench.project_directory_loading', '正在加载目录...')}
          />
        </label>
        {!dark && (
          <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-[#606368]">
            <input
              data-testid="device-folder-hidden-toggle"
              type="checkbox"
              checked={showHiddenDirectories}
              disabled={pickerDisabled || submitting}
              onChange={event => setShowHiddenDirectories(event.target.checked)}
              className="h-4 w-4 rounded border-[#d8d8d8] accent-[#22c7b8] disabled:opacity-50"
            />
            {t('workbench.project_show_hidden_directories', '显示隐藏目录')}
          </label>
        )}
      </div>

      {mode === 'create' && (
        <div
          className={
            dark
              ? 'flex items-center gap-2 border-b border-[#454545] px-3 py-2'
              : 'flex items-center gap-2 border-b border-[#e5e5e5] px-3 py-2'
          }
        >
          <FolderPlus
            className={dark ? 'h-4 w-4 shrink-0 text-[#a8a8a8]' : 'h-4 w-4 shrink-0 text-[#606368]'}
          />
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
              dark
                ? 'h-10 min-w-0 flex-1 rounded-xl border border-[#454545] bg-[#303030] px-3 text-sm text-white outline-none focus:border-[#707070] disabled:opacity-60'
                : 'h-9 min-w-0 flex-1 rounded-md border border-[#d8d8d8] px-2 text-sm outline-none focus:border-text-primary focus:ring-2 focus:ring-text-primary/10 disabled:opacity-60'
            }
            placeholder={t('workbench.project_create_folder_placeholder', '输入文件夹名称')}
          />
        </div>
      )}

      {error && (
        <p
          data-testid="device-folder-picker-error"
          className={
            dark
              ? 'border-b border-[#454545] px-3 py-2 text-xs text-red-300'
              : 'border-b border-[#e5e5e5] px-3 py-2 text-xs text-[#c44]'
          }
        >
          {error}
        </p>
      )}

      <div
        data-testid="device-folder-directory-list"
        className={
          dark
            ? 'h-[280px] overflow-auto rounded-[10px] border border-[#454545] bg-[#2b2b2b] p-2'
            : 'max-h-[320px] overflow-auto p-2'
        }
      >
        {!dark && !pickerDisabled && currentPath && currentPath !== '/' && (
          <button
            type="button"
            data-testid="device-folder-parent-button"
            onClick={() => browsePath(getParentPath(currentPath))}
            className={
              dark
                ? 'flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-base text-[#d8d8d8] hover:bg-white/5'
                : 'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]'
            }
          >
            <ChevronLeft className="h-4 w-4" />
            ..
          </button>
        )}
        {loadingDirectories && (
          <p
            className={
              dark ? 'px-2 py-3 text-sm text-[#9a9a9a]' : 'px-2 py-3 text-sm text-[#8a8f98]'
            }
          >
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
                className={
                  dark
                    ? [
                        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                        selected ? 'bg-white/10 text-white' : 'text-[#f2f2f2] hover:bg-white/5',
                      ].join(' ')
                    : [
                        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                        selected
                          ? 'bg-[#e5f6f4] text-[#0f766e]'
                          : 'text-[#3c4043] hover:bg-[#f1f3f4]',
                      ].join(' ')
                }
              >
                <Folder className={dark ? 'h-4 w-4 shrink-0 text-[#a8a8a8]' : 'h-4 w-4 shrink-0'} />
                <span className="min-w-0 flex-1 truncate">{directory}</span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        {!pickerDisabled && !loadingDirectories && !error && filteredDirectories.length === 0 && (
          <p
            className={
              dark
                ? 'px-2 py-8 text-center text-sm text-[#9a9a9a]'
                : 'px-2 py-8 text-center text-sm text-[#8a8f98]'
            }
          >
            {t('workbench.project_directory_empty', '当前目录下没有子目录')}
          </p>
        )}
      </div>

      <div
        className={
          dark
            ? 'flex justify-end gap-2 px-0 pb-0 pt-1'
            : 'flex justify-end gap-2 border-t border-[#e5e5e5] px-3 py-3'
        }
      >
        <button
          type="button"
          data-testid="cancel-device-folder-picker-button"
          disabled={submitting}
          onClick={onCancel}
          className={
            dark
              ? 'h-9 rounded-[10px] px-4 text-sm font-medium text-[#a8a8a8] hover:bg-white/5 hover:text-white disabled:opacity-50'
              : 'h-10 rounded-md border border-[#d8d8d8] px-3 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:opacity-50'
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
            dark
              ? 'inline-flex h-9 items-center gap-2 rounded-[10px] bg-white px-4 text-sm font-medium text-[#1f1f1f] hover:bg-white/90 disabled:opacity-50'
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
