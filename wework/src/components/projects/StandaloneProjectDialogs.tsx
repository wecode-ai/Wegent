import {
  AlertCircle,
  Check,
  ChevronLeft,
  Copy,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe2,
  Loader2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotAvailable } from '@/features/dsh-runtime/useDshSlotAvailable'
import { hasEmbeddedHttpGitCredentials } from '@/lib/git-url'
import { isImeEnterEvent } from '@/lib/ime'
import { openNativeProjectDirectoryPickers } from '@/lib/native-directory-picker'
import { cn } from '@/lib/utils'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canUseForProjectCreation,
  canUseForRemoteProjectCreation,
  hasLocalRuntimeRoute,
  isCloudDevice,
  isClaudeCodeDevice,
  isRemoteDevice,
  isUsableDevice,
  isWeWorkExecutorVersionCompatible,
} from '@/lib/device-capabilities'
import type { CloneGitRepositoryInput, DeviceInfo } from '@/types/api'
import type { DockerRemoteDeviceCommandResponse, RemoteDeviceStartupCommand } from '@/types/devices'
import { DeviceFolderPicker } from './DeviceFolderPicker'
import { basename, joinPath } from './device-folder-path'
import { LocalProjectCreateDialog } from './LocalProjectCreateDialog'

export type StandaloneWorkspaceDialogMode = 'existing' | 'remote'
export type StandaloneRemoteDialogIntent = 'project' | 'cloud-work' | 'add-device'
export type RemoteProjectSource = 'existing' | 'blank' | 'git'

function isLocalDevice(device: DeviceInfo): boolean {
  return !isCloudDevice(device) && !isRemoteDevice(device)
}

function isRemoteProjectDevice(device: DeviceInfo): boolean {
  return isCloudDevice(device) || isRemoteDevice(device)
}

function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name?.trim() || ''
}

function extractNetworkHost(value?: string | null): string | null {
  if (!value) return null
  const trimmedValue = value.trim()
  if (!trimmedValue) return null

  const bracketMatch = trimmedValue.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]

  const colonParts = trimmedValue.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }

  return trimmedValue
}

function getRemoteDeviceNetworkLabel(device: DeviceInfo): string | null {
  return extractNetworkHost(device.runtime_transfer_host) ?? extractNetworkHost(device.client_ip)
}

function getRemoteDeviceLabel(device: DeviceInfo): string {
  return getStandaloneDeviceLabel(device)
}

function getRemoteDeviceOptionLabel(
  device: DeviceInfo,
  typeLabel: string,
  unavailableLabel: string,
  upgradeLabel: string
): string {
  const deviceLabel = getStandaloneDeviceLabel(device)
  const networkLabel = getRemoteDeviceNetworkLabel(device)
  const labels = [typeLabel, deviceLabel]
  if (networkLabel && networkLabel !== deviceLabel) labels.push(networkLabel)
  if (!isUsableDevice(device)) labels.push(unavailableLabel)
  else if (!isWeWorkExecutorVersionCompatible(device.executor_version)) labels.push(upgradeLabel)
  return labels.join(' · ')
}

