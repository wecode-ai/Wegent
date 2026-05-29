import { Check, ChevronLeft, Folder, FolderPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CreateProjectRequest, DeviceInfo, ProjectWithTasks } from '@/types/api'

type ProjectCreateMode = 'scratch' | 'existing'

interface ProjectCreateDialogProps {
  open: boolean
  mode: ProjectCreateMode
  devices: DeviceInfo[]
  onClose: () => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
}

const FALLBACK_PROJECTS_ROOT = '~/.wecode/wegent-executor/workspace/projects'

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || 'untitled'
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return trimmed || '/'
  return trimmed.replace(/\/+$/, '')
}

function joinPath(parent: string, child: string): string {
  const normalizedParent = normalizePath(parent)
  if (!normalizedParent || normalizedParent === '/') return `/${child}`
  return `${normalizedParent}/${child}`
}

function basename(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean)
  return segments.at(-1) || 'project'
}

function isUsableDevice(device: DeviceInfo): boolean {
  return device.status === 'online' || device.status === 'busy'
}

function isCloudDevice(device: DeviceInfo): boolean {
  return device.device_type === 'cloud'
}

function sortDevicesForProjectCreation(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((left, right) => {
    const leftUsable = isUsableDevice(left) ? 0 : 1
    const rightUsable = isUsableDevice(right) ? 0 : 1
    if (leftUsable !== rightUsable) return leftUsable - rightUsable

    const leftCloud = isUsableDevice(left) && isCloudDevice(left) ? 0 : 1
    const rightCloud = isUsableDevice(right) && isCloudDevice(right) ? 0 : 1
    if (leftCloud !== rightCloud) return leftCloud - rightCloud

    return (left.name || left.device_id).localeCompare(right.name || right.device_id)
  })
}

function getDefaultDeviceId(devices: DeviceInfo[]): string {
  return sortDevicesForProjectCreation(devices).find(isUsableDevice)?.device_id ?? ''
}

function getParentPath(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean)
  if (segments.length <= 1) return '/'
  return `/${segments.slice(0, -1).join('/')}`
}

export function ProjectCreateDialog({
  open,
  mode,
  devices = [],
  onClose,
  onCreateProject,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
}: ProjectCreateDialogProps) {
  if (!open) return null

  return (
    <ProjectCreateDialogContent
      key={`${mode}:${getDefaultDeviceId(devices)}`}
      mode={mode}
      devices={devices}
      onClose={onClose}
      onCreateProject={onCreateProject}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
      onListDeviceDirectories={onListDeviceDirectories}
    />
  )
}

