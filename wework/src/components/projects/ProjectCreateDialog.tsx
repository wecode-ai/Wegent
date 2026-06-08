import { Check, ChevronLeft, Folder, FolderPlus, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isUsableDevice,
} from '@/lib/device-capabilities'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeviceInfo,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
} from '@/types/api'

type ProjectCreateMode = 'scratch' | 'existing' | 'git'

interface ProjectCreateDialogProps {
  open: boolean
  mode: ProjectCreateMode
  devices: DeviceInfo[]
  onClose: () => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject?: (
    data: CreateGitWorkspaceProjectRequest,
  ) => Promise<ProjectWithTasks>
  preferredDeviceId?: string | null
  onSelectDevicePreference?: (deviceId: string) => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onListGitRepositories?: () => Promise<GitRepoInfo[]>
  onListGitBranches?: (repo: GitRepoInfo) => Promise<GitBranch[]>
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

function getGitProjectName(repo: GitRepoInfo | null): string {
  if (!repo) return ''
  return repo.name || repo.git_repo.split('/').filter(Boolean).at(-1) || repo.git_repo
}

function getGitErrorMessage(
  error: unknown,
  tokenMissingText: string,
  fallbackText: string,
  directoryExistsText?: (path: string) => string,
): string {
  const message = error instanceof Error ? error.message : ''
  const normalizedMessage = message.toLowerCase()
  if (normalizedMessage.includes('no git token configured')) {
    return tokenMissingText
  }
  const directoryExistsPrefix = 'target project directory already exists:'
  const directoryExistsIndex = normalizedMessage.indexOf(directoryExistsPrefix)
  if (directoryExistsIndex >= 0 && directoryExistsText) {
    const path = message.slice(directoryExistsIndex + directoryExistsPrefix.length).trim()
    return directoryExistsText(path)
  }
  return message || fallbackText
}

function sortDevicesForProjectCreation(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((left, right) => {
    const leftUsable = canUseForProjectCreation(left) ? 0 : 1
    const rightUsable = canUseForProjectCreation(right) ? 0 : 1
    if (leftUsable !== rightUsable) return leftUsable - rightUsable

    const leftCloud = isUsableDevice(left) && isCloudDevice(left) ? 0 : 1
    const rightCloud = isUsableDevice(right) && isCloudDevice(right) ? 0 : 1
    if (leftCloud !== rightCloud) return leftCloud - rightCloud

    return (left.name || left.device_id).localeCompare(right.name || right.device_id)
  })
}

function getProjectCreationDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return sortDevicesForProjectCreation(devices.filter(canUseForProjectCreation))
}

function getDefaultDeviceId(
  devices: DeviceInfo[],
  preferredDeviceId?: string | null
): string {
  const preferredDevice = preferredDeviceId
    ? devices.find(device => device.device_id === preferredDeviceId)
    : undefined
  if (preferredDevice && canUseForProjectCreation(preferredDevice)) {
    return preferredDevice.device_id
  }

  return getProjectCreationDevices(devices)[0]?.device_id ?? ''
}

function getParentPath(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean)
  if (segments.length <= 1) return '/'
  return `/${segments.slice(0, -1).join('/')}`
}

function getPathSearchParts(path: string): { parentPath: string; query: string } {
  const trimmedPath = path.trim()
  if (!trimmedPath || trimmedPath === '/') {
    return { parentPath: '/', query: '' }
  }

  if (trimmedPath.endsWith('/')) {
    return { parentPath: normalizePath(trimmedPath), query: '' }
  }

  const normalized = normalizePath(trimmedPath)
  return {
    parentPath: getParentPath(normalized),
    query: basename(normalized),
  }
}

function directoryMatchesQuery(directory: string, query: string): boolean {
  const normalizedDirectory = directory.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  if (normalizedDirectory.includes(normalizedQuery)) return true

  let queryIndex = 0
  for (const character of normalizedDirectory) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1
      if (queryIndex === normalizedQuery.length) return true
    }
  }
  return false
}

