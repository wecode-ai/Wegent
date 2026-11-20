import { ActionMenu } from '@/components/common/ActionMenu'
import { RemoteTerminal } from '@/components/layout/workspace-panels/RemoteTerminal'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { CloudDeviceRestartProgress } from '@/features/cloud-devices/WorkbenchCloudDeviceRestarts'
import {
  cloudDeviceRestartKey,
  useWorkbenchCloudDeviceRestarts,
} from '@/features/cloud-devices/useWorkbenchCloudDeviceRestarts'
import { useTranslation } from '@/hooks/useTranslation'
import {
  isCloudDevice,
  isDeviceInteractiveSessionEnabled,
  isRemoteDevice,
  supportsCloudLifecycleActions,
  supportsCloudSessions,
  supportsDeviceMetrics,
  supportsRemoteSessions,
} from '@/lib/device-capabilities'
import { openExternalUrl } from '@/lib/external-links'
import { isImeEnterEvent } from '@/lib/ime'
import { cn } from '@/lib/utils'
import type { DeviceInfo, DeviceSessionResponse } from '@/types/devices'
import { deviceSurfaceExtension } from '@extensions/device-surface'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  AlertCircle,
  Check,
  Code2,
  Copy,
  Info,
  Loader2,
  Pencil,
  RotateCcw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DeviceActionButton } from './DeviceActionButton'
import { DeviceVersionBadge } from './DeviceVersionBadge'
import {
  createSettingsDeviceApi,
  createSettingsRemoteTerminalClientFactory,
} from './settings-cloud-api'

const DeviceSurfaceDeviceAction = deviceSurfaceExtension.DeviceAction
const keepConnectionsSettingsOpen = () => undefined

function StatusPill({
  status,
  pendingLabel,
}: {
  status: DeviceInfo['status']
  pendingLabel: string | null
}) {
  const { t } = useTranslation('common')
  const isConnected = status === 'online' || status === 'busy'
  const label = pendingLabel
    ? pendingLabel
    : status === 'busy'
      ? t('workbench.connection_status_busy')
      : status === 'online'
        ? t('workbench.connection_status_online')
        : t('workbench.connection_status_offline')

  return (
    <span
      data-testid="connection-device-status"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs',
        pendingLabel
          ? 'bg-warning/10 text-warning wework:bg-amber-500/10 wework:text-amber-700 wework:dark:text-amber-400'
          : isConnected
            ? 'bg-primary/10 text-primary'
            : 'bg-muted text-text-muted'
      )}
    >
      {pendingLabel ? (
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <span
          className={cn('h-1.5 w-1.5 rounded-full', isConnected ? 'bg-primary' : 'bg-text-muted')}
          aria-hidden="true"
        />
      )}
      {label}
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
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
    </ControlButton>
  )
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