function ProjectCreateDialogContent({
  mode,
  devices,
  onClose,
  onCreateProject,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
}: Omit<ProjectCreateDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const sortedDevices = useMemo(() => sortDevicesForProjectCreation(devices), [devices])
  const firstDeviceId = useMemo(() => getDefaultDeviceId(sortedDevices), [sortedDevices])
  const [deviceId, setDeviceId] = useState(firstDeviceId)
  const [projectName, setProjectName] = useState('')
  const [projectRoot, setProjectRoot] = useState(FALLBACK_PROJECTS_ROOT)
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false)
  const [loadingDirectories, setLoadingDirectories] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (mode !== 'scratch' || !deviceId) return
    let cancelled = false

    async function resolveProjectRoot() {
      try {
        const resolvedRoot = normalizePath(await onGetProjectWorkspaceRoot(deviceId))
        if (!cancelled && resolvedRoot) {
          setProjectRoot(resolvedRoot)
        }
      } catch {
        if (!cancelled) {
          setProjectRoot(FALLBACK_PROJECTS_ROOT)
        }
      }
    }

    void resolveProjectRoot()
    return () => {
      cancelled = true
    }
  }, [deviceId, mode, onGetProjectWorkspaceRoot])

  useEffect(() => {
    if (mode !== 'existing' || !deviceId) return
    let cancelled = false

    async function resolveHomeDirectory() {
      try {
        const homePath = normalizePath(await onGetDeviceHomeDirectory(deviceId))
        if (!cancelled) {
          setCurrentPath(homePath || '/')
        }
      } catch {
        if (!cancelled) {
          setCurrentPath('/')
        }
      }
    }

    void resolveHomeDirectory()
    return () => {
      cancelled = true
    }
  }, [deviceId, mode, onGetDeviceHomeDirectory])

  useEffect(() => {
    if (mode !== 'existing' || !deviceId || !currentPath) return
    let cancelled = false

    async function loadDirectories() {
      setLoadingDirectories(true)
      setDirectoryError(null)
      try {
        const items = await onListDeviceDirectories(deviceId, currentPath)
        if (cancelled) return
        setDirectories([...items].sort((left, right) => left.localeCompare(right)))
      } catch (error) {
        if (cancelled) return
        setDirectories([])
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t('workbench.project_directory_load_failed', '目录加载失败'),
        )
      } finally {
        if (!cancelled) setLoadingDirectories(false)
      }
    }

    void loadDirectories()
    return () => {
      cancelled = true
    }
  }, [currentPath, deviceId, mode, onListDeviceDirectories, t])

  const selectedDevice = sortedDevices.find(device => device.device_id === deviceId)
  const selectedDeviceUsable = Boolean(selectedDevice && isUsableDevice(selectedDevice))
  const scratchPath = useMemo(
    () => `${normalizePath(projectRoot)}/${sanitizePathSegment(projectName)}`,
    [projectName, projectRoot],
  )
  const finalProjectName = mode === 'scratch' ? projectName.trim() : basename(selectedPath)
  const finalPath = mode === 'scratch' ? scratchPath : selectedPath
  const canCreate = Boolean(deviceId && selectedDeviceUsable && finalProjectName && finalPath)
  const visibleDirectories = showHiddenDirectories
    ? directories
    : directories.filter(directory => !directory.startsWith('.'))

  const handleDeviceChange = (nextDeviceId: string) => {
    setDeviceId(nextDeviceId)
    setProjectRoot(FALLBACK_PROJECTS_ROOT)
    setCurrentPath('')
    setSelectedPath('')
    setDirectories([])
    setDirectoryError(null)
  }

  const handleOpenDirectory = (path: string) => {
    setSelectedPath(path)
    setCurrentPath(path)
  }

  const title =
    mode === 'existing'
      ? t('workbench.project_create_existing_title', '选择项目目录')
      : t('workbench.project_create_title', '新建项目')

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-4">
      <div
        data-testid="project-create-dialog"
        className="w-full max-w-[560px] rounded-lg border border-[#d8d8d8] bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-[#202124]">{title}</h2>
            <p className="mt-2 text-sm leading-5 text-[#6b6f76]">
              {t(
                'workbench.project_create_description',
                '创建一个项目工作区，用于在同一项目下发起多次对话',
              )}
            </p>
          </div>
          <button
            type="button"
            data-testid="close-project-create-dialog-button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#606368] hover:bg-[#f1f3f4]"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-6 block text-sm font-semibold text-[#202124]">
          {t('workbench.project_device', '设备')}
        </label>
        <select
          data-testid="project-device-select"
          value={deviceId}
          onChange={event => handleDeviceChange(event.target.value)}
          className="mt-2 h-11 w-full rounded-lg border border-[#d8d8d8] bg-white px-3 text-sm outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
        >
          {sortedDevices.length === 0 && (
            <option value="">{t('workbench.project_no_available_devices', '暂无可用设备')}</option>
          )}
          {sortedDevices.map(device => (
            <option key={device.device_id} value={device.device_id}>
              {device.name || device.device_id}
              {isCloudDevice(device) ? ` ${t('workbench.project_cloud_device', '(云设备)')}` : ''}
              {` ${t(
                isUsableDevice(device)
                  ? 'workbench.project_device_online'
                  : 'workbench.project_device_offline',
                isUsableDevice(device) ? '(在线)' : '(离线)',
              )}`}
            </option>
          ))}
        </select>

        {mode === 'scratch' ? (
          <>
            <label className="mt-5 block text-sm font-semibold text-[#202124]">
              {t('workbench.project_name', '项目名称')}
            </label>
            <input
              data-testid="project-name-input"
              value={projectName}
              onChange={event => setProjectName(event.target.value)}
              placeholder={t('workbench.project_name_placeholder', '输入项目名称')}
              className="mt-2 h-11 w-full rounded-lg border border-[#d8d8d8] px-3 text-sm outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
            />
            <div className="mt-5 rounded-lg border border-[#e3e5e8] bg-[#f7f8f9] px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-[#3c4043]">
                <FolderPlus className="h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate font-mono">{scratchPath}</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="mt-5 flex items-center justify-between gap-3">
              <label className="block text-sm font-semibold text-[#202124]">
                {t('workbench.project_directory_path', '目录地址')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-[#606368]">
                <input
                  data-testid="project-hidden-directories-toggle"
                  type="checkbox"
                  checked={showHiddenDirectories}
                  onChange={event => setShowHiddenDirectories(event.target.checked)}
                  className="h-4 w-4 rounded border-[#d8d8d8] accent-[#14b8a6]"
                />
                {t('workbench.project_show_hidden_directories', '显示隐藏目录')}
              </label>
            </div>
            <div className="mt-2 rounded-lg border border-[#d8d8d8]">
              <div className="flex h-10 items-center border-b border-[#e5e5e5] px-3">
                <span className="min-w-0 truncate font-mono text-sm text-[#3c4043]">
                  {currentPath || t('workbench.project_directory_loading', '正在加载目录...')}
                </span>
              </div>
              <div data-testid="project-directory-tree" className="max-h-[320px] overflow-auto p-2">
                {currentPath && currentPath !== '/' && (
                  <button
                    type="button"
                    data-testid="directory-parent-button"
                    onClick={() => setCurrentPath(getParentPath(currentPath))}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    ..
                  </button>
                )}
                {loadingDirectories && (
                  <p className="px-2 py-3 text-sm text-[#8a8f98]">
                    {t('workbench.project_directory_loading', '正在加载目录...')}
                  </p>
                )}
                {!loadingDirectories && directoryError && (
                  <p className="px-2 py-3 text-sm text-[#c44]">{directoryError}</p>
                )}
                {!loadingDirectories &&
                  !directoryError &&
                  visibleDirectories.map(directory => {
                    const childPath = joinPath(currentPath, directory)
                    const selected = selectedPath === childPath
                    return (
                      <button
                        type="button"
                        key={childPath}
                        data-testid="directory-entry-button"
                        onClick={() => setSelectedPath(childPath)}
                        onDoubleClick={() => handleOpenDirectory(childPath)}
                        className={[
                          'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                          selected
                            ? 'bg-[#e5f6f4] text-[#0f766e]'
                            : 'text-[#3c4043] hover:bg-[#f1f3f4]',
                        ].join(' ')}
                      >
                        <Folder className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{directory}</span>
                        {selected && <Check className="h-4 w-4 shrink-0" />}
                      </button>
                    )
                  })}
                {!loadingDirectories && !directoryError && visibleDirectories.length === 0 && (
                  <p className="px-2 py-8 text-center text-sm text-[#8a8f98]">
                    {t('workbench.project_directory_empty', '当前目录下没有子目录')}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        <div className="mt-7 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-project-create-button"
            onClick={onClose}
            className="h-10 rounded-md border border-[#d8d8d8] px-4 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8]"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="create-project-button"
            disabled={!canCreate || submitting}
            onClick={async () => {
              setSubmitting(true)
              try {
                await onCreateProject({
                  name: finalProjectName,
                  description: '',
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId,
                    },
                    workspace: {
                      source: 'local_path',
                      localPath: finalPath,
                    },
                  },
                })
                onClose()
              } finally {
                setSubmitting(false)
              }
            }}
            className="h-10 rounded-md bg-[#14b8a6] px-4 text-sm font-medium text-white hover:bg-[#0f9f93] disabled:opacity-50"
          >
            {t('workbench.create_project', '创建项目')}
          </button>
        </div>
      </div>
    </div>
  )
}
