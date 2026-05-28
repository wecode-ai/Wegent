import { ChevronRight, Folder, FolderPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CreateProjectRequest, DeviceInfo, ProjectWithTasks } from '@/types/api'

type ProjectCreateMode = 'scratch' | 'existing'

interface ProjectCreateDialogProps {
  open: boolean
  mode: ProjectCreateMode
  devices: DeviceInfo[]
  onClose: () => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
}

const DEFAULT_WORKSPACE_ROOT = '~/.wecode/wegent-executor/workspace'

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || 'untitled'
}

function joinPath(parent: string, child: string): string {
  if (parent === '/') return `/${child}`
  return `${parent.replace(/\/$/, '')}/${child}`
}

function basename(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments.at(-1) || 'project'
}

export function ProjectCreateDialog({
  open,
  mode,
  devices = [],
  onClose,
  onCreateProject,
  onListDeviceDirectories,
}: ProjectCreateDialogProps) {
  if (!open) return null

  return (
    <ProjectCreateDialogContent
      key={`${mode}:${devices[0]?.device_id ?? ''}`}
      mode={mode}
      devices={devices}
      onClose={onClose}
      onCreateProject={onCreateProject}
      onListDeviceDirectories={onListDeviceDirectories}
    />
  )
}

function ProjectCreateDialogContent({
  mode,
  devices,
  onClose,
  onCreateProject,
  onListDeviceDirectories,
}: Omit<ProjectCreateDialogProps, 'open'>) {
  const firstDeviceId = devices[0]?.device_id ?? ''
  const [deviceId, setDeviceId] = useState(firstDeviceId)
  const [projectName, setProjectName] = useState('')
  const [currentPath, setCurrentPath] = useState('/')
  const [selectedPath, setSelectedPath] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [loadingDirectories, setLoadingDirectories] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (mode !== 'existing' || !deviceId) return
    let cancelled = false

    async function loadDirectories() {
      await Promise.resolve()
      if (cancelled) return
      setLoadingDirectories(true)
      setDirectoryError(null)
      try {
        const items = await onListDeviceDirectories(deviceId, currentPath)
        if (cancelled) return
        setDirectories([...items].sort((left, right) => left.localeCompare(right)))
      } catch (error) {
        if (cancelled) return
        setDirectories([])
        setDirectoryError(error instanceof Error ? error.message : 'Failed to load directories')
      } finally {
        if (!cancelled) setLoadingDirectories(false)
      }
    }

    void loadDirectories()
    return () => {
      cancelled = true
    }
  }, [currentPath, deviceId, mode, onListDeviceDirectories])

  const selectedDevice = devices.find(device => device.device_id === deviceId)
  const scratchPath = useMemo(
    () => `${DEFAULT_WORKSPACE_ROOT}/${sanitizePathSegment(projectName)}`,
    [projectName],
  )
  const finalProjectName = mode === 'scratch' ? projectName.trim() : projectName.trim() || basename(selectedPath)
  const finalPath = mode === 'scratch' ? scratchPath : selectedPath
  const canCreate = Boolean(deviceId && finalProjectName && finalPath && (mode === 'scratch' || selectedPath))

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-4">
      <div
        data-testid="project-create-dialog"
        className="w-full max-w-[560px] rounded-lg border border-[#d8d8d8] bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-[#202124]">新建项目</h2>
            <p className="mt-2 text-sm leading-5 text-[#6b6f76]">
              创建一个项目工作区，用于在同一项目下发起多次对话
            </p>
          </div>
          <button
            type="button"
            data-testid="close-project-create-dialog-button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#606368] hover:bg-[#f1f3f4]"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-6 block text-sm font-semibold text-[#202124]">设备</label>
        <select
          data-testid="project-device-select"
          value={deviceId}
          onChange={event => {
            setDeviceId(event.target.value)
            setCurrentPath('/')
            setSelectedPath('')
          }}
          className="mt-2 h-11 w-full rounded-lg border border-[#d8d8d8] bg-white px-3 text-sm outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
        >
          {devices.length === 0 && <option value="">暂无可用设备</option>}
          {devices.map(device => (
            <option key={device.device_id} value={device.device_id}>
              {device.name}（{device.status === 'online' ? '在线' : '离线'}）
            </option>
          ))}
        </select>

        {mode === 'scratch' ? (
          <>
            <label className="mt-5 block text-sm font-semibold text-[#202124]">
              项目名称
            </label>
            <input
              data-testid="project-name-input"
              value={projectName}
              onChange={event => setProjectName(event.target.value)}
              placeholder="输入项目名称"
              className="mt-2 h-11 w-full rounded-lg border border-[#d8d8d8] px-3 text-sm outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
            />
            <div className="mt-5 rounded-lg border border-[#e3e5e8] bg-[#f7f8f9] px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-[#3c4043]">
                <FolderPlus className="h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate font-mono">{scratchPath}</span>
              </div>
              <p className="mt-1 text-xs text-[#8a8f98]">
                默认目录位于所选设备的 .wecode/wegent-executor/workspace 下
              </p>
            </div>
          </>
        ) : (
          <>
            <label className="mt-5 block text-sm font-semibold text-[#202124]">
              目录地址
            </label>
            <div className="mt-2 rounded-lg border border-[#d8d8d8]">
              <div className="flex h-10 items-center justify-between border-b border-[#e5e5e5] px-3">
                <span className="min-w-0 truncate font-mono text-sm text-[#3c4043]">
                  {currentPath}
                </span>
                <button
                  type="button"
                  data-testid="select-current-directory-button"
                  onClick={() => {
                    setSelectedPath(currentPath)
                    setProjectName(basename(currentPath))
                  }}
                  className="h-7 rounded-md bg-[#f1f3f4] px-2 text-xs font-medium text-[#3c4043] hover:bg-[#e8eaed]"
                >
                  选择此目录
                </button>
              </div>
              <div data-testid="project-directory-tree" className="max-h-[220px] overflow-auto p-2">
                {currentPath !== '/' && (
                  <button
                    type="button"
                    data-testid="directory-parent-button"
                    onClick={() => {
                      const parent = currentPath.split('/').filter(Boolean).slice(0, -1)
                      setCurrentPath(parent.length ? `/${parent.join('/')}` : '/')
                    }}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
                  >
                    <ChevronRight className="h-4 w-4 rotate-180" />
                    ..
                  </button>
                )}
                {loadingDirectories && (
                  <p className="px-2 py-3 text-sm text-[#8a8f98]">正在加载目录...</p>
                )}
                {!loadingDirectories && directoryError && (
                  <p className="px-2 py-3 text-sm text-[#c44]">{directoryError}</p>
                )}
                {!loadingDirectories && !directoryError && directories.map(directory => {
                  const childPath = joinPath(currentPath, directory)
                  return (
                    <button
                      type="button"
                      key={childPath}
                      data-testid="directory-entry-button"
                      onClick={() => setCurrentPath(childPath)}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
                    >
                      <Folder className="h-4 w-4 shrink-0" />
                      <span className="truncate">{directory}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <label className="mt-5 block text-sm font-semibold text-[#202124]">
              项目名称
            </label>
            <input
              data-testid="project-name-input"
              value={projectName}
              onChange={event => setProjectName(event.target.value)}
              placeholder="从所选目录自动生成"
              className="mt-2 h-11 w-full rounded-lg border border-[#d8d8d8] px-3 text-sm outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
            />
            <p className="mt-2 min-h-5 truncate text-xs text-[#8a8f98]">
              {selectedPath ? `已选择：${selectedPath}` : '请从所选设备中选择项目所在目录'}
            </p>
          </>
        )}

        <div className="mt-7 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-project-create-button"
            onClick={onClose}
            className="h-10 rounded-md border border-[#d8d8d8] px-4 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8]"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="create-project-button"
            disabled={!canCreate || submitting || !selectedDevice}
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
            创建项目
          </button>
        </div>
      </div>
    </div>
  )
}