export function ProjectCreateDialog({
  open,
  mode,
  devices = [],
  onClose,
  onCreateProject,
  onCreateGitWorkspaceProject,
  preferredDeviceId,
  onSelectDevicePreference,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onListGitRepositories,
  onListGitBranches,
}: ProjectCreateDialogProps) {
  if (!open) return null

  return (
    <ProjectCreateDialogContent
      key={`${mode}:${getDefaultDeviceId(devices)}`}
      mode={mode}
      devices={devices}
      onClose={onClose}
      onCreateProject={onCreateProject}
      onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
      preferredDeviceId={preferredDeviceId}
      onSelectDevicePreference={onSelectDevicePreference}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      onListGitRepositories={onListGitRepositories}
      onListGitBranches={onListGitBranches}
    />
  )
}

function ProjectCreateDialogContent({
  mode,
  devices,
  onClose,
  onCreateProject,
  onCreateGitWorkspaceProject,
  preferredDeviceId,
  onSelectDevicePreference,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onListGitRepositories,
  onListGitBranches,
}: Omit<ProjectCreateDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const sortedDevices = useMemo(() => getProjectCreationDevices(devices), [devices])
  const firstDeviceId = useMemo(
    () => getDefaultDeviceId(sortedDevices, preferredDeviceId),
    [preferredDeviceId, sortedDevices]
  )
  const [deviceId, setDeviceId] = useState(firstDeviceId)
  const [projectName, setProjectName] = useState('')
  const [projectRoot, setProjectRoot] = useState(FALLBACK_PROJECTS_ROOT)
  const [currentPath, setCurrentPath] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false)
  const [loadingDirectories, setLoadingDirectories] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingDirectory, setCreatingDirectory] = useState(false)
  const [createDirectoryError, setCreateDirectoryError] = useState<string | null>(null)
  const [repositories, setRepositories] = useState<GitRepoInfo[]>([])
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [loadingRepositories, setLoadingRepositories] = useState(false)
  const [repositoryError, setRepositoryError] = useState<string | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null)
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
          const nextPath = homePath || '/'
          setCurrentPath(nextPath)
          setPathInput(nextPath)
          setDirectoryQuery('')
          setSelectedPath(nextPath)
        }
      } catch {
        if (!cancelled) {
          setCurrentPath('/')
          setPathInput('/')
          setDirectoryQuery('')
          setSelectedPath('/')
        }
      }
    }

    void resolveHomeDirectory()
    return () => {
      cancelled = true
    }
  }, [deviceId, mode, onGetDeviceHomeDirectory])

  useEffect(() => {
    if (mode !== 'existing') return
    const normalizedInput = normalizePath(pathInput)
    if (!normalizedInput) return
    if (normalizedInput === currentPath && !directoryQuery) return

    const timeoutId = window.setTimeout(() => {
      const { parentPath, query } = getPathSearchParts(pathInput)
      setCurrentPath(parentPath)
      setDirectoryQuery(query)
      setSelectedPath(normalizedInput)
    }, 300)
    return () => window.clearTimeout(timeoutId)
  }, [currentPath, directoryQuery, mode, pathInput])

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

  useEffect(() => {
    if (mode !== 'git') return
    let cancelled = false

    async function loadRepositories() {
      if (!onListGitRepositories) return
      setLoadingRepositories(true)
      setRepositoryError(null)
      try {
        const items = await onListGitRepositories()
        if (cancelled) return
        setRepositories([...items].sort((left, right) => left.git_repo.localeCompare(right.git_repo)))
      } catch (error) {
        if (cancelled) return
        setRepositories([])
        setRepositoryError(
          getGitErrorMessage(
            error,
            t('workbench.project_git_token_missing', '请先在设置中配置 Git Token'),
            t('workbench.project_git_repository_load_failed', '仓库加载失败'),
          ),
        )
      } finally {
        if (!cancelled) setLoadingRepositories(false)
      }
    }

    void loadRepositories()
    return () => {
      cancelled = true
    }
  }, [mode, onListGitRepositories, t])

  useEffect(() => {
    if (mode !== 'git' || !selectedRepo) return
    let cancelled = false
    const repo = selectedRepo

    async function loadBranches() {
      if (!onListGitBranches) return
      setLoadingBranches(true)
      setBranchError(null)
      try {
        const items = await onListGitBranches(repo)
        if (cancelled) return
        setBranches(items)
        setSelectedBranch(items.find(branch => branch.default) ?? items[0] ?? null)
      } catch (error) {
        if (cancelled) return
        setBranches([])
        setSelectedBranch(null)
        setBranchError(
          getGitErrorMessage(
            error,
            t('workbench.project_git_token_missing', '请先在设置中配置 Git Token'),
            t('workbench.project_git_branch_load_failed', '分支加载失败'),
          ),
        )
      } finally {
        if (!cancelled) setLoadingBranches(false)
      }
    }

    void loadBranches()
    return () => {
      cancelled = true
    }
  }, [mode, onListGitBranches, selectedRepo, t])

  const selectedDevice = sortedDevices.find(device => device.device_id === deviceId)
  const selectedDeviceUsable = Boolean(selectedDevice && canUseForProjectCreation(selectedDevice))
  const scratchPath = useMemo(
    () => `${normalizePath(projectRoot)}/${sanitizePathSegment(projectName)}`,
    [projectName, projectRoot],
  )
  const gitProjectName = getGitProjectName(selectedRepo)
  const finalProjectName =
    mode === 'scratch'
      ? projectName.trim()
      : mode === 'git'
        ? gitProjectName
        : basename(selectedPath)
  const finalPath =
    mode === 'scratch' ? scratchPath : mode === 'git' ? '' : directoryQuery ? '' : selectedPath
  const canCreate =
    mode === 'git'
      ? Boolean(
          deviceId &&
            selectedDeviceUsable &&
            selectedRepo &&
            selectedBranch &&
            onCreateGitWorkspaceProject,
        )
      : Boolean(deviceId && selectedDeviceUsable && finalProjectName && finalPath)
  const visibleDirectories = showHiddenDirectories
    ? directories
    : directories.filter(directory => !directory.startsWith('.'))
  const filteredDirectories = visibleDirectories.filter(directory =>
    directoryMatchesQuery(directory, directoryQuery),
  )

  const handleDeviceChange = (nextDeviceId: string) => {
    setDeviceId(nextDeviceId)
    if (nextDeviceId) {
      onSelectDevicePreference?.(nextDeviceId)
    }
    setProjectRoot(FALLBACK_PROJECTS_ROOT)
    setCurrentPath('')
    setPathInput('')
    setDirectoryQuery('')
    setSelectedPath('')
    setDirectories([])
    setDirectoryError(null)
    setCreateDirectoryError(null)
    setNewFolderName('')
    setNewFolderOpen(false)
    setSelectedRepo(null)
    setBranches([])
    setSelectedBranch(null)
    setBranchError(null)
  }

  const handleBrowsePath = (path: string) => {
    const normalized = normalizePath(path) || '/'
    setCurrentPath(normalized)
    setPathInput(normalized)
    setDirectoryQuery('')
    setSelectedPath(normalized)
  }

  const handleConfirmPathInput = () => {
    const normalized = normalizePath(pathInput) || '/'
    if (normalized === currentPath) {
      handleBrowsePath(normalized)
      return
    }

    const { parentPath, query } = getPathSearchParts(pathInput)
    const matchingDirectories =
      parentPath === currentPath
        ? visibleDirectories.filter(directory => directoryMatchesQuery(directory, query))
        : []

    if (query && matchingDirectories.length === 1) {
      handleBrowsePath(joinPath(parentPath, matchingDirectories[0]))
      return
    }

    if (query) {
      setCurrentPath(parentPath)
      setDirectoryQuery(query)
      setSelectedPath(normalized)
      return
    }

    handleBrowsePath(parentPath)
  }

  const handleOpenDirectory = (path: string) => {
    handleBrowsePath(path)
  }

  const handleCreateDirectory = async () => {
    const folderName = newFolderName.trim()
    if (!deviceId || !currentPath || !folderName) return

    if (folderName.includes('/')) {
      setCreateDirectoryError(
        t('workbench.project_create_folder_name_error', '文件夹名称不能包含 /'),
      )
      return
    }

    const nextPath = joinPath(currentPath, folderName)
    setCreatingDirectory(true)
    setCreateDirectoryError(null)
    try {
      await onCreateDeviceDirectory(deviceId, nextPath)
      setNewFolderName('')
      setNewFolderOpen(false)
      handleBrowsePath(nextPath)
    } catch (error) {
      setCreateDirectoryError(
        error instanceof Error
          ? error.message
          : t('workbench.project_create_folder_failed', '新建文件夹失败'),
      )
    } finally {
      setCreatingDirectory(false)
    }
  }

  useEscapeKey(onClose, !submitting)

  const title =
    mode === 'git'
      ? t('workbench.project_create_git_title', '克隆 Git 仓库')
      : mode === 'existing'
        ? t('workbench.project_create_existing_title', '选择项目目录')
        : t('workbench.project_create_title', '新建项目')
  const submittingLabel =
    mode === 'git'
      ? t('workbench.project_git_cloning', '克隆中...')
      : t('workbench.project_creating', '创建中...')
  const submittingHint =
    mode === 'git'
      ? t('workbench.project_git_clone_progress', '正在克隆仓库，可能需要一点时间')
      : t('workbench.project_create_progress', '正在创建项目，请稍候')

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        data-testid="project-create-dialog"
        className="w-full max-w-[560px] rounded-lg border border-[#d8d8d8] bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#202124]">{title}</h2>
            <p className="mt-2 text-[13px] leading-[18px] text-[#6b6f76]">
              {t(
                'workbench.project_create_description',
                '创建一个项目工作区，用于在同一项目下发起多次对话',
              )}
            </p>
          </div>
          <button
            type="button"
            data-testid="close-project-create-dialog-button"
            onClick={() => {
              if (!submitting) onClose()
            }}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#606368] hover:bg-[#f1f3f4] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-6 block text-[13px] font-semibold text-[#202124]">
          {t('workbench.project_device', '设备')}
        </label>
        <select
          data-testid="project-device-select"
          value={deviceId}
          disabled={submitting}
          onChange={event => handleDeviceChange(event.target.value)}
          className="mt-2 h-10 w-full rounded-lg border border-[#d8d8d8] bg-white px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
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
            <label className="mt-5 block text-[13px] font-semibold text-[#202124]">
              {t('workbench.project_name', '项目名称')}
            </label>
            <input
              data-testid="project-name-input"
              value={projectName}
              disabled={submitting}
              onChange={event => {
                setProjectName(event.target.value)
                setProjectCreateError(null)
              }}
              placeholder={t('workbench.project_name_placeholder', '输入项目名称')}
              className="mt-2 h-10 w-full rounded-lg border border-[#d8d8d8] px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
            />
          </>
        ) : mode === 'git' ? (
          <>
            <label className="mt-5 block text-[13px] font-semibold text-[#202124]">
              {t('workbench.project_git_repository', 'Git 仓库')}
            </label>
            <select
              data-testid="git-repository-select"
              value={selectedRepo?.git_url ?? ''}
              disabled={submitting || loadingRepositories || repositories.length === 0}
              onChange={event => {
                const nextRepo =
                  repositories.find(repo => repo.git_url === event.target.value) ?? null
                setSelectedRepo(nextRepo)
                setSelectedBranch(null)
                if (!nextRepo) {
                  setBranches([])
                  setBranchError(null)
                }
                setProjectCreateError(null)
              }}
              className="mt-2 h-10 w-full rounded-lg border border-[#d8d8d8] bg-white px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
            >
              <option value="">
                {loadingRepositories
                  ? t('workbench.project_git_repository_loading', '正在加载仓库...')
                  : t('workbench.project_git_repository_placeholder', '选择仓库')}
              </option>
              {repositories.map(repo => (
                <option key={`${repo.git_domain}:${repo.git_repo_id}`} value={repo.git_url}>
                  {repo.git_repo}
                </option>
              ))}
            </select>
            {repositoryError && (
              <p className="mt-2 text-xs text-[#c44]">{repositoryError}</p>
            )}
            {!loadingRepositories && !repositoryError && repositories.length === 0 && (
              <p className="mt-2 text-xs text-[#8a8f98]">
                {t('workbench.project_git_repository_empty', '暂无可用仓库')}
              </p>
            )}

            <label className="mt-5 block text-[13px] font-semibold text-[#202124]">
              {t('workbench.project_git_default_branch', '默认分支')}
            </label>
            <select
              data-testid="git-branch-select"
              value={selectedBranch?.name ?? ''}
              disabled={submitting || !selectedRepo || loadingBranches || branches.length === 0}
              onChange={event => {
                setSelectedBranch(
                  branches.find(branch => branch.name === event.target.value) ?? null,
                )
                setProjectCreateError(null)
              }}
              className="mt-2 h-10 w-full rounded-lg border border-[#d8d8d8] bg-white px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
            >
              <option value="">
                {loadingBranches
                  ? t('workbench.project_git_branch_loading', '正在加载分支...')
                  : t('workbench.project_git_branch_placeholder', '选择默认分支')}
              </option>
              {branches.map(branch => (
                <option key={branch.name} value={branch.name}>
                  {branch.default
                    ? t('workbench.project_git_branch_default_option', {
                        defaultValue: '{{branch}}（默认）',
                        branch: branch.name,
                      })
                    : branch.name}
                </option>
              ))}
            </select>
            {branchError && <p className="mt-2 text-xs text-[#c44]">{branchError}</p>}
            {gitProjectName && (
              <p className="mt-2 text-xs text-[#606368]">
                {t('workbench.project_git_name_preview', {
                  defaultValue: '项目名称：{{name}}',
                  name: gitProjectName,
                })}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="mt-5 flex items-center justify-between gap-3">
              <label className="block text-[13px] font-semibold text-[#202124]">
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
              <div className="flex items-center gap-2 border-b border-[#e5e5e5] px-3 py-2">
                <input
                  data-testid="project-directory-path-input"
                  value={pathInput}
                  disabled={submitting}
                  onChange={event => setPathInput(event.target.value)}
                  onBlur={handleConfirmPathInput}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleConfirmPathInput()
                    }
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 font-mono text-[13px] text-[#3c4043] outline-none focus:border-[#14b8a6] focus:bg-white focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
                  placeholder={t('workbench.project_directory_loading', '正在加载目录...')}
                />
                <button
                  type="button"
                  data-testid="open-create-folder-button"
                  disabled={submitting}
                  onClick={() => {
                    setNewFolderOpen(open => !open)
                    setCreateDirectoryError(null)
                  }}
                  className="flex h-11 min-w-[44px] shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-[#0f766e] hover:bg-[#e5f6f4] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderPlus className="h-4 w-4" />
                  {t('workbench.project_create_folder', '新建文件夹')}
                </button>
              </div>
              {newFolderOpen && (
                <div className="flex items-center gap-2 border-b border-[#e5e5e5] px-3 py-2">
                  <input
                    data-testid="create-folder-name-input"
                    value={newFolderName}
                    onChange={event => {
                      setNewFolderName(event.target.value)
                      setCreateDirectoryError(null)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void handleCreateDirectory()
                      }
                    }}
                    className="h-8 min-w-0 flex-1 rounded-md border border-[#d8d8d8] px-2 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
                    placeholder={t('workbench.project_create_folder_placeholder', '输入文件夹名称')}
                    autoFocus
                  />
                  <button
                    type="button"
                    data-testid="cancel-create-folder-button"
                    onClick={() => {
                      setNewFolderOpen(false)
                      setNewFolderName('')
                      setCreateDirectoryError(null)
                    }}
                    className="h-11 min-w-[44px] rounded-md border border-[#d8d8d8] px-2 text-xs font-medium text-[#3c4043] hover:bg-[#f7f7f8]"
                  >
                    {t('workbench.cancel', '取消')}
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-create-folder-button"
                    disabled={!newFolderName.trim() || creatingDirectory}
                    onClick={() => void handleCreateDirectory()}
                    className="h-11 min-w-[44px] rounded-md bg-[#14b8a6] px-2 text-xs font-medium text-white hover:bg-[#0f9f93] disabled:opacity-50"
                  >
                    {creatingDirectory
                      ? t('workbench.project_creating_folder', '创建中')
                      : t('workbench.project_create_folder_confirm', '创建')}
                  </button>
                </div>
              )}
              {createDirectoryError && (
                <p className="border-b border-[#e5e5e5] px-3 py-2 text-xs text-[#c44]">
                  {createDirectoryError}
                </p>
              )}
              <div data-testid="project-directory-tree" className="max-h-[320px] overflow-auto p-2">
                {currentPath && currentPath !== '/' && (
                  <button
                    type="button"
                    data-testid="directory-parent-button"
                    onClick={() => handleBrowsePath(getParentPath(currentPath))}
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
                {!loadingDirectories && directoryError && (
                  <p className="px-2 py-3 text-[13px] text-[#c44]">{directoryError}</p>
                )}
                {!loadingDirectories &&
                  !directoryError &&
                  filteredDirectories.map(directory => {
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
                          'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
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
                {!loadingDirectories && !directoryError && filteredDirectories.length === 0 && (
                  <p className="px-2 py-8 text-center text-[13px] text-[#8a8f98]">
                    {t('workbench.project_directory_empty', '当前目录下没有子目录')}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {projectCreateError && (
          <p data-testid="project-create-error" className="mt-4 text-xs text-[#c44]">
            {projectCreateError}
          </p>
        )}
        {submitting && (
          <p
            data-testid="project-submit-progress"
            className="mt-4 flex items-center gap-2 text-xs text-[#606368]"
          >
            <Loader2
              data-testid="project-submit-progress-spinner"
              className="h-3.5 w-3.5 animate-spin text-[#14b8a6]"
            />
            <span>{submittingHint}</span>
          </p>
        )}

        <div className="mt-7 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-project-create-button"
            onClick={onClose}
            disabled={submitting}
            className="h-10 rounded-md border border-[#d8d8d8] px-4 text-[13px] font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="create-project-button"
            disabled={!canCreate || submitting}
            onClick={async () => {
              setSubmitting(true)
              setProjectCreateError(null)
              try {
                if (mode === 'git') {
                  if (!selectedRepo || !selectedBranch || !onCreateGitWorkspaceProject) return
                  await onCreateGitWorkspaceProject({
                    device_id: deviceId,
                    name: gitProjectName || selectedRepo.git_repo,
                    git: {
                      url: selectedRepo.git_url,
                      repo: selectedRepo.git_repo,
                      repoId: selectedRepo.git_repo_id,
                      domain: selectedRepo.git_domain,
                      branch: selectedBranch.name,
                    },
                  })
                  onClose()
                  return
                }

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
              } catch (error) {
                setProjectCreateError(
                  getGitErrorMessage(
                    error,
                    t('workbench.project_git_token_missing', '请先在设置中配置 Git Token'),
                    t('workbench.project_create_failed', '项目创建失败'),
                    path =>
                      t('workbench.project_git_directory_exists', {
                        defaultValue: '项目目录已存在：{{path}}',
                        path,
                      }),
                  ),
                )
              } finally {
                setSubmitting(false)
              }
            }}
            aria-busy={submitting}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-[#14b8a6] px-4 text-[13px] font-medium text-white hover:bg-[#0f9f93] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting && (
              <Loader2
                data-testid="project-submit-spinner"
                className="h-4 w-4 animate-spin"
              />
            )}
            {submitting ? submittingLabel : t('workbench.create_project', '创建项目')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
