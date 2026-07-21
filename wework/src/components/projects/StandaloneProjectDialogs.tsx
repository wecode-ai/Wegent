import { AlertCircle, Check, Copy, Globe2, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { isImeEnterEvent } from '@/lib/ime'
import { openNativeProjectDirectoryPicker } from '@/lib/native-directory-picker'
import {
  canUseForProjectCreation,
  canUseForRemoteProjectCreation,
  isCloudDevice,
  isClaudeCodeDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import type { DeviceInfo } from '@/types/api'
import type { DockerRemoteDeviceCommandResponse, RemoteDeviceStartupCommand } from '@/types/devices'
import { DeviceFolderPicker } from './DeviceFolderPicker'
import { joinPath } from './device-folder-path'

export type StandaloneWorkspaceDialogMode = 'existing' | 'remote'
export type StandaloneRemoteDialogIntent = 'project' | 'cloud-work' | 'add-device'

function isLocalDevice(device: DeviceInfo): boolean {
  return !isCloudDevice(device) && !isRemoteDevice(device)
}

function isRemoteProjectDevice(device: DeviceInfo): boolean {
  return isCloudDevice(device) || isRemoteDevice(device)
}

function isExistingFolderDevice(device: DeviceInfo): boolean {
  return isLocalDevice(device) || isRemoteProjectDevice(device)
}

function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name || device.device_id
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
  return getRemoteDeviceNetworkLabel(device) ?? getStandaloneDeviceLabel(device)
}

function getUsableStandaloneDevices(
  devices: DeviceInfo[],
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo[] {
  const isTargetDevice = mode === 'remote' ? isRemoteProjectDevice : isExistingFolderDevice
  return devices
    .filter(device => isClaudeCodeDevice(device) && isTargetDevice(device))
    .filter(device =>
      mode === 'remote' ? canUseForRemoteProjectCreation(device) : canUseForProjectCreation(device)
    )
    .sort((left, right) => {
      if (mode === 'existing') {
        const leftLocal = isLocalDevice(left)
        const rightLocal = isLocalDevice(right)
        if (leftLocal !== rightLocal) return leftLocal ? -1 : 1
      }
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
  onClose,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenStandaloneWorkspace,
}: {
  open: boolean
  devices: DeviceInfo[]
  preferredDeviceId?: string | null
  onClose: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string
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
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
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
  devices,
  preferredDeviceId,
  onClose,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenStandaloneWorkspace,
  onGetRemoteDeviceStartupCommand,
  onRefreshDevices,
  preferNativeLocalPicker = true,
}: {
  open: boolean
  mode: StandaloneWorkspaceDialogMode
  remoteIntent?: StandaloneRemoteDialogIntent
  preferNativeLocalPicker?: boolean
  devices: DeviceInfo[]
  preferredDeviceId?: string | null
  onClose: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string
  ) => Promise<void> | void
  onGetRemoteDeviceStartupCommand?: () => Promise<DockerRemoteDeviceCommandResponse>
  onRefreshDevices?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [startupCommand, setStartupCommand] = useState<DockerRemoteDeviceCommandResponse | null>(
    null
  )
  const [startupCommandError, setStartupCommandError] = useState<string | null>(null)
  const [startupCommandCopied, setStartupCommandCopied] = useState(false)
  const [activeStartupCommandKind, setActiveStartupCommandKind] = useState<string>('docker')
  const [nativePickerError, setNativePickerError] = useState<string | null>(null)
  const [nativePickerFallback, setNativePickerFallback] = useState(false)
  const nativePickerStartedRef = useRef(false)
  const selectableDevices = useMemo(
    () => getUsableStandaloneDevices(devices, mode),
    [devices, mode]
  )
  const defaultDevice = useMemo(
    () => getPreferredStandaloneWorkspaceDevice(devices, preferredDeviceId, mode),
    [devices, mode, preferredDeviceId]
  )
  const [activeDeviceId, setActiveDeviceId] = useState(
    defaultDevice?.device_id ?? selectableDevices[0]?.device_id ?? ''
  )
  const activeDevice =
    selectableDevices.find(device => device.device_id === activeDeviceId) ??
    selectableDevices[0] ??
    null
  const addingRemoteDevice = mode === 'remote' && remoteIntent === 'add-device'
  const showStartupCommand =
    mode === 'remote' &&
    (addingRemoteDevice || !activeDevice) &&
    Boolean(onGetRemoteDeviceStartupCommand)
  const usesRemoteFolderPicker =
    mode === 'remote' ||
    (mode === 'existing' && activeDevice !== null && isRemoteProjectDevice(activeDevice))
  const closeDialog = useCallback(() => {
    nativePickerStartedRef.current = false
    setNativePickerError(null)
    setNativePickerFallback(false)
    onClose()
  }, [onClose])

  useEscapeKey(closeDialog, open)

  const title = usesRemoteFolderPicker
    ? remoteIntent === 'add-device'
      ? t('workbench.add_cloud_device_title', '添加新设备')
      : remoteIntent === 'cloud-work'
        ? t('workbench.cloud_work_title', '云端工作')
        : t('workbench.add_remote_project_title', '添加远程项目')
    : t('workbench.use_existing_folder_title', '使用现有文件夹')
  const description = usesRemoteFolderPicker
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
        : t('workbench.add_remote_project_desc', '选择已连接的远程主机，并选择此项目的文件夹。')
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
    activeDevice !== null &&
    isLocalDevice(activeDevice) &&
    preferNativeLocalPicker &&
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
          const selectedPath = await openNativeProjectDirectoryPicker()
          if (!selectedPath) {
            closeDialog()
            return
          }
          await onOpenStandaloneWorkspace?.(nativePickerDeviceId, selectedPath)
          closeDialog()
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

  if (!open) return null

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
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
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

        {usesRemoteFolderPicker && selectableDevices.length > 0 && !addingRemoteDevice && (
          <label className="mt-5 block">
            <span className="text-sm font-medium text-text-primary">
              {t('workbench.remote_host', '远程主机')}
            </span>
            <span className="mt-2 flex h-10 items-center gap-2.5 rounded-[10px] border border-border bg-background px-3">
              <Globe2 className="h-4 w-4 text-primary" />
              <select
                data-testid="standalone-remote-device-select"
                value={activeDevice?.device_id ?? ''}
                onChange={event => setActiveDeviceId(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none"
              >
                {selectableDevices.map(device => (
                  <option key={device.device_id} value={device.device_id}>
                    {getRemoteDeviceLabel(device)}
                  </option>
                ))}
              </select>
            </span>
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
        ) : (
          <div className="mt-5">
            {usesRemoteFolderPicker && (
              <h3 className="mb-2 text-sm font-medium text-text-primary">
                {t('workbench.project_directory_path', '文件夹路径')}
              </h3>
            )}
            <DeviceFolderPicker
              key={activeDevice.device_id}
              device={activeDevice}
              mode="select"
              variant={usesRemoteFolderPicker ? 'remoteDark' : 'light'}
              confirmLabel={
                usesRemoteFolderPicker ? t('workbench.project_add_confirm', '添加项目') : undefined
              }
              onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
              onListDeviceDirectories={onListDeviceDirectories}
              onCreateDeviceDirectory={onCreateDeviceDirectory}
              onCancel={closeDialog}
              onConfirm={async result => {
                await onOpenStandaloneWorkspace?.(result.deviceId, result.path)
                closeDialog()
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
