import { ChevronLeft, FolderOpen, FolderPlus, GitBranch, Globe2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotAvailable } from '@/features/dsh-runtime/useDshSlotAvailable'
import { openNativeProjectDirectoryPickers } from '@/lib/native-directory-picker'
import { cn } from '@/lib/utils'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canUseForProjectCreation,
  canUseForRemoteProjectCreation,
  isCloudDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import type { CloneGitRepositoryInput, DeviceInfo } from '@/types/api'
import { AddDevicePanel } from '@/components/devices/AddDevicePanel'
import { deviceOnboardingScope } from '@/components/devices/useDeviceOnboarding'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { DeviceFolderPicker } from './DeviceFolderPicker'
import { basename } from './device-folder-path'
import { LocalProjectCreateDialog } from './LocalProjectCreateDialog'
import { StandaloneGitProjectForm } from './StandaloneGitProjectForm'
import { useStandaloneProjectDeviceSelection } from './useStandaloneProjectDeviceSelection'
import {
  isLocalDevice,
  isRemoteProjectDevice,
  getRemoteDeviceLabel,
  getRemoteDeviceOptionLabel,
  getStandaloneDeviceOptions,
  getUsableStandaloneDevices,
} from './standaloneProjectDevices'

export { StandaloneBlankProjectDialog } from './StandaloneBlankProjectDialog'

export type StandaloneWorkspaceDialogMode = 'existing' | 'remote'
export type StandaloneRemoteDialogIntent = 'project' | 'cloud-work' | 'add-device'
export type RemoteProjectSource = 'existing' | 'blank' | 'git'

export function StandaloneFolderProjectDialog(
  props: Parameters<typeof StandaloneFolderProjectDialogContent>[0]
) {
  const connection = useOptionalCloudConnection()
  if (!props.open) return null
  return <StandaloneFolderProjectDialogContent key={deviceOnboardingScope(connection)} {...props} />
}