function getStandaloneDeviceOptions(
  devices: DeviceInfo[],
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo[] {
  const isTargetDevice = mode === 'remote' ? isRemoteProjectDevice : isLocalDevice
  return devices.filter(
    device =>
      isClaudeCodeDevice(device) &&
      isTargetDevice(device) &&
      (mode !== 'remote' || !hasLocalRuntimeRoute(device))
  )
}

function getUsableStandaloneDevices(
  devices: DeviceInfo[],
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo[] {
  return getStandaloneDeviceOptions(devices, mode)
    .filter(device =>
      mode === 'remote' ? canUseForRemoteProjectCreation(device) : canUseForProjectCreation(device)
    )
    .sort((left, right) => {
      const leftLabel = isRemoteProjectDevice(left)
        ? getRemoteDeviceLabel(left)
        : getStandaloneDeviceLabel(left)
      const rightLabel = isRemoteProjectDevice(right)
        ? getRemoteDeviceLabel(right)
        : getStandaloneDeviceLabel(right)
      return leftLabel.localeCompare(rightLabel)
    })
}

function getPreferredStandaloneWorkspaceDevice(
  devices: DeviceInfo[],
  preferredDeviceId: string | null | undefined,
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo | null {
  const usableDevices = getUsableStandaloneDevices(devices, mode)
  return (
    usableDevices.find(device => device.device_id === preferredDeviceId) ??
    usableDevices.find(device => device.is_default) ??
    usableDevices[0] ??
    null
  )
}

function getUniqueProjectDirectoryName(baseName: string, existingNames: string[]): string {
  const existingNameSet = new Set(existingNames.map(name => name.trim()).filter(Boolean))
  if (!existingNameSet.has(baseName)) return baseName

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`
    if (!existingNameSet.has(candidate)) return candidate
  }

  return `${baseName} ${Date.now()}`
}

function getGitRepositoryName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const path =
    trimmed.startsWith('git@') && trimmed.includes(':')
      ? trimmed.slice(trimmed.indexOf(':') + 1)
      : trimmed
  return (
    path
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/i, '') ?? ''
  )
}

function isValidGitRepositoryUrl(url: string): boolean {
  const value = url.trim()
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return true
  if (/^[^@\s]+@[^:\s]+:.+/.test(value)) return true
  try {
    const parsed = new URL(value)
    return ['http:', 'https:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function normalizeRemoteDeviceStartupCommands(
  response: DockerRemoteDeviceCommandResponse | null
): RemoteDeviceStartupCommand[] {
  if (!response) return []
  if (Array.isArray(response.commands) && response.commands.length > 0) {
    return response.commands.filter(command => command.command.trim())
  }
  return [
    {
      kind: 'docker',
      label: 'Docker',
      command: response.command,
    },
  ]
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

  useEscapeKey(onClose, !submitting)

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
          className="mt-5 h-12 w-full rounded-xl border border-border bg-transparent px-4 text-base text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50"
        />
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
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

export function StandaloneFolderProjectDialog({
  open,
  mode,
  remoteIntent = 'project',
  fixedDeviceId,
  chooseProjectSource = false,
  layer = 'modal',
  devices,
  preferredDeviceId,
  onClose,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  onStartGitCloneProject,
  onOpenStandaloneWorkspace,
  onGetRemoteDeviceStartupCommand,
  onRefreshDevices,
  preferNativeLocalPicker = true,
}: {
  open: boolean
  mode: StandaloneWorkspaceDialogMode
  remoteIntent?: StandaloneRemoteDialogIntent
  fixedDeviceId?: string
  chooseProjectSource?: boolean
  layer?: 'modal' | 'system-popover'
  preferNativeLocalPicker?: boolean
  devices: DeviceInfo[]
  preferredDeviceId?: string | null
  onClose: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  onStartGitCloneProject?: (deviceId: string, input: CloneGitRepositoryInput) => void
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string,
    projectRoots?: string[]
  ) => Promise<void> | void
  onGetRemoteDeviceStartupCommand?: () => Promise<DockerRemoteDeviceCommandResponse>
  onRefreshDevices?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  const workspaceMenuExtensionsAvailable = useDshSlotAvailable(
    WEWORK_DSH_SLOTS.workspaceMenuSection
  )
  const [startupCommand, setStartupCommand] = useState<DockerRemoteDeviceCommandResponse | null>(
    null
  )
  const [startupCommandError, setStartupCommandError] = useState<string | null>(null)
  const [startupCommandCopied, setStartupCommandCopied] = useState(false)
  const [activeStartupCommandKind, setActiveStartupCommandKind] = useState<string>('docker')
  const [nativePickerError, setNativePickerError] = useState<string | null>(null)
  const [nativePickerFallback, setNativePickerFallback] = useState(false)
  const [selectedLocalRoots, setSelectedLocalRoots] = useState<string[]>([])
  const [selectedLocalDeviceId, setSelectedLocalDeviceId] = useState('')
  const [remoteProjectSource, setRemoteProjectSource] = useState<RemoteProjectSource | null>(null)
  const [gitUrl, setGitUrl] = useState('')
  const [gitBranch, setGitBranch] = useState('')
  const [gitParentPath, setGitParentPath] = useState('')
  const [gitParentPickerOpen, setGitParentPickerOpen] = useState(false)
  const [gitAdvancedOpen, setGitAdvancedOpen] = useState(false)
  const [gitSubmitting, setGitSubmitting] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const nativePickerStartedRef = useRef(false)
  const gitParentDefaultDeviceIdRef = useRef<string | null>(null)
  const selectableDevices = useMemo(() => {
    if (!fixedDeviceId) return getUsableStandaloneDevices(devices, mode)
    const fixedDevice = devices.find(device => device.device_id === fixedDeviceId)
    if (!fixedDevice) return []
    const usable = isRemoteProjectDevice(fixedDevice)
      ? canUseForRemoteProjectCreation(fixedDevice)
      : canUseForProjectCreation(fixedDevice)
    return usable ? [fixedDevice] : []
  }, [devices, fixedDeviceId, mode])
  const remoteDeviceOptions = useMemo(
    () =>
      mode === 'remote' && !fixedDeviceId
        ? getStandaloneDeviceOptions(devices, mode).sort((left, right) =>
            getRemoteDeviceLabel(left).localeCompare(getRemoteDeviceLabel(right))
          )
        : [],
    [devices, fixedDeviceId, mode]
  )
  const cloudDeviceOptions = remoteDeviceOptions.filter(isCloudDevice)
  const remoteDockerDeviceOptions = remoteDeviceOptions.filter(isRemoteDevice)
  const defaultDevice = useMemo(
    () =>
      fixedDeviceId
        ? (selectableDevices.find(device => device.device_id === fixedDeviceId) ?? null)
        : getPreferredStandaloneWorkspaceDevice(devices, preferredDeviceId, mode),
    [devices, fixedDeviceId, mode, preferredDeviceId, selectableDevices]
  )
  const [activeDeviceId, setActiveDeviceId] = useState(
    defaultDevice?.device_id ?? selectableDevices[0]?.device_id ?? ''
  )
  const activeDevice =
    selectableDevices.find(device => device.device_id === activeDeviceId) ??
    selectableDevices[0] ??
    null
  const addingRemoteDevice = mode === 'remote' && remoteIntent === 'add-device'
  const choosingProjectSource =
    (mode === 'remote' || chooseProjectSource) &&
    remoteIntent === 'project' &&
    remoteProjectSource === null
  const showStartupCommand =
    mode === 'remote' &&
    (addingRemoteDevice || !activeDevice) &&
    Boolean(onGetRemoteDeviceStartupCommand)
  const usesRemoteFolderPicker =
    chooseProjectSource ||
    mode === 'remote' ||
    (mode === 'existing' && activeDevice !== null && isRemoteProjectDevice(activeDevice))
  const closeDialog = useCallback(() => {
    nativePickerStartedRef.current = false
    setNativePickerError(null)
    setNativePickerFallback(false)
    setSelectedLocalRoots([])
    setSelectedLocalDeviceId('')
    setRemoteProjectSource(null)
    setGitUrl('')
    setGitBranch('')
    setGitParentPath('')
    setGitParentPickerOpen(false)
    setGitAdvancedOpen(false)
    setGitSubmitting(false)
    setGitError(null)
    gitParentDefaultDeviceIdRef.current = null
    onClose()
  }, [onClose])

  useEscapeKey(closeDialog, open)

  const title = chooseProjectSource
    ? t('workbench.add_project_to_device_title', '添加代码项目')
    : usesRemoteFolderPicker
      ? remoteIntent === 'add-device'
        ? t('workbench.add_cloud_device_title', '添加新设备')
        : remoteIntent === 'cloud-work'
          ? t('workbench.cloud_work_title', '云端工作')
          : t('workbench.add_remote_project_title', '添加远程项目')
      : t('workbench.use_existing_folder_title', '使用现有文件夹')
  const description = chooseProjectSource
    ? t(
        'workbench.add_project_to_device_desc',
        '选择项目来源和设备上的目录，保存后将绑定到当前机器人。'
      )
    : usesRemoteFolderPicker
      ? remoteIntent === 'add-device'
        ? t(
            'workbench.add_cloud_device_desc',
            '在要接入的云主机或宿主机上运行连接脚本，启动后回到这里刷新设备。'
          )
        : remoteIntent === 'cloud-work'
          ? showStartupCommand
            ? t(
                'workbench.cloud_work_connect_desc',
                '还没有可用云端设备。先在云主机或另一台电脑上运行下面的连接脚本。'
              )
            : t('workbench.cloud_work_desc', '选择这台云端设备要处理的项目目录。')
          : workspaceMenuExtensionsAvailable
            ? t(
                'workbench.add_remote_project_desc',
                '选择远程主机，然后打开目录、新建项目或克隆 Git 仓库。'
              )
            : t(
                'workbench.add_remote_project_desc_without_git',
                '选择远程主机，然后打开目录或新建项目。'
              )
      : t('workbench.use_existing_folder_desc', '选择本地设备上的一个文件夹。')
  const startupCommandLoading = showStartupCommand && !startupCommand && !startupCommandError
  const startupCommands = useMemo(
    () => normalizeRemoteDeviceStartupCommands(startupCommand),
    [startupCommand]
  )
  const activeStartupCommand =
    startupCommands.find(command => command.kind === activeStartupCommandKind) ??
    startupCommands[0] ??
    null
  const shouldUseNativeLocalPicker =
    open &&
    mode === 'existing' &&
    !chooseProjectSource &&
    activeDevice !== null &&
    isLocalDevice(activeDevice) &&
    preferNativeLocalPicker &&
    selectedLocalRoots.length === 0 &&
    !nativePickerFallback
  const nativePickerDeviceId = activeDevice?.device_id ?? null

  useEffect(() => {
    if (!open || !showStartupCommand || startupCommand || startupCommandError) return undefined

    let cancelled = false
    onGetRemoteDeviceStartupCommand?.()
      .then(command => {
        if (!cancelled) {
          setStartupCommand(command)
          const firstCommand = normalizeRemoteDeviceStartupCommands(command)[0]
          setActiveStartupCommandKind(firstCommand?.kind ?? 'docker')
        }
      })
      .catch(error => {
        if (!cancelled) {
          setStartupCommandError(
            error instanceof Error
              ? error.message
              : t('workbench.remote_device_startup_error', '启动脚本生成失败')
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    onGetRemoteDeviceStartupCommand,
    open,
    showStartupCommand,
    startupCommand,
    startupCommandError,
    t,
  ])

  useEffect(() => {
    const deviceId = activeDevice?.device_id
    if (
      !open ||
      remoteProjectSource !== 'git' ||
      !deviceId ||
      gitParentDefaultDeviceIdRef.current === deviceId
    ) {
      return undefined
    }
    gitParentDefaultDeviceIdRef.current = deviceId
    let cancelled = false
    onGetDeviceHomeDirectory(deviceId)
      .then(path => {
        if (!cancelled) {
          setGitParentPath(currentPath => currentPath || path)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setGitError(
            error instanceof Error
              ? error.message
              : t('workbench.project_home_directory_load_failed', '无法读取 home 目录')
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeDevice?.device_id, onGetDeviceHomeDirectory, open, remoteProjectSource, t])

  useEffect(() => {
    if (!open) {
      nativePickerStartedRef.current = false
      return undefined
    }
    if (!shouldUseNativeLocalPicker || !nativePickerDeviceId) return undefined
    if (nativePickerStartedRef.current) return undefined

    const openPickerTimer = window.setTimeout(() => {
      nativePickerStartedRef.current = true
      void (async () => {
        try {
          setNativePickerError(null)
          const selectedPaths = await openNativeProjectDirectoryPickers()
          const selectedPath = selectedPaths[0]
          if (!selectedPath) {
            closeDialog()
            return
          }
          setSelectedLocalDeviceId(nativePickerDeviceId)
          setSelectedLocalRoots(selectedPaths)
        } catch (error) {
          console.error('[Wework project] native picker failed', error)
          setNativePickerError(
            error instanceof Error
              ? error.message
              : t('workbench.project_directory_select_failed', '项目打开失败')
          )
        }
      })()
    }, 0)

    return () => {
      window.clearTimeout(openPickerTimer)
    }
  }, [
    closeDialog,
    nativePickerDeviceId,
    onOpenStandaloneWorkspace,
    open,
    shouldUseNativeLocalPicker,
    t,
  ])

  const retryLoadStartupCommand = () => {
    setStartupCommand(null)
    setStartupCommandError(null)
    setStartupCommandCopied(false)
    setActiveStartupCommandKind('docker')
  }

  const copyStartupCommand = async () => {
    if (!activeStartupCommand) return
    await navigator.clipboard?.writeText(activeStartupCommand.command)
    setStartupCommandCopied(true)
  }

  const submitGitProject = async () => {
    if (!activeDevice || (!onCloneGitRepository && !onStartGitCloneProject) || gitSubmitting) return
    const normalizedUrl = gitUrl.trim()
    const repositoryName = getGitRepositoryName(normalizedUrl)
    if (!normalizedUrl || !repositoryName || !isValidGitRepositoryUrl(normalizedUrl)) {
      setGitError(t('workbench.remote_project_git_url_invalid', '请输入有效的 Git 仓库地址'))
      return
    }
    if (hasEmbeddedHttpGitCredentials(normalizedUrl)) {
      setGitError(
        t(
          'workbench.remote_project_git_credentials_forbidden',
          '仓库地址不能包含账号、密码或 Token，请使用设备已有的 Git 凭据。'
        )
      )
      return
    }
    if (!gitParentPath.trim()) {
      setGitError(t('workbench.remote_project_git_parent_required', '请输入目标父目录'))
      return
    }

    const targetPath = joinPath(gitParentPath.trim(), repositoryName)
    if (onStartGitCloneProject) {
      onStartGitCloneProject(activeDevice.device_id, {
        url: normalizedUrl,
        ...(gitBranch.trim() ? { branch: gitBranch.trim() } : {}),
        targetPath,
      })
      closeDialog()
      return
    }

    setGitSubmitting(true)
    setGitError(null)
    try {
      await onCloneGitRepository!(activeDevice.device_id, {
        url: normalizedUrl,
        ...(gitBranch.trim() ? { branch: gitBranch.trim() } : {}),
        targetPath,
      })
      await onOpenStandaloneWorkspace?.(activeDevice.device_id, targetPath, repositoryName)
      closeDialog()
    } catch (error) {
      setGitError(
        error instanceof Error
          ? error.message
          : t('workbench.remote_project_git_clone_failed', 'Git 仓库克隆失败')
      )
    } finally {
      setGitSubmitting(false)
    }
  }

  if (!open) return null

  if (selectedLocalRoots.length > 0) {
    const selectedDevice =
      devices.find(device => device.device_id === selectedLocalDeviceId) ?? null
    return (
      <LocalProjectCreateDialog
        open
        device={selectedDevice}
        initialRoots={selectedLocalRoots}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onClose={closeDialog}
        onCreate={async ({ deviceId, name, roots }) => {
          await onOpenStandaloneWorkspace?.(deviceId, roots[0], name, roots)
        }}
      />
    )
  }

  if (shouldUseNativeLocalPicker) {
    if (!nativePickerError) return null

    return createPortal(
      <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
        <div
          role="dialog"
          aria-modal="true"
          data-testid="standalone-folder-native-error-dialog"
          className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 text-text-primary shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">
                {t('workbench.use_existing_folder_title', '使用现有文件夹')}
              </h2>
              <p className="mt-2 text-sm leading-5 text-red-500">{nativePickerError}</p>
            </div>
            <button
              type="button"
              data-testid="close-standalone-folder-native-error-dialog"
              onClick={closeDialog}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
              aria-label={t('workbench.close_dialog', '关闭')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              data-testid="cancel-standalone-folder-native-error-button"
              onClick={closeDialog}
              className="h-10 rounded-xl border border-border px-5 text-sm font-medium text-text-primary hover:bg-muted"
            >
              {t('workbench.cancel', '取消')}
            </button>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div
      data-testid="standalone-folder-project-dialog-overlay"
      onClick={event => {
        if (event.target === event.currentTarget) closeDialog()
      }}
      className={cn(
        'fixed inset-0 flex items-center justify-center bg-black/35 px-4',
        layer === 'system-popover' ? 'z-system-popover' : 'z-modal'
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="standalone-folder-project-dialog"
        className={[
          'max-h-[92vh] w-full overflow-y-auto border border-border bg-popover shadow-2xl text-text-primary',
          usesRemoteFolderPicker
            ? 'max-w-[520px] rounded-[24px] p-5'
            : 'max-w-[760px] rounded-2xl p-6',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className={usesRemoteFolderPicker ? 'heading-base' : 'heading-lg'}>{title}</h2>
            <p
              className={
                usesRemoteFolderPicker
                  ? 'mt-2 max-w-[440px] text-sm leading-5 text-text-secondary'
                  : 'mt-2 max-w-[560px] text-sm leading-6 text-text-secondary'
              }
            >
              {description}
            </p>
          </div>
          <button
            type="button"
            data-testid="close-standalone-folder-project-dialog"
            onClick={closeDialog}
            className={[
              'flex shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted',
              usesRemoteFolderPicker ? 'h-8 min-w-[32px]' : 'h-10 min-w-[40px]',
            ].join(' ')}
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {usesRemoteFolderPicker && remoteDeviceOptions.length > 0 && !addingRemoteDevice && (
          <label className="mt-5 block">
            <span className="text-sm font-medium text-text-primary">
              {t('workbench.remote_host', '远程主机')}
            </span>
            <span className="mt-2 flex h-10 items-center gap-2.5 rounded-[10px] border border-border bg-background px-3">
              <Globe2 className="h-4 w-4 text-primary" />
              <select
                data-testid="standalone-remote-device-select"
                value={activeDevice?.device_id ?? ''}
                onChange={event => {
                  setActiveDeviceId(event.target.value)
                  gitParentDefaultDeviceIdRef.current = null
                  setGitParentPath('')
                  setGitParentPickerOpen(false)
                  setGitError(null)
                }}
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none"
              >
                {!activeDevice && (
                  <option value="" disabled>
                    {t('workbench.no_remote_project_device', '暂无可用远程或云设备')}
                  </option>
                )}
                {cloudDeviceOptions.length > 0 && (
                  <optgroup label={t('workbench.remote_host_cloud_group', '云设备')}>
                    {cloudDeviceOptions.map(device => (
                      <option
                        key={device.device_id}
                        value={device.device_id}
                        disabled={!canUseForRemoteProjectCreation(device)}
                        data-testid={`standalone-remote-device-option-${device.device_id}`}
                      >
                        {getRemoteDeviceOptionLabel(
                          device,
                          t('workbench.remote_host_cloud_group', '云设备'),
                          t('workbench.project_device_offline', '（离线）'),
                          t(
                            'workbench.remote_host_upgrade_required',
                            `需升级到 v${WEWORK_MIN_EXECUTOR_VERSION}`,
                            { version: WEWORK_MIN_EXECUTOR_VERSION }
                          )
                        )}
                      </option>
                    ))}
                  </optgroup>
                )}
                {remoteDockerDeviceOptions.length > 0 && (
                  <optgroup label={t('workbench.remote_host_docker_group', '远程 Docker 设备')}>
                    {remoteDockerDeviceOptions.map(device => (
                      <option
                        key={device.device_id}
                        value={device.device_id}
                        disabled={!canUseForRemoteProjectCreation(device)}
                        data-testid={`standalone-remote-device-option-${device.device_id}`}
                      >
                        {getRemoteDeviceOptionLabel(
                          device,
                          t('workbench.remote_host_docker_group', '远程 Docker 设备'),
                          t('workbench.project_device_offline', '（离线）'),
                          t(
                            'workbench.remote_host_upgrade_required',
                            `需升级到 v${WEWORK_MIN_EXECUTOR_VERSION}`,
                            { version: WEWORK_MIN_EXECUTOR_VERSION }
                          )
                        )}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </span>
            {remoteDeviceOptions.some(device => !canUseForRemoteProjectCreation(device)) && (
              <span
                data-testid="standalone-remote-device-unavailable-hint"
                className="mt-2 block text-xs leading-5 text-text-secondary"
              >
                {t(
                  'workbench.remote_host_unavailable_hint',
                  '离线或版本不匹配的远程设备会显示在列表中，但暂时不能选择。'
                )}
              </span>
            )}
          </label>
        )}

        {!activeDevice || addingRemoteDevice ? (
          showStartupCommand ? (
            <div
              data-testid="standalone-folder-no-device"
              className="mt-6 rounded-2xl border border-border bg-background p-5 text-text-primary"
            >
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Globe2 className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">
                    {t('workbench.remote_device_startup_title', '连接云设备')}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {t(
                      'workbench.remote_device_startup_desc',
                      '在云主机或另一台电脑上运行脚本，把它接入为云端设备。启动后点击刷新设备。'
                    )}
                  </p>
                </div>
              </div>

              {startupCommandLoading && (
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-border px-3 py-3 text-sm text-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {t('workbench.remote_device_startup_loading', '正在生成启动脚本...')}
                </div>
              )}

              {startupCommandError && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-3 text-sm text-red-500">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">{startupCommandError}</span>
                  <button
                    type="button"
                    data-testid="retry-remote-device-startup-command"
                    onClick={retryLoadStartupCommand}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-red-500/10"
                  >
                    {t('workbench.remote_device_startup_retry', '重试')}
                  </button>
                </div>
              )}

              {startupCommands.length > 0 && activeStartupCommand && (
                <div className="mt-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="inline-flex h-10 w-full rounded-xl border border-border bg-surface p-1 sm:w-auto">
                      {startupCommands.map(command => {
                        const isActive = command.kind === activeStartupCommand.kind
                        return (
                          <button
                            key={command.kind}
                            type="button"
                            data-testid={`remote-device-startup-tab-${command.kind}`}
                            onClick={() => {
                              setActiveStartupCommandKind(command.kind)
                              setStartupCommandCopied(false)
                            }}
                            className={[
                              'flex h-8 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium sm:flex-none',
                              isActive
                                ? 'bg-background text-text-primary shadow-sm'
                                : 'text-text-secondary hover:text-text-primary',
                            ].join(' ')}
                          >
                            {command.kind === 'process'
                              ? t('workbench.remote_device_startup_process', '宿主机启动')
                              : command.kind === 'docker'
                                ? t('workbench.remote_device_startup_docker', 'Docker')
                                : command.label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex gap-2 sm:justify-end">
                      {onRefreshDevices && (
                        <button
                          type="button"
                          data-testid="refresh-remote-devices-button"
                          onClick={() => void onRefreshDevices()}
                          className="h-10 flex-1 rounded-xl border border-border px-3 text-sm font-medium text-text-primary hover:bg-muted sm:flex-none"
                        >
                          {t('workbench.remote_device_refresh', '刷新设备')}
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="mt-3 text-sm leading-5 text-text-secondary">
                    {activeStartupCommand.kind === 'process'
                      ? t(
                          'workbench.remote_device_startup_process_desc',
                          '适合不使用容器的远程机器，直接在宿主机运行云端设备连接程序。'
                        )
                      : activeStartupCommand.kind === 'docker'
                        ? t(
                            'workbench.remote_device_startup_docker_desc',
                            '推荐方式。用容器启动云端设备连接程序，适合云主机或远程服务器。'
                          )
                        : activeStartupCommand.description}
                  </p>

                  <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
                    <div className="flex h-9 items-center justify-between gap-3 border-b border-border px-3">
                      <span className="truncate text-xs font-semibold text-text-secondary">
                        {t('workbench.remote_device_startup_script_title', '启动脚本')}
                      </span>
                      <button
                        type="button"
                        data-testid="copy-remote-device-startup-command"
                        onClick={() => void copyStartupCommand()}
                        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                      >
                        {startupCommandCopied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {startupCommandCopied
                          ? t('workbench.remote_device_startup_copied', '已复制')
                          : t('workbench.remote_device_startup_copy', '复制')}
                      </button>
                    </div>
                    <pre
                      data-testid="remote-device-startup-command"
                      className="max-h-[220px] overflow-auto whitespace-pre p-3 font-mono text-xs leading-5 text-text-primary"
                    >
                      {activeStartupCommand.command}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p
              data-testid="standalone-folder-no-device"
              className="mt-7 rounded-[16px] border border-border px-4 py-5 text-text-secondary"
            >
              {usesRemoteFolderPicker
                ? t('workbench.no_remote_project_device', '暂无可用远程或云设备')
                : t('workbench.no_local_project_device', '暂无可用本地设备')}
            </p>
          )
        ) : choosingProjectSource ? (
          <div data-testid="remote-project-source-options" className="mt-5 space-y-2">
            {(
              [
                {
                  source: 'existing',
                  icon: FolderOpen,
                  title: t('workbench.remote_project_source_existing', '打开已有目录'),
                  description: t(
                    'workbench.remote_project_source_existing_desc',
                    '选择设备上已经存在的项目目录。'
                  ),
                },
                {
                  source: 'blank',
                  icon: FolderPlus,
                  title: t('workbench.remote_project_source_blank', '新建空项目'),
                  description: t(
                    'workbench.remote_project_source_blank_desc',
                    '选择父目录并创建新的项目文件夹。'
                  ),
                },
                ...(workspaceMenuExtensionsAvailable
                  ? [
                      {
                        source: 'git' as const,
                        icon: GitBranch,
                        title: t('workbench.remote_project_source_git', '从 Git 仓库克隆'),
                        description: t(
                          'workbench.remote_project_source_git_desc',
                          '输入仓库地址，在当前设备上克隆并打开。'
                        ),
                      },
                    ]
                  : []),
              ] as const
            ).map(option => {
              const Icon = option.icon
              return (
                <button
                  key={option.source}
                  type="button"
                  data-testid={`remote-project-source-${option.source}`}
                  onClick={() => {
                    setRemoteProjectSource(option.source)
                    if (option.source === 'git') {
                      gitParentDefaultDeviceIdRef.current = null
                      setGitParentPath('')
                      setGitParentPickerOpen(false)
                    }
                    setGitError(null)
                  }}
                  className="flex w-full items-start gap-3 rounded-xl border border-border bg-background p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">
                      {option.title}
                    </span>
                    <span className="mt-1 block text-sm leading-5 text-text-secondary">
                      {option.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : remoteProjectSource === 'git' ? (
          <div className="mt-5">
            <button
              type="button"
              data-testid="remote-project-source-back"
              disabled={gitSubmitting}
              onClick={() => setRemoteProjectSource(null)}
              className="inline-flex h-11 items-center gap-1 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50 sm:h-8"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('workbench.remote_project_source_change', '更改项目来源')}
            </button>
            {gitParentPickerOpen ? (
              <div className="mt-3">
                <h3 className="mb-2 text-sm font-medium text-text-primary">
                  {t('workbench.remote_project_git_parent_select', '选择目标父目录')}
                </h3>
                <DeviceFolderPicker
                  key={activeDevice.device_id}
                  device={activeDevice}
                  mode="select"
                  variant="remote"
                  initialPath={gitParentPath}
                  confirmLabel={t('workbench.remote_project_git_parent_confirm', '选择此文件夹')}
                  onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
                  onListDeviceDirectories={onListDeviceDirectories}
                  onCreateDeviceDirectory={onCreateDeviceDirectory}
                  onCancel={() => setGitParentPickerOpen(false)}
                  onConfirm={result => {
                    setGitParentPath(result.path)
                    setGitParentPickerOpen(false)
                    setGitError(null)
                  }}
                />
              </div>
            ) : (
              <>
                <label className="mt-3 block">
                  <span className="text-sm font-medium text-text-primary">
                    {t('workbench.remote_project_git_url', 'Git 仓库地址')}
                  </span>
                  <input
                    data-testid="remote-project-git-url-input"
                    value={gitUrl}
                    autoFocus
                    disabled={gitSubmitting}
                    onChange={event => {
                      setGitUrl(event.target.value)
                      setGitError(null)
                    }}
                    placeholder="https://github.com/owner/repository.git"
                    className="mt-2 h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-60 sm:h-10"
                  />
                </label>
                <div className="mt-4">
                  <label
                    htmlFor="remote-project-git-parent-input"
                    className="text-sm font-medium text-text-primary"
                  >
                    {t('workbench.remote_project_git_parent', '目标父目录')}
                  </label>
                  <span className="mt-2 flex gap-2">
                    <input
                      id="remote-project-git-parent-input"
                      data-testid="remote-project-git-parent-input"
                      value={gitParentPath}
                      disabled={gitSubmitting}
                      onChange={event => {
                        setGitParentPath(event.target.value)
                        setGitError(null)
                      }}
                      className="h-11 min-w-0 flex-1 rounded-[10px] border border-border bg-background px-3 font-mono text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-60 sm:h-10"
                    />
                    <button
                      type="button"
                      data-testid="remote-project-git-parent-browse"
                      disabled={gitSubmitting}
                      onClick={() => setGitParentPickerOpen(true)}
                      className="inline-flex h-11 shrink-0 items-center gap-2 rounded-[10px] border border-border px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50 sm:h-10"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {t('workbench.remote_project_git_parent_browse', '选择')}
                    </button>
                  </span>
                </div>
                {gitUrl.trim() && getGitRepositoryName(gitUrl) && gitParentPath.trim() && (
                  <p
                    data-testid="remote-project-git-target-preview"
                    className="mt-2 truncate font-mono text-xs text-text-secondary"
                  >
                    {joinPath(gitParentPath.trim(), getGitRepositoryName(gitUrl))}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="remote-project-git-advanced-toggle"
                  disabled={gitSubmitting}
                  onClick={() => setGitAdvancedOpen(value => !value)}
                  className="mt-4 h-11 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50 sm:h-8"
                >
                  {gitAdvancedOpen
                    ? t('workbench.remote_project_git_advanced_hide', '收起分支设置')
                    : t('workbench.remote_project_git_advanced_show', '指定分支')}
                </button>
                {gitAdvancedOpen && (
                  <label className="mt-2 block">
                    <span className="sr-only">
                      {t('workbench.remote_project_git_branch', 'Git 分支')}
                    </span>
                    <input
                      data-testid="remote-project-git-branch-input"
                      value={gitBranch}
                      disabled={gitSubmitting}
                      onChange={event => {
                        setGitBranch(event.target.value)
                        setGitError(null)
                      }}
                      placeholder={t(
                        'workbench.remote_project_git_branch_placeholder',
                        '留空使用默认分支'
                      )}
                      className="h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-60 sm:h-10"
                    />
                  </label>
                )}
                {gitError && (
                  <p data-testid="remote-project-git-error" className="mt-3 text-sm text-red-500">
                    {gitError}
                  </p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    data-testid="remote-project-git-cancel"
                    disabled={gitSubmitting}
                    onClick={closeDialog}
                    className="h-11 rounded-[10px] px-4 text-sm font-medium text-text-secondary hover:bg-muted disabled:opacity-50 sm:h-9"
                  >
                    {t('workbench.cancel', '取消')}
                  </button>
                  <button
                    type="button"
                    data-testid="remote-project-git-submit"
                    disabled={
                      gitSubmitting ||
                      !gitUrl.trim() ||
                      !gitParentPath.trim() ||
                      !getGitRepositoryName(gitUrl)
                    }
                    onClick={() => void submitGitProject()}
                    className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50 sm:h-9"
                  >
                    {gitSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('workbench.remote_project_git_submit', '克隆并添加')}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mt-5">
            {(mode === 'remote' || chooseProjectSource) && remoteIntent === 'project' && (
              <button
                type="button"
                data-testid="remote-project-source-back"
                onClick={() => setRemoteProjectSource(null)}
                className="mb-3 inline-flex h-8 items-center gap-1 text-sm text-text-secondary hover:text-text-primary"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('workbench.remote_project_source_change', '更改项目来源')}
              </button>
            )}
            {usesRemoteFolderPicker && (
              <h3 className="mb-2 text-sm font-medium text-text-primary">
                {t('workbench.project_directory_path', '文件夹路径')}
              </h3>
            )}
            <DeviceFolderPicker
              key={activeDevice.device_id}
              device={activeDevice}
              mode={remoteProjectSource === 'blank' ? 'create' : 'select'}
              variant={usesRemoteFolderPicker ? 'remote' : 'default'}
              confirmLabel={
                usesRemoteFolderPicker
                  ? remoteProjectSource === 'blank'
                    ? t('workbench.remote_project_blank_submit', '创建并添加')
                    : t('workbench.project_add_confirm', '添加项目')
                  : undefined
              }
              onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
              onListDeviceDirectories={onListDeviceDirectories}
              onCreateDeviceDirectory={onCreateDeviceDirectory}
              onCancel={closeDialog}
              onConfirm={async result => {
                if (usesRemoteFolderPicker) {
                  await onOpenStandaloneWorkspace?.(
                    result.deviceId,
                    result.path,
                    basename(result.path)
                  )
                  closeDialog()
                  return
                }
                setSelectedLocalDeviceId(result.deviceId)
                setSelectedLocalRoots([result.path])
              }}
            />
            {usesRemoteFolderPicker && (
              <p className="mt-4 text-sm leading-5 text-text-secondary">
                {t(
                  'workbench.remote_project_directory_note',
                  '此远程文件夹将作为单独项目显示在侧边栏中。'
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