function ConfirmDeleteDeviceDialog({
  device,
  loading,
  onCancel,
  onConfirm,
}: {
  device: DeviceInfo
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const isCloud = isCloudDevice(device)
  const isRemote = isRemoteDevice(device)
  const displayName = deviceDisplayName(device)

  const title = isCloud ? '删除云设备' : isRemote ? '删除远程设备' : '删除本地设备'
  const description = isCloud
    ? `将删除 ${displayName}，相关云设备资源会被释放。`
    : isRemote
      ? `将删除 ${displayName} 的远程设备注册记录。Docker 容器需要你自行停止或删除。`
      : `将删除 ${displayName} 的设备注册记录。`

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35"
      onClick={e => {
        if (!loading && e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        data-testid="confirm-delete-device-dialog"
        className="w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive wework:bg-red-500/10 wework:text-red-500">
            <Trash2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">{description}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="cancel-delete-device-button"
            onClick={onCancel}
            disabled={loading}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="confirm-delete-device-button"
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-contrast hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50 wework:bg-red-600 wework:text-white wework:hover:bg-red-700"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            确认删除
          </ControlButton>
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
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`copy-connection-info-${row.key}`}
                onClick={() => copyValue(row.key, row.value)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{copiedKey === row.key ? '已复制' : '复制'}</span>
              </ControlButton>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            关闭
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="copy-connection-info-all"
            onClick={() => copyValue('all', formatCloudDeviceConnectionInfo(info))}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
          >
            <Copy className="h-3.5 w-3.5" />
            {copiedKey === 'all' ? '已复制' : '复制全部'}
          </ControlButton>
        </div>
      </div>
    </div>
  )
}

function DeviceCard({
  device,
  onChanged,
}: {
  device: DeviceInfo
  onChanged: () => void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const cloudRestarts = useWorkbenchCloudDeviceRestarts()
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
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [connectionInfoOpen, setConnectionInfoOpen] = useState(false)
  const [terminalSession, setTerminalSession] = useState<DeviceSessionResponse | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const restart = cloudRestarts?.progress[cloudDeviceRestartKey(device)]
  const isRestartTarget = restart?.device.device_id === device.device_id
  const { device_id: deviceId } = device
  const { apiBaseUrl, isConnected, serviceKey, token } = cloudConnection
  const metricsResource = useMemo(
    () =>
      createAsyncResource(
        `${serviceKey}:${deviceId}`,
        async signal => {
          await Promise.resolve()
          signal.throwIfAborted()
          return createSettingsDeviceApi({ apiBaseUrl, isConnected, token }).getMetrics(deviceId)
        },
        {
          refreshOnSubscribe: true,
          refreshIntervalMs: 30_000,
          failure(error) {
            console.error('Failed to load device metrics:', error)
          },
        }
      ),
    [apiBaseUrl, deviceId, isConnected, serviceKey, token]
  )
  const metricsEnabled = supportsDeviceMetrics(device) && device.status !== 'offline'
  const metricsSnapshot = useSyncExternalStore(
    metricsEnabled ? metricsResource.subscribe : subscribeIdleResource,
    metricsResource.getSnapshot,
    getIdleResourceSnapshot
  )

  const isOnline = device.status === 'online'
  const isRemote = isRemoteDevice(device)
  const canUseCloudSessions = supportsCloudSessions(device)
  const canUseRemoteSessions = supportsRemoteSessions(device)
  const canUseDeviceSessions = canUseCloudSessions || canUseRemoteSessions
  const terminalSessionEnabled = isDeviceInteractiveSessionEnabled(device, 'terminal')
  const codeServerSessionEnabled = isDeviceInteractiveSessionEnabled(device, 'codeServer')

  const handleStartTerminal = useCallback(async () => {
    if (!isOnline || !terminalSessionEnabled) return
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
  }, [cloudConnection, device, isOnline, remoteTerminalClientFactory, t, terminalSessionEnabled])

  const handleStartIde = useCallback(async () => {
    if (!isOnline || !codeServerSessionEnabled) return
    setSessionLoading('code-server')
    setSessionError(null)
    try {
      const result = await createSettingsDeviceApi(cloudConnection).startCodeServer(
        device.device_id
      )
      if (!result.url) {
        throw new Error(t('workbench.connection_ide_url_missing'))
      }
      try {
        const opened = await openExternalUrl(result.url, { target: 'system' })
        if (!opened) {
          throw new Error('Unsupported IDE URL')
        }
      } catch (error) {
        console.error('Failed to open device IDE in the system browser:', error)
        throw new Error(t('workbench.connection_ide_open_failed'), { cause: error })
      }
    } catch (e) {
      console.error('Failed to start IDE:', e)
      setSessionError(
        e instanceof Error ? e.message : t('workbench.connection_session_start_failed')
      )
    } finally {
      setSessionLoading(null)
    }
  }, [cloudConnection, codeServerSessionEnabled, device.device_id, isOnline, t])

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

  const handleDeleteDevice = async () => {
    setDeleting(true)
    try {
      const deviceApi = createSettingsDeviceApi(cloudConnection)
      if (isCloudDevice(device)) {
        await deviceApi.deleteCloudDevice(device.device_id)
      } else {
        await deviceApi.deleteDevice(device.device_id)
      }
      setConfirmDelete(false)
      onChanged()
    } catch (e) {
      console.error('Failed to delete cloud device:', e)
    } finally {
      setDeleting(false)
    }
  }

  const openConnectionInfo = () => {
    setConnectionInfoOpen(true)
  }

  const metrics =
    metricsEnabled && metricsSnapshot.status !== 'error' ? (metricsSnapshot.data ?? null) : null
  const displayName = deviceDisplayName(device)
  const canUseCloudLifecycleActions = supportsCloudLifecycleActions(device)
  const canDeleteOfflineRemoteDevice = isRemote && device.status === 'offline'
  const lifecyclePending = isCloudDevice(device) && cloudRestarts?.isRestarting(device)
  const requestRestart = () => cloudRestarts?.requestRestart([device])
  const lifecyclePendingLabel = lifecyclePending
    ? t('workbench.connection_status_restarting')
    : null

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
                <ControlInput
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
                <ControlButton
                  variant="unstyled"
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving}
                  aria-label={t('common.save')}
                  className="rounded p-0.5 text-primary hover:bg-primary/10"
                >
                  <Check className="h-3.5 w-3.5" />
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  onClick={handleCancelEdit}
                  aria-label={t('common.cancel')}
                  className="rounded p-0.5 text-text-muted hover:bg-muted hover:text-text-primary"
                >
                  <X className="h-3.5 w-3.5" />
                </ControlButton>
              </div>
            ) : (
              <div className="group flex min-w-0 items-center gap-1.5">
                <h3
                  className="cursor-pointer truncate text-sm font-semibold text-text-primary"
                  onClick={handleStartEdit}
                  title="点击修改名称"
                >
                  {displayName}
                </h3>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  onClick={handleStartEdit}
                  aria-label={t('workbench.edit')}
                  className="rounded p-0.5 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-secondary"
                >
                  <Pencil className="h-3 w-3" />
                </ControlButton>
              </div>
            )}
            <DeviceVersionBadge
              device={device}
              disabled={lifecyclePending || !isOnline}
              onRestart={requestRestart}
            />
            <StatusPill status={device.status} pendingLabel={lifecyclePendingLabel} />
          </div>

          <div className="flex shrink-0 gap-2">
            {canUseDeviceSessions && (
              <DeviceActionButton
                testId={`connection-terminal-button-${device.device_id}`}
                icon={Terminal}
                label="终端"
                onClick={handleStartTerminal}
                disabled={
                  lifecyclePending ||
                  !isOnline ||
                  !terminalSessionEnabled ||
                  sessionLoading === 'terminal'
                }
                title={
                  !terminalSessionEnabled
                    ? t('workbench.project_terminal_unavailable_tooltip')
                    : undefined
                }
              />
            )}
            {canUseDeviceSessions && (
              <>
                <DeviceActionButton
                  testId={`connection-code-server-button-${device.device_id}`}
                  icon={Code2}
                  label="IDE"
                  onClick={handleStartIde}
                  disabled={
                    lifecyclePending ||
                    !isOnline ||
                    !codeServerSessionEnabled ||
                    sessionLoading === 'code-server'
                  }
                  title={
                    !codeServerSessionEnabled
                      ? t('workbench.project_ide_unavailable_tooltip')
                      : undefined
                  }
                />
                {deviceSurfaceExtension.available &&
                  deviceSurfaceExtension.supportsDevice(device) && (
                    <DeviceSurfaceDeviceAction
                      deviceId={device.device_id}
                      disabled={lifecyclePending || !isOnline}
                      onOpened={keepConnectionsSettingsOpen}
                    />
                  )}
              </>
            )}
            {canUseCloudLifecycleActions && (
              <ActionMenu
                testId={`connection-more-button-${device.device_id}`}
                menuTestId={`connection-more-menu-${device.device_id}`}
                ariaLabel={t('workbench.connection_more_actions')}
                placement="bottom-end"
                disabled={lifecyclePending || deleting}
                triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                items={[
                  {
                    testId: `connection-info-menu-item-${device.device_id}`,
                    label: t('workbench.connection_info_action'),
                    icon: Info,
                    onSelect: openConnectionInfo,
                  },
                  {
                    testId: `connection-restart-menu-item-${device.device_id}`,
                    label: t('workbench.connection_restart_action'),
                    icon: RotateCcw,
                    onSelect: requestRestart,
                  },
                  {
                    testId: `connection-delete-menu-item-${device.device_id}`,
                    label: t('workbench.connection_delete_action'),
                    icon: Trash2,
                    danger: true,
                    onSelect: () => setConfirmDelete(true),
                  },
                ]}
              />
            )}
            {canDeleteOfflineRemoteDevice && (
              <DeviceIconActionButton
                testId={`connection-delete-button-${device.device_id}`}
                icon={Trash2}
                label="删除设备"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
              />
            )}
          </div>
        </div>
        {isRemote && device.status !== 'offline' && device.update_available && (
          <p
            data-testid={`connection-remote-upgrade-hint-${device.device_id}`}
            className="mt-2 text-xs text-text-secondary"
          >
            {t('workbench.connection_remote_upgrade_hint')}
          </p>
        )}
        {isRestartTarget && <CloudDeviceRestartProgress device={device} />}
        {sessionError && (
          <div
            data-testid={`connection-session-error-${device.device_id}`}
            className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive wework:bg-red-500/10 wework:text-red-500"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{sessionError}</span>
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
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="settings-device-terminal-close-button"
              onClick={() => setTerminalSession(null)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label="关闭终端"
            >
              <X className="h-4 w-4" />
            </ControlButton>
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

      {confirmDelete && (
        <ConfirmDeleteDeviceDialog
          device={device}
          loading={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDeleteDevice}
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
  onChanged: () => void | Promise<void>
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