function StandaloneFolderProjectDialogContent({
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
  onOpenStandaloneWorkspace,
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
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string,
    projectRoots?: string[]
  ) => Promise<void> | void
  onRefreshDevices?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  const workspaceMenuExtensionsAvailable = useDshSlotAvailable(
    WEWORK_DSH_SLOTS.workspaceMenuSection
  )
  const cloudConnection = useOptionalCloudConnection()
  const deviceSelectId = useId()
  const [pendingDevice, setPendingDevice] = useState<{
    device: DeviceInfo
    catalog: DeviceInfo[]
  } | null>(null)
  const [onboardingBusy, setOnboardingBusy] = useState(false)
  const [cloudDeviceCreating, setCloudDeviceCreating] = useState(false)
  const [addingProjectDevice, setAddingProjectDevice] = useState(false)
  const [onboardingPending, setOnboardingPending] = useState(false)
  const handleOnboardingBusyChange = useCallback((busy: boolean) => {
    setOnboardingBusy(busy)
    if (busy) setAddingProjectDevice(true)
  }, [])
  // Discovery bridges the current catalog until the workbench publishes its next result.
  if (pendingDevice && pendingDevice.catalog !== devices) {
    setPendingDevice(null)
  }
  const availableDevices = useMemo(() => {
    if (!pendingDevice || pendingDevice.catalog !== devices) return devices
    return [
      ...devices.filter(device => device.device_id !== pendingDevice.device.device_id),
      pendingDevice.device,
    ]
  }, [devices, pendingDevice])
  const [nativePickerError, setNativePickerError] = useState<string | null>(null)
  const [nativePickerFallback, setNativePickerFallback] = useState(false)
  const [selectedLocalRoots, setSelectedLocalRoots] = useState<string[]>([])
  const [selectedLocalDeviceId, setSelectedLocalDeviceId] = useState('')
  const [remoteProjectSource, setRemoteProjectSource] = useState<RemoteProjectSource | null>(null)
  const [gitSubmitting, setGitSubmitting] = useState(false)
  const nativePickerStartedRef = useRef(false)
  const remoteDeviceSelectRef = useRef<HTMLSelectElement>(null)
  const remoteDeviceOptions = useMemo(
    () =>
      mode === 'remote' && !fixedDeviceId
        ? getStandaloneDeviceOptions(availableDevices, mode).sort((left, right) =>
            getRemoteDeviceLabel(left).localeCompare(getRemoteDeviceLabel(right))
          )
        : [],
    [availableDevices, fixedDeviceId, mode]
  )
  const selectableDevices = useMemo(() => {
    if (!fixedDeviceId) {
      if (mode === 'remote') return remoteDeviceOptions.filter(canUseForRemoteProjectCreation)
      return getUsableStandaloneDevices(availableDevices, mode)
    }
    const fixedDevice = availableDevices.find(device => device.device_id === fixedDeviceId)
    if (!fixedDevice) return []
    const usable = isRemoteProjectDevice(fixedDevice)
      ? canUseForRemoteProjectCreation(fixedDevice)
      : canUseForProjectCreation(fixedDevice)
    return usable ? [fixedDevice] : []
  }, [availableDevices, fixedDeviceId, mode, remoteDeviceOptions])
  const cloudDeviceOptions = remoteDeviceOptions.filter(isCloudDevice)
  const remoteDockerDeviceOptions = remoteDeviceOptions.filter(isRemoteDevice)
  const { activeDevice, setActiveDeviceId } = useStandaloneProjectDeviceSelection({
    open,
    devices: selectableDevices,
    fixedDeviceId,
    preferredDeviceId,
  })
  const addingRemoteDevice = mode === 'remote' && remoteIntent === 'add-device'
  const choosingProjectSource =
    (mode === 'remote' || chooseProjectSource) &&
    remoteIntent === 'project' &&
    remoteProjectSource === null
  const showDeviceOnboarding =
    mode === 'remote' &&
    (addingRemoteDevice ||
      addingProjectDevice ||
      (!activeDevice && remoteProjectSource !== 'git') ||
      onboardingPending)
  const usesRemoteFolderPicker =
    chooseProjectSource ||
    mode === 'remote' ||
    (mode === 'existing' && activeDevice !== null && isRemoteProjectDevice(activeDevice))
  const closeDialog = useCallback(() => {
    if (onboardingBusy) return
    nativePickerStartedRef.current = false
    setPendingDevice(null)
    setAddingProjectDevice(false)
    setOnboardingPending(false)
    setNativePickerError(null)
    setNativePickerFallback(false)
    setSelectedLocalRoots([])
    setSelectedLocalDeviceId('')
    setActiveDeviceId(null)
    setRemoteProjectSource(null)
    setGitSubmitting(false)
    onClose()
  }, [onClose, onboardingBusy, setActiveDeviceId])

  useEscapeKey(closeDialog, open && !gitSubmitting)

  const title = chooseProjectSource
    ? t('workbench.add_project_to_device_title', '添加代码项目')
    : usesRemoteFolderPicker
      ? remoteIntent === 'add-device'
        ? t('workbench.add_device_dialog_title')
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
        ? t('workbench.add_device_dialog_description')
        : showDeviceOnboarding
          ? t('workbench.remote_project_add_device_desc')
          : remoteIntent === 'cloud-work'
            ? t('workbench.cloud_work_desc')
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
    return () => window.clearTimeout(openPickerTimer)
  }, [
    closeDialog,
    nativePickerDeviceId,
    onOpenStandaloneWorkspace,
    open,
    shouldUseNativeLocalPicker,
    t,
  ])

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
              <p className="mt-2 text-sm leading-5 text-destructive">{nativePickerError}</p>
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
        if (!gitSubmitting && event.target === event.currentTarget) closeDialog()
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
          showDeviceOnboarding
            ? 'max-w-[800px] rounded-[20px] p-5'
            : usesRemoteFolderPicker
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
            disabled={gitSubmitting || onboardingBusy}
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
        {usesRemoteFolderPicker &&
          remoteDeviceOptions.length > 0 &&
          !addingRemoteDevice &&
          !addingProjectDevice &&
          !onboardingPending && (
            <div className="mt-5 block">
              <span className="flex items-center justify-between gap-3 text-sm font-medium text-text-primary">
                <label htmlFor={deviceSelectId}>{t('workbench.remote_host', '远程主机')}</label>
                <button
                  type="button"
                  data-testid="remote-project-add-device"
                  disabled={gitSubmitting}
                  onClick={() => setAddingProjectDevice(true)}
                  className="h-8 rounded-md px-2 text-sm text-text-secondary hover:bg-muted"
                >
                  {t('workbench.add_device_dialog_title')}
                </button>
              </span>
              <span className="mt-2 flex h-10 items-center gap-2.5 rounded-[10px] border border-border bg-background px-3">
                <Globe2 className="h-4 w-4 text-primary" />
                <select
                  id={deviceSelectId}
                  ref={remoteDeviceSelectRef}
                  disabled={gitSubmitting}
                  data-testid="standalone-remote-device-select"
                  value={activeDevice?.device_id ?? ''}
                  onChange={event => setActiveDeviceId(event.target.value)}
                  className="wework-native-select min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none"
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
            </div>
          )}
        {remoteProjectSource === 'git' && !addingRemoteDevice && (
          <div className="mt-5" hidden={showDeviceOnboarding}>
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
            <StandaloneGitProjectForm
              device={activeDevice}
              onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
              onListDeviceDirectories={onListDeviceDirectories}
              onCreateDeviceDirectory={onCreateDeviceDirectory}
              onCloneGitRepository={onCloneGitRepository}
              onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
              onRefreshDevices={onRefreshDevices}
              onReselectDevice={async () => {
                await onRefreshDevices?.()
                remoteDeviceSelectRef.current?.focus()
              }}
              onSubmittingChange={setGitSubmitting}
              onClose={closeDialog}
            />
          </div>
        )}
        {showDeviceOnboarding || (!activeDevice && remoteProjectSource !== 'git') ? (
          showDeviceOnboarding ? (
            <div data-testid="standalone-folder-no-device" className="mt-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{t('workbench.add_device_dialog_title')}</h3>
                {activeDevice && !addingRemoteDevice && (
                  <button
                    type="button"
                    data-testid="remote-project-cancel-add-device"
                    disabled={onboardingBusy}
                    onClick={() => {
                      setAddingProjectDevice(false)
                      setOnboardingPending(false)
                    }}
                    className="h-8 rounded-md px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-50"
                  >
                    {t('workbench.back_to_project')}
                  </button>
                )}
              </div>
              <AddDevicePanel
                cloudConnection={cloudConnection}
                hasCloudDevice={cloudDeviceCreating || availableDevices.some(isCloudDevice)}
                onCreatingChange={setCloudDeviceCreating}
                onBusyChange={handleOnboardingBusyChange}
                onPendingChange={setOnboardingPending}
                onConnected={async (_, device) => {
                  setAddingProjectDevice(false)
                  setOnboardingPending(false)
                  const listedDevice = devices.find(item => item.device_id === device.device_id)
                  setPendingDevice(
                    listedDevice && canUseForRemoteProjectCreation(listedDevice)
                      ? null
                      : { device, catalog: devices }
                  )
                  setActiveDeviceId(device.device_id)
                  if (addingRemoteDevice) closeDialog()
                  await onRefreshDevices?.()
                }}
              />
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
                    if (activeDevice) setActiveDeviceId(activeDevice.device_id)
                    setRemoteProjectSource(option.source)
                  }}
                  className="flex w-full items-start gap-3 rounded-xl border border-border bg-background p-3 text-left hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/30"
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
        ) : remoteProjectSource === 'git' ? null : activeDevice ? (
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
        ) : null}
      </div>
    </div>,
    document.body
  )
}
