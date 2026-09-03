import {
  AlertCircle,
  ArrowLeft,
  Check,
  Cloud,
  Code2,
  Copy,
  Info,
  Loader2,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Server,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cloudDesktopExtension } from '@extensions/cloud-desktop'
import { stripAppBasePath } from '@/config/runtime'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsPage, SettingsPageHeader, SettingsRow, SettingsSwitch } from './settings-ui'
import { openExternalUrl } from '@/lib/external-links'
import { isImeEnterEvent } from '@/lib/ime'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { RemoteTerminal } from '@/components/layout/workspace-panels/RemoteTerminal'
import { useResizableSidebar } from '@/components/layout/useResizableSidebar'
import {
  isClaudeCodeDevice,
  isCloudDevice,
  isRemoteDevice,
  supportsCloudLifecycleActions,
  supportsCloudSessions,
  supportsDeviceMetrics,
  supportsRemoteSessions,
} from '@/lib/device-capabilities'
import type { DeviceInfo as RuntimeDeviceInfo, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { CloudDeviceMetricsResponse, DeviceInfo, DeviceSessionResponse } from '@/types/devices'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { AddCloudDeviceDialog } from './AddCloudDeviceDialog'
import { DeviceGitSyncSection } from './DeviceGitSyncSection'
import { DeviceActionButton } from './DeviceActionButton'
import {
  createSettingsDeviceApi,
  createSettingsModelApi,
  createSettingsRemoteTerminalClientFactory,
  type CloudSettingsConnection,
} from './settings-cloud-api'
import {
  resolveDshSettingsPath,
  type WeworkDshSettingsPage,
} from '@/features/dsh-runtime/dshSettings'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import { resolveDshSettingsIcon } from '@/features/dsh-runtime/dshSettingsIcons'
import { DshSettingsSurface } from '@/features/dsh-runtime/DshSettingsSurface'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

const CloudDesktopDeviceAction = cloudDesktopExtension.DeviceAction
const keepConnectionsSettingsOpen = () => undefined

interface ConnectionsSettingsPageProps {
  onBack: () => void
  autoOpenAddCloudDeviceDialog?: boolean
  services?: WorkbenchServices
  devices?: RuntimeDeviceInfo[]
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: RefreshWorkLists
}

function getSettingsNavFromPath(
  path: string,
  contributions: readonly WeworkDshSettingsPage[]
): string {
  const normalizedPath = stripAppBasePath(path)
  return resolveDshSettingsPath(normalizedPath, contributions)?.id ?? 'general'
}

function StatusPill({ status }: { status: DeviceInfo['status'] }) {
  const isOnline = status === 'online'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${
        isOnline ? 'bg-primary/10 text-primary' : 'bg-muted text-text-muted'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-primary' : 'bg-text-muted'}`}
        aria-hidden="true"
      />
      {isOnline ? '在线' : '离线'}
    </span>
  )
}

function DeviceIconActionButton({
  testId,
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  testId: string
  icon: ComponentType<{ className?: string }>
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function cloudHostLabel(value?: string | null): string {
  if (!value) return '-'
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

function modelLabel(model: UnifiedModel): string {
  return model.displayName || model.name
}

function modelMeta(model: UnifiedModel): string {
  return [model.provider, model.runtime?.family, model.type].filter(Boolean).join(' · ')
}

function deviceDisplayName(device: DeviceInfo): string {
  const name = device.name?.trim()
  const defaultNames = [
    device.device_id,
    device.cloud_config?.deviceName,
    device.remote_config?.deviceName,
  ]
    .map(value => value?.trim())
    .filter(Boolean)

  if (name && !defaultNames.includes(name)) return name
  return device.client_ip?.trim() || name || device.device_id
}

type ConfirmDeviceAction = 'restart' | 'delete'

function ConfirmDeviceActionDialog({
  device,
  action,
  loading,
  onCancel,
  onConfirm,
}: {
  device: DeviceInfo
  action: ConfirmDeviceAction
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const isDelete = action === 'delete'
  const isCloud = isCloudDevice(device)
  const isRemote = isRemoteDevice(device)
  const displayName = deviceDisplayName(device)
  const Icon = isDelete ? Trash2 : RotateCcw
  const title = isDelete
    ? isCloud
      ? '删除云设备'
      : isRemote
        ? '删除远程设备'
        : '删除本地设备'
    : '重启云设备'
  const description = isDelete
    ? isCloud
      ? `将删除 ${displayName}，相关云设备资源会被释放。`
      : isRemote
        ? `将删除 ${displayName} 的远程设备注册记录。Docker 容器需要你自行停止或删除。`
        : `将删除 ${displayName} 的设备注册记录。`
    : `将重启 ${displayName}，设备会短暂离线，进行中的连接可能中断。`
  const confirmLabel = isDelete ? '确认删除' : '确认重启'
  const dialogTestId = isDelete ? 'confirm-delete-device-dialog' : 'confirm-restart-device-dialog'
  const confirmTestId = isDelete ? 'confirm-delete-device-button' : 'confirm-restart-device-button'
  const iconClassName = isDelete ? 'bg-red-500/10 text-red-500' : 'bg-muted text-text-secondary'
  const confirmClassName = isDelete
    ? 'bg-red-600 text-white hover:bg-red-700'
    : 'bg-text-primary text-background hover:opacity-90'

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35"
      onClick={e => {
        if (!loading && e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        data-testid={dialogTestId}
        className="w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${iconClassName}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">{description}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="cancel-delete-device-button"
            onClick={onCancel}
            disabled={loading}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${confirmClassName}`}
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const CLOUD_DEVICE_USERNAME = 'ubuntu'
const CLOUD_DEVICE_DEFAULT_PASSWORD = 'ubuntu'

interface CloudDeviceConnectionInfo {
  sandboxId: string
  deviceId: string
  username: string
  password: string
}

function getCloudDeviceConnectionInfo(device: DeviceInfo): CloudDeviceConnectionInfo {
  const cloudConfig = device.cloud_config || {}
  return {
    sandboxId: cloudConfig.sandboxId || '-',
    deviceId: cloudConfig.deviceId || device.device_id || '-',
    username: CLOUD_DEVICE_USERNAME,
    password:
      cloudConfig.ubuntuInitialPassword ||
      cloudConfig.ubuntuPassword ||
      CLOUD_DEVICE_DEFAULT_PASSWORD,
  }
}

function formatCloudDeviceConnectionInfo(info: CloudDeviceConnectionInfo): string {
  return [
    `Sandbox ID: ${info.sandboxId}`,
    `Device ID: ${info.deviceId}`,
    `Username: ${info.username}`,
    `Password: ${info.password}`,
  ].join('\n')
}

function CloudDeviceConnectionInfoDialog({
  device,
  onClose,
}: {
  device: DeviceInfo
  onClose: () => void
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const info = getCloudDeviceConnectionInfo(device)

  const copyValue = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value)
    setCopiedKey(key)
  }

  const rows = [
    { key: 'sandbox-id', label: 'Sandbox ID', value: info.sandboxId },
    { key: 'device-id', label: 'Device ID', value: info.deviceId },
    { key: 'username', label: '用户名', value: info.username },
    { key: 'password', label: '密码', value: info.password },
  ]

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        data-testid="connection-info-dialog"
        className="w-[460px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-text-secondary">
            <Info className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">连接信息</h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              用于连接云设备的初始化信息。用户名固定为 ubuntu。
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {rows.map(row => (
            <div
              key={row.key}
              className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="w-20 shrink-0 text-xs text-text-secondary">{row.label}</div>
              <div className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
                {row.value}
              </div>
              <button
                type="button"
                data-testid={`copy-connection-info-${row.key}`}
                onClick={() => copyValue(row.key, row.value)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{copiedKey === row.key ? '已复制' : '复制'}</span>
              </button>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            关闭
          </button>
          <button
            type="button"
            data-testid="copy-connection-info-all"
            onClick={() => copyValue('all', formatCloudDeviceConnectionInfo(info))}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
          >
            <Copy className="h-3.5 w-3.5" />
            {copiedKey === 'all' ? '已复制' : '复制全部'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeviceCard({ device, onChanged }: { device: DeviceInfo; onChanged: () => void }) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const remoteTerminalClientFactory = useMemo(
    () =>
      cloudConnection.isConnected &&
      cloudConnection.socketBaseUrl &&
      cloudConnection.socketPath &&
      cloudConnection.token
        ? createSettingsRemoteTerminalClientFactory(cloudConnection)
        : null,
    [cloudConnection]
  )
  const [sessionLoading, setSessionLoading] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(device.name)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmDeviceAction | null>(null)
  const [connectionInfoOpen, setConnectionInfoOpen] = useState(false)
  const [terminalSession, setTerminalSession] = useState<DeviceSessionResponse | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [pendingIdeUrl, setPendingIdeUrl] = useState<string | null>(null)
  const [metricsState, setMetricsState] = useState<{
    deviceId: string
    value: CloudDeviceMetricsResponse | null
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const actionMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!supportsDeviceMetrics(device) || device.status === 'offline') {
      return
    }

    let cancelled = false
    const loadMetrics = async () => {
      try {
        const nextMetrics = await createSettingsDeviceApi(cloudConnection).getMetrics(
          device.device_id
        )
        if (!cancelled) {
          setMetricsState({ deviceId: device.device_id, value: nextMetrics })
        }
      } catch (error) {
        console.error('Failed to load device metrics:', error)
        if (!cancelled) {
          setMetricsState({ deviceId: device.device_id, value: null })
        }
      }
    }

    void loadMetrics()
    const timer = window.setInterval(loadMetrics, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [cloudConnection, device])

  const handleStartTerminal = useCallback(async () => {
    if (device.status !== 'online') return
    setSessionLoading('terminal')
    setSessionError(null)
    try {
      const result = await createSettingsDeviceApi(cloudConnection).startTerminal(device.device_id)
      if (result.url) {
        await openExternalUrl(result.url)
        return
      }
      if (!remoteTerminalClientFactory) {
        throw new Error('Cloud terminal connection is unavailable')
      }
      setTerminalSession(result)
    } catch (e) {
      console.error('Failed to start terminal:', e)
      setSessionError(
        e instanceof Error ? e.message : t('workbench.connection_session_start_failed')
      )
    } finally {
      setSessionLoading(null)
    }
  }, [cloudConnection, device, remoteTerminalClientFactory, t])

  const handleStartCloudSession = useCallback(
    async (type: 'terminal' | 'code-server') => {
      if (device.status !== 'online') return
      setSessionLoading(type)
      setSessionError(null)
      try {
        const deviceApi = createSettingsDeviceApi(cloudConnection)
        const result =
          type === 'terminal'
            ? await deviceApi.startTerminal(device.device_id)
            : await deviceApi.startCodeServer(device.device_id)
        if (result.url) {
          if (type === 'code-server') {
            setPendingIdeUrl(result.url)
            return
          }
          await openExternalUrl(result.url)
        }
      } catch (e) {
        console.error(`Failed to start ${type}:`, e)
        setSessionError(
          e instanceof Error ? e.message : t('workbench.connection_session_start_failed')
        )
      } finally {
        setSessionLoading(null)
      }
    },
    [cloudConnection, device.device_id, device.status, t]
  )

  const handleOpenPendingIde = useCallback(async () => {
    if (!pendingIdeUrl) return
    setSessionError(null)
    try {
      await openExternalUrl(pendingIdeUrl)
      setPendingIdeUrl(null)
    } catch (e) {
      setSessionError(
        e instanceof Error ? e.message : t('workbench.connection_session_start_failed')
      )
    }
  }, [pendingIdeUrl, t])

  let pendingIdeTarget = pendingIdeUrl
  if (pendingIdeUrl) {
    try {
      pendingIdeTarget = new URL(pendingIdeUrl).origin
    } catch {
      // Keep the complete value visible if the Backend returned an invalid URL.
    }
  }

  const handleStartEdit = () => {
    setEditName(device.name)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const handleCancelEdit = () => {
    setEditing(false)
    setEditName(device.name)
  }

  const handleSaveEdit = async () => {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === device.name) {
      handleCancelEdit()
      return
    }
    setSaving(true)
    try {
      await createSettingsDeviceApi(cloudConnection).renameDevice(device.device_id, trimmed)
      setEditing(false)
      onChanged()
    } catch (e) {
      console.error('Failed to rename device:', e)
    } finally {
      setSaving(false)
    }
  }

  const handleRestartDevice = async () => {
    setRestarting(true)
    try {
      await createSettingsDeviceApi(cloudConnection).restartCloudDevice(device.device_id)
      setConfirmAction(null)
      onChanged()
    } catch (e) {
      console.error('Failed to restart cloud device:', e)
    } finally {
      setRestarting(false)
    }
  }

  const handleDeleteDevice = async () => {
    setDeleting(true)
    try {
      const deviceApi = createSettingsDeviceApi(cloudConnection)
      if (isCloudDevice(device)) {
        await deviceApi.deleteCloudDevice(device.device_id)
      } else {
        await deviceApi.deleteDevice(device.device_id)
      }
      setConfirmAction(null)
      onChanged()
    } catch (e) {
      console.error('Failed to delete cloud device:', e)
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    if (!actionMenuOpen) return

    const closeActionMenu = (event: MouseEvent) => {
      if (!actionMenuRef.current?.contains(event.target as Node)) {
        setActionMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', closeActionMenu)
    return () => document.removeEventListener('mousedown', closeActionMenu)
  }, [actionMenuOpen])

  const openConfirmAction = (action: ConfirmDeviceAction) => {
    setActionMenuOpen(false)
    setConfirmAction(action)
  }

  const openConnectionInfo = () => {
    setActionMenuOpen(false)
    setConnectionInfoOpen(true)
  }

  const isOnline = device.status === 'online'
  const metrics =
    device.status !== 'offline' && metricsState?.deviceId === device.device_id
      ? metricsState.value
      : null
  const isRemote = isRemoteDevice(device)
  const displayName = deviceDisplayName(device)
  const canUseCloudSessions = supportsCloudSessions(device)
  const canUseRemoteSessions = supportsRemoteSessions(device)
  const canUseDeviceSessions = canUseCloudSessions || canUseRemoteSessions
  const canUseCloudLifecycleActions = supportsCloudLifecycleActions(device)
  const canDeleteOfflineRemoteDevice = isRemote && device.status === 'offline'

  return (
    <>
      <div
        data-testid={`connection-device-${device.device_id}`}
        className="rounded-lg border border-border bg-background p-3"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            {editing ? (
              <div className="flex items-center gap-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => {
                    if (isImeEnterEvent(e)) return
                    if (e.key === 'Enter') handleSaveEdit()
                    if (e.key === 'Escape') handleCancelEdit()
                  }}
                  disabled={saving}
                  className="h-6 w-48 rounded border border-primary bg-background px-1.5 text-sm text-text-primary outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="rounded p-0.5 text-primary hover:bg-primary/10"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="rounded p-0.5 text-text-muted hover:bg-muted hover:text-text-primary"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="group flex items-center gap-1.5">
                <h3
                  className="cursor-pointer truncate text-sm font-semibold text-text-primary"
                  onClick={handleStartEdit}
                  title="点击修改名称"
                >
                  {displayName}
                </h3>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="rounded p-0.5 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-secondary"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
              {device.executor_version ? `v${device.executor_version}` : '-'}
            </span>
            <StatusPill status={device.status} />
          </div>

          <div className="flex shrink-0 gap-2">
            {canUseDeviceSessions && (
              <DeviceActionButton
                testId={`connection-terminal-button-${device.device_id}`}
                icon={Terminal}
                label="终端"
                onClick={handleStartTerminal}
                disabled={!isOnline || sessionLoading === 'terminal'}
              />
            )}
            {canUseDeviceSessions && (
              <>
                <DeviceActionButton
                  testId={`connection-code-server-button-${device.device_id}`}
                  icon={Code2}
                  label="IDE"
                  onClick={() => handleStartCloudSession('code-server')}
                  disabled={!isOnline || sessionLoading === 'code-server'}
                />
                {canUseCloudSessions && cloudDesktopExtension.available && (
                  <CloudDesktopDeviceAction
                    deviceId={device.device_id}
                    disabled={!isOnline}
                    onOpened={keepConnectionsSettingsOpen}
                  />
                )}
              </>
            )}
            {canUseCloudLifecycleActions && (
              <div ref={actionMenuRef} className="relative">
                <DeviceIconActionButton
                  testId={`connection-more-button-${device.device_id}`}
                  icon={MoreHorizontal}
                  label="更多操作"
                  onClick={() => setActionMenuOpen(open => !open)}
                  disabled={restarting || deleting}
                />
                {actionMenuOpen && (
                  <div
                    data-testid={`connection-more-menu-${device.device_id}`}
                    className="absolute right-0 top-9 z-20 w-36 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-[0_8px_24px_rgba(0,0,0,0.22)]"
                  >
                    <button
                      type="button"
                      data-testid={`connection-info-menu-item-${device.device_id}`}
                      onClick={openConnectionInfo}
                      className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-text-primary hover:bg-muted"
                    >
                      <Info className="h-3.5 w-3.5" />
                      <span>连接信息</span>
                    </button>
                    <button
                      type="button"
                      data-testid={`connection-restart-menu-item-${device.device_id}`}
                      onClick={() => openConfirmAction('restart')}
                      className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-text-primary hover:bg-muted"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>重启设备</span>
                    </button>
                    <button
                      type="button"
                      data-testid={`connection-delete-menu-item-${device.device_id}`}
                      onClick={() => openConfirmAction('delete')}
                      className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-red-500 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>删除设备</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {canDeleteOfflineRemoteDevice && (
              <DeviceIconActionButton
                testId={`connection-delete-button-${device.device_id}`}
                icon={Trash2}
                label="删除设备"
                onClick={() => setConfirmAction('delete')}
                disabled={deleting}
              />
            )}
          </div>
        </div>
        {sessionError && (
          <div
            data-testid={`connection-session-error-${device.device_id}`}
            className="mt-3 flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{sessionError}</span>
          </div>
        )}
        {pendingIdeUrl && (
          <div
            data-testid={`connection-ide-target-${device.device_id}`}
            className="mt-3 flex items-center justify-between gap-3 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-text-secondary"
          >
            <span className="min-w-0">
              {t('workbench.connection_ide_target')}: <strong>{pendingIdeTarget}</strong>
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                data-testid={`connection-ide-cancel-${device.device_id}`}
                onClick={() => setPendingIdeUrl(null)}
                className="rounded px-2 py-1 hover:bg-muted"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid={`connection-ide-confirm-${device.device_id}`}
                onClick={() => void handleOpenPendingIde()}
                className="rounded bg-text-primary px-2 py-1 text-background"
              >
                {t('workbench.connection_ide_open')}
              </button>
            </div>
          </div>
        )}
        {supportsDeviceMetrics(device) && (
          <div
            data-testid={`connection-device-metrics-${device.device_id}`}
            className="mt-3 grid grid-cols-3 gap-3 border-t border-border pt-3"
          >
            {[
              { key: 'cpu', label: 'CPU', value: metrics?.cpu_usage },
              { key: 'memory', label: '内存', value: metrics?.memory_usage },
              { key: 'disk', label: '磁盘', value: metrics?.disk_usage },
            ].map(metric => {
              const value =
                typeof metric.value === 'number'
                  ? Math.min(100, Math.max(0, Math.round(metric.value)))
                  : null
              return (
                <div key={metric.key} className="min-w-0">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-text-secondary">{metric.label}</span>
                    <span
                      data-testid={`connection-device-metric-${metric.key}-${device.device_id}`}
                      className="tabular-nums text-text-primary"
                    >
                      {value === null ? '-' : `${value}%`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-text-secondary transition-[width]"
                      style={{ width: `${value ?? 0}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {terminalSession && remoteTerminalClientFactory && (
        <section
          data-testid="settings-device-terminal-panel"
          className="mt-3 flex h-[360px] min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background"
        >
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <div className="flex min-w-0 items-center gap-2">
              <Terminal className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="truncate text-sm font-medium text-text-primary">{displayName}</span>
              {terminalSession.path && (
                <span className="truncate text-xs text-text-muted">{terminalSession.path}</span>
              )}
            </div>
            <button
              type="button"
              data-testid="settings-device-terminal-close-button"
              onClick={() => setTerminalSession(null)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label="关闭终端"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <RemoteTerminal
              sessionId={terminalSession.session_id}
              clientFactory={remoteTerminalClientFactory}
              active
            />
          </div>
        </section>
      )}

      {confirmAction && (
        <ConfirmDeviceActionDialog
          device={device}
          action={confirmAction}
          loading={confirmAction === 'delete' ? deleting : restarting}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirmAction === 'delete' ? handleDeleteDevice : handleRestartDevice}
        />
      )}
      {connectionInfoOpen && (
        <CloudDeviceConnectionInfoDialog
          device={device}
          onClose={() => setConnectionInfoOpen(false)}
        />
      )}
    </>
  )
}

export function DeviceSection({
  title,
  devices,
  onChanged,
  icon: Icon,
}: {
  title: string
  devices: DeviceInfo[]
  onChanged: () => void
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-secondary">
          <Icon className="h-3.5 w-3.5" />
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="text-xs text-text-muted">({devices.length})</span>
        </div>
      </div>
      <div className="space-y-3">
        {devices.map(device => (
          <DeviceCard key={device.device_id} device={device} onChanged={onChanged} />
        ))}
      </div>
    </section>
  )
}

function CloudModelsSection({ cloudConnection }: { cloudConnection: CloudSettingsConnection }) {
  const { t } = useTranslation('common')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cloudConnection.isConnected) {
      return undefined
    }

    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return null
        setLoading(true)
        setError(null)
        return createSettingsModelApi(cloudConnection).listModels()
      })
      .then(response => {
        if (!cancelled && response) setModels(response.data)
      })
      .catch(loadError => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load cloud models')
          setModels([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [cloudConnection])

  return (
    <section
      data-testid="cloud-models-section"
      className="rounded-lg border border-border bg-background p-5"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.cloud_models_title', '云端模型')}
          </h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(
              'workbench.cloud_models_desc',
              '服务端模型会和本机 Codex 模型一起出现在工作台模型选择器里。'
            )}
          </p>
        </div>
        {!loading && (
          <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-text-secondary">
            {models.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="py-6 text-sm text-text-secondary">
          {t('workbench.cloud_models_loading', '正在加载云端模型...')}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {t('workbench.cloud_models_error', '云端模型加载失败')}
        </div>
      ) : models.length === 0 ? (
        <div className="py-6 text-sm text-text-secondary">
          {t('workbench.cloud_models_empty', '暂无云端模型')}
        </div>
      ) : (
        <div className="grid gap-2">
          {models.slice(0, 8).map(model => (
            <div
              key={`${model.type}:${model.name}:${model.namespace ?? ''}`}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <Code2 className="h-4 w-4 shrink-0 text-text-secondary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">
                  {modelLabel(model)}
                </div>
                <div className="truncate text-xs text-text-secondary">
                  {modelMeta(model) || model.name}
                </div>
              </div>
              {model.isActive === false && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                  {t('workbench.plugin_detail_disabled', '已停用')}
                </span>
              )}
            </div>
          ))}
          {models.length > 8 && (
            <div className="px-1 pt-1 text-xs text-text-secondary">
              {t('workbench.cloud_models_more', {
                defaultValue: '还有 {{count}} 个模型',
                count: models.length - 8,
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function RemoteControlSetting({ cloudConnected }: { cloudConnected: boolean }) {
  const { t } = useTranslation('common')
  const appPreferences = useAppPreferencesState()
  const preferencesLoaded = appPreferences?.loaded ?? false
  const enabled = appPreferences?.preferences.remoteControlEnabled ?? false
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleChange = async (nextEnabled: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await updateAppPreferences({ remoteControlEnabled: nextEnabled })
    } catch (saveError) {
      console.error('[Wework] Failed to update remote control preference', saveError)
      setError(t('workbench.remote_control_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const description = cloudConnected
    ? t('workbench.remote_control_description')
    : t('workbench.remote_control_requires_cloud')

  return (
    <section
      data-testid="remote-control-setting"
      className="mt-4 overflow-hidden rounded-lg border border-border bg-background"
    >
      <SettingsRow
        label={t('workbench.remote_control_title')}
        description={description}
        control={
          <SettingsSwitch
            data-testid="remote-control-toggle"
            aria-label={t('workbench.remote_control_title')}
            checked={enabled}
            disabled={!preferencesLoaded || !cloudConnected || saving}
            onCheckedChange={nextEnabled => void handleChange(nextEnabled)}
          />
        }
      />
      {error ? (
        <p className="border-t border-border px-4 py-2 text-xs text-red-500" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export function ConnectionsDeviceSettingsPage({
  autoOpenAddCloudDeviceDialog = false,
  showHeader = true,
}: {
  autoOpenAddCloudDeviceDialog?: boolean
  showHeader?: boolean
}) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(autoOpenAddCloudDeviceDialog)
  const [creating, setCreating] = useState(false)

  const applyDevices = useCallback((allDevices: DeviceInfo[]) => {
    const claudeCodeDevices = allDevices.filter(isClaudeCodeDevice)
    setDevices(claudeCodeDevices)
    if (claudeCodeDevices.some(isCloudDevice)) {
      setCreating(false)
    }
  }, [])

  const fetchDevices = useCallback(async () => {
    if (!cloudConnection.isConnected) {
      setDevices([])
      setLoading(false)
      return
    }
    try {
      const allDevices = await createSettingsDeviceApi(cloudConnection).getAllDevices()
      applyDevices(allDevices)
    } catch (e) {
      console.error('Failed to fetch devices:', e)
    } finally {
      setLoading(false)
    }
  }, [applyDevices, cloudConnection])

  const handleDeviceCreated = useCallback(
    (discoveredDevices?: DeviceInfo[]) => {
      if (discoveredDevices) {
        applyDevices(discoveredDevices)
        setLoading(false)
        return
      }
      return fetchDevices()
    },
    [applyDevices, fetchDevices]
  )

  const cloudDevices = devices.filter(isCloudDevice)
  const remoteDevices = devices.filter(isRemoteDevice)
  const connectionDevices = [...cloudDevices, ...remoteDevices]
  const onlineCloudDeviceCount = cloudDevices.filter(device => device.status === 'online').length

  useEffect(() => {
    void Promise.resolve().then(fetchDevices)
  }, [fetchDevices])

  if (!cloudConnection.isConnected) {
    return (
      <>
        <SettingsPage>
          {showHeader ? (
            <SettingsPageHeader title={t('workbench.connections_title', '云端连接')} />
          ) : null}

          <section className="rounded-lg border border-border bg-background p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.cloud_connection_local_mode', '本地模式')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-text-secondary">
                  {t(
                    'workbench.cloud_connection_local_mode_desc',
                    '默认功能不依赖服务端：本机 Codex、本地任务服务、本地工作区和会话都会继续可用。'
                  )}
                </p>
              </div>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {t('workbench.cloud_connection_available', '可用')}
              </span>
            </div>
          </section>

          <section className="mt-4 rounded-lg border border-dashed border-border bg-background p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.cloud_connection_cloud_features', '连接云端后')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-text-secondary">
                  {t(
                    'workbench.cloud_connection_cloud_features_desc',
                    '服务端模型、云设备、云端 Codex auth.json 同步、代理和远程设备管理会加入现有工作台。'
                  )}
                </p>
              </div>
              <button
                type="button"
                data-testid="settings-cloud-connect-button"
                onClick={() => setConnectDialogOpen(true)}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90"
              >
                {t('workbench.cloud_connection_connect_action', '连接云端')}
              </button>
            </div>
          </section>

          <RemoteControlSetting cloudConnected={false} />
        </SettingsPage>

        {connectDialogOpen && (
          <CloudConnectionDialog
            open
            onlineCloudDeviceCount={0}
            onClose={() => setConnectDialogOpen(false)}
            onOpenSettings={() => undefined}
          />
        )}
      </>
    )
  }

  return (
    <>
      <SettingsPage>
        {showHeader ? (
          <SettingsPageHeader title={t('workbench.connections_title', '云端连接')} />
        ) : null}

        <section
          data-testid="cloud-connection-status-card"
          className="rounded-lg border border-border bg-background p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-primary" />
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.cloud_connection_status_connected', '已连接云端')}
                </h2>
              </div>
              <div className="mt-3 grid gap-2 text-sm text-text-secondary">
                <div>
                  {t('workbench.cloud_connection_host', '当前域名')}:{' '}
                  <span className="font-medium text-text-primary">
                    {cloudHostLabel(cloudConnection.backendUrl)}
                  </span>
                </div>
                <div>
                  {t('workbench.cloud_connection_user', '云端用户')}:{' '}
                  <span className="font-medium text-text-primary">
                    {cloudConnection.user?.user_name ?? '-'}
                  </span>
                </div>
                <div>
                  {t('workbench.cloud_connection_online_devices', '在线云设备')}:{' '}
                  <span className="font-medium text-text-primary">{onlineCloudDeviceCount}</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              data-testid="settings-cloud-disconnect-button"
              onClick={() => {
                cloudConnection.disconnect()
                setDevices([])
              }}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
            >
              <LogOut className="h-4 w-4" />
              {t('workbench.cloud_connection_disconnect', '断开连接')}
            </button>
          </div>
        </section>

        <RemoteControlSetting cloudConnected />

        <section className="mt-6 space-y-5">
          <CloudModelsSection cloudConnection={cloudConnection} />

          <div className="rounded-lg border border-border bg-background p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                {t('workbench.connections_authorized_devices', '云端设备')}
              </h2>
              {!loading && (
                <button
                  type="button"
                  data-testid="connection-add-device-button"
                  onClick={() => setAddDialogOpen(true)}
                  disabled={creating}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {t('workbench.connection_add', '添加')}
                </button>
              )}
            </div>

            <div className="space-y-5">
              {creating && (
                <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-xs text-text-secondary">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-text-secondary" />
                  云设备创建中，初始化约需 2-3 分钟，完成后将自动出现在列表中
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-sm text-text-secondary">
                  {t('common.loading', '加载中...')}
                </div>
              ) : connectionDevices.length === 0 ? (
                <div className="py-8 text-center text-sm text-text-secondary">
                  {t('workbench.connection_empty_devices')}
                </div>
              ) : (
                <>
                  {cloudDevices.length > 0 && (
                    <DeviceSection
                      title={t('workbench.connection_cloud_devices', '云设备')}
                      devices={cloudDevices}
                      icon={Cloud}
                      onChanged={fetchDevices}
                    />
                  )}
                  {remoteDevices.length > 0 && (
                    <DeviceSection
                      title={t('workbench.connection_remote_devices', '远程设备')}
                      devices={remoteDevices}
                      icon={Server}
                      onChanged={fetchDevices}
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <DeviceGitSyncSection
            devices={devices}
            devicesLoading={loading}
            onRefreshDevices={fetchDevices}
          />
        </section>
      </SettingsPage>

      <AddCloudDeviceDialog
        open={addDialogOpen}
        hasCloudDevice={cloudDevices.length > 0 || creating}
        cloudConnection={cloudConnection}
        onClose={() => setAddDialogOpen(false)}
        onCreated={handleDeviceCreated}
        onCreatingChange={setCreating}
      />
    </>
  )
}

export function ConnectionsSettingsPage({
  onBack,
  autoOpenAddCloudDeviceDialog = false,
  services,
  devices = [],
  onOpenRuntimeTask,
  onRefreshWorkLists,
}: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const isDesktopRuntime = isElectronRuntime()
  const settingsContributions = useDshSlotEntries<WeworkDshSettingsPage>(
    WEWORK_DSH_SLOTS.settingsPage
  )
  const visibleSettingsNavItems = useMemo(() => {
    const visible = settingsContributions.filter(
      item =>
        (!item.experimental || experimentalFeaturesEnabled) &&
        (!item.desktopOnly || isDesktopRuntime)
    )
    const categoryOrder: string[] = []
    const categoryItems = new Map<string, WeworkDshSettingsPage[]>()
    for (const item of visible) {
      const category = item.category ?? ''
      if (!categoryItems.has(category)) {
        categoryOrder.push(category)
        categoryItems.set(category, [])
      }
      categoryItems.get(category)?.push(item)
    }
    return categoryOrder.flatMap(category => categoryItems.get(category) ?? [])
  }, [experimentalFeaturesEnabled, isDesktopRuntime, settingsContributions])
  const shouldAutoOpenAddCloudDeviceDialog =
    autoOpenAddCloudDeviceDialog ||
    new URLSearchParams(window.location.search).get('addDevice') === '1'
  const [activeNav, setActiveNav] = useState(() =>
    getSettingsNavFromPath(window.location.pathname, settingsContributions)
  )
  const effectiveActiveNav = visibleSettingsNavItems.some(item => item.id === activeNav)
    ? activeNav
    : (visibleSettingsNavItems.find(item => item.id === 'general')?.id ??
      visibleSettingsNavItems[0]?.id ??
      'general')

  useEffect(() => {
    const handlePopState = () => {
      setActiveNav(getSettingsNavFromPath(window.location.pathname, settingsContributions))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [settingsContributions])

  const openCloudSettings = useCallback(() => {
    setActiveNav('connections')
    const path = settingsContributions.find(item => item.id === 'connections')?.path
    navigateTo(path ?? '/settings/connections')
  }, [settingsContributions])
  const activeContribution =
    settingsContributions.find(item => item.id === effectiveActiveNav) ??
    settingsContributions.find(item => item.id === 'general')

  return (
    <div
      data-testid="wework-settings-page"
      className={cn(
        'relative flex h-full min-w-0 flex-1 overflow-hidden text-text-primary',
        background.imagePath && (background.inMain || background.inSidebar || background.inTopBar)
          ? 'bg-transparent'
          : 'bg-background'
      )}
    >
      <aside
        className={cn(
          'relative flex shrink-0 flex-col border-r border-border/70 px-1.5 pb-4 shadow-[inset_-1px_0_0_rgb(var(--color-border))]',
          background.imagePath && background.inSidebar
            ? 'bg-background/25'
            : 'bg-[rgb(var(--color-sidebar))] backdrop-blur-xl backdrop-saturate-150'
        )}
        style={{ width: sidebarWidth }}
      >
        <DesktopTopBar
          testId="settings-sidebar-topbar"
          className="-mx-1.5 mb-1 w-[calc(100%+0.75rem)] shrink-0 bg-transparent pr-2 pl-2"
          left={
            <button
              type="button"
              data-testid="settings-back-button"
              onClick={onBack}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-[rgb(var(--color-sidebar-hover))]"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('workbench.settings_back_to_app', '返回')}
            </button>
          }
        />

        <nav
          data-testid="settings-sidebar-nav"
          className="scrollbar-soft min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5"
        >
          {visibleSettingsNavItems.map((item, index) => {
            const showCategory =
              item.category && visibleSettingsNavItems[index - 1]?.category !== item.category
            return (
              <div key={item.id}>
                {showCategory && (
                  <div
                    data-testid={`settings-category-${item.category}`}
                    className={cn(
                      'mb-1 px-2.5 text-xs font-medium text-text-muted',
                      index === 0 ? 'mt-2' : 'mt-5'
                    )}
                  >
                    {t(`workbench.${item.categoryLabelKey}`, item.categoryLabel)}
                  </div>
                )}
                <button
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  onClick={() => {
                    setActiveNav(item.id)
                    navigateTo(item.path)
                  }}
                  className={[
                    'flex min-h-[31px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium',
                    effectiveActiveNav === item.id
                      ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
                      : 'text-text-primary hover:bg-[rgb(var(--color-sidebar-hover))]',
                  ].join(' ')}
                >
                  {(() => {
                    const Icon = resolveDshSettingsIcon(item.icon)
                    return <Icon className="h-4 w-4 shrink-0" />
                  })()}
                  <span className="truncate">
                    {t(`workbench.${item.labelKey ?? item.id}`, item.label)}
                  </span>
                  {item.experimental ? (
                    <ExperimentalBadge
                      className="ml-auto"
                      testId={`settings-nav-${item.id}-experimental-badge`}
                    />
                  ) : null}
                </button>
              </div>
            )
          })}
        </nav>

        <button
          type="button"
          data-testid="settings-sidebar-resize-handle"
          onPointerDown={handleResizeStart}
          className="absolute right-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
          aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
        />
      </aside>

      <main
        className={cn(
          'min-w-0 flex-1 overflow-auto px-8 pt-8 pb-8',
          background.imagePath && background.inMain ? 'bg-background/20' : 'bg-background'
        )}
      >
        {activeContribution?.module ? (
          <DshSettingsSurface
            page={activeContribution}
            services={services}
            devices={devices}
            onBack={onBack}
            onOpenCloudSettings={openCloudSettings}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={onRefreshWorkLists}
            autoOpenAddCloudDeviceDialog={shouldAutoOpenAddCloudDeviceDialog}
          />
        ) : activeContribution ? (
          <DshSlotSurface
            className="contents"
            entryId={activeContribution.id}
            props={{
              services,
              devices,
              onBack,
              onOpenCloudSettings: openCloudSettings,
              onOpenRuntimeTask,
              onRefreshWorkLists,
              autoOpenAddCloudDeviceDialog: shouldAutoOpenAddCloudDeviceDialog,
            }}
            slot={WEWORK_DSH_SLOTS.settingsPage}
            testId={`dsh-settings-surface-${activeContribution.id}`}
          />
        ) : null}
      </main>
    </div>
  )
}
