import {
  ArrowLeft,
  Archive,
  Palette,
  BookOpen,
  Check,
  Cloud,
  Code2,
  ExternalLink,
  GitBranch,
  Globe2,
  Loader2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Terminal,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { buildVncPageUrl } from '@/lib/vnc'
import {
  isClaudeCodeDevice,
  isCloudDevice,
  supportsCloudLifecycleActions,
  supportsCloudSessions,
  supportsDeviceMetrics,
} from '@/lib/device-capabilities'
import type { ArchivedTask } from '@/types/api'
import type { CloudDeviceMetricsResponse, DeviceInfo } from '@/types/devices'
import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { AddCloudDeviceDialog } from './AddCloudDeviceDialog'
import { RuntimeConfigSettingsPage } from './RuntimeConfigSettingsPage'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'

interface ConnectionsSettingsPageProps {
  onBack: () => void
  autoOpenAddCloudDeviceDialog?: boolean
  onListArchivedTasks?: () => Promise<{ items: ArchivedTask[]; total: number }>
  onUnarchiveTask?: (taskId: number) => Promise<void>
  onDeleteTask?: (taskId: number) => Promise<void>
  onDeleteArchivedTasks?: () => Promise<void>
}

type SettingsCategory = 'personal' | 'coding'

interface SettingsNavItem {
  key: string
  icon: ComponentType<{ className?: string }>
  label: string
  fallback: string
  category?: SettingsCategory
}

const settingsNavItems: SettingsNavItem[] = [
  {
    key: 'connections',
    icon: Globe2,
    label: 'settings_nav_connections',
    fallback: '连接',
  },
  {
    key: 'appearance',
    icon: Palette,
    label: 'settings_nav_appearance',
    fallback: '外观',
  },
  {
    key: 'codex-auth',
    icon: UserRound,
    label: 'settings_nav_codex_auth',
    fallback: 'Codex 认证',
    category: 'personal',
  },
  {
    key: 'worktrees',
    icon: GitBranch,
    label: 'settings_nav_worktrees',
    fallback: '工作树',
    category: 'coding',
  },
  {
    key: 'archived-chats',
    icon: Archive,
    label: 'settings_nav_archived_chats',
    fallback: '已归档会话',
  },
]

const emptyArchivedTasks = async () => ({ items: [], total: 0 })
const noopArchivedAction = async () => undefined
const settingsCategoryLabels: Record<SettingsCategory, { label: string; fallback: string }> = {
  personal: {
    label: 'settings_category_personal',
    fallback: '个人',
  },
  coding: {
    label: 'settings_category_coding',
    fallback: '编码',
  },
}

function getSettingsNavFromPath(path: string): string {
  const normalizedPath = stripAppBasePath(path)
  if (normalizedPath === '/settings/personal') return 'codex-auth'
  const matchedItem = settingsNavItems.find(
    item => getSettingsNavPath(item.key) === normalizedPath,
  )
  if (matchedItem) return matchedItem.key
  const match = normalizedPath.match(/^\/settings\/([^/]+)$/)
  if (!match) return 'connections'
  return settingsNavItems.some(item => item.key === match[1]) ? match[1] : 'connections'
}

function getSettingsNavPath(key: string): string {
  if (key === 'codex-auth') return '/settings/personal/codex'
  return key === 'connections' ? '/settings' : `/settings/${key}`
}

function StatusPill({ status }: { status: DeviceInfo['status'] }) {
  const isOnline = status === 'online'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] ${
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

function DeviceActionButton({
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
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
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

function createSettingsDeviceApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function formatMetricPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--%'
  if (value < 1) return '<1%'
  return `${Math.round(value)}%`
}

function DeviceMetrics({ deviceId }: { deviceId: string }) {
  const [metrics, setMetrics] = useState<CloudDeviceMetricsResponse | null>(null)

  useEffect(() => {
    let cancelled = false

    createSettingsDeviceApi()
      .getMetrics(deviceId)
      .then(data => {
        if (!cancelled) setMetrics(data)
      })
      .catch(() => {
        if (!cancelled) setMetrics(null)
      })

    return () => {
      cancelled = true
    }
  }, [deviceId])

  return (
    <div
      data-testid="device-metrics"
      className="flex flex-wrap items-center gap-3 text-xs text-text-secondary"
    >
      <span className="inline-flex items-center gap-1">
        <span>CPU</span>
        <span>{formatMetricPercent(metrics?.cpu_usage)}</span>
      </span>
      <span className="inline-flex items-center gap-1">
        <span>MEM</span>
        <span>{formatMetricPercent(metrics?.memory_usage)}</span>
      </span>
      <span className="inline-flex items-center gap-1">
        <span>磁盘</span>
        <span>{formatMetricPercent(metrics?.disk_usage)}</span>
      </span>
    </div>
  )
}

function VncDesktopButton({ deviceId }: { deviceId: string }) {
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const config = await createSettingsDeviceApi().getVncConfig(deviceId)
      window.open(buildVncPageUrl(deviceId, config.sandbox_id), '_blank', 'noopener')
    } catch (e) {
      console.error('Failed to open device desktop:', e)
    } finally {
      setLoading(false)
    }
  }, [deviceId, loading])

  return (
    <DeviceActionButton
      testId={`connection-vnc-button-${deviceId}`}
      icon={Monitor}
      label="桌面"
      onClick={handleClick}
      disabled={loading}
    />
  )
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
  const Icon = isDelete ? Trash2 : RotateCcw
  const title = isDelete ? (isCloud ? '删除云设备' : '删除本地设备') : '重启云设备'
  const description = isDelete
    ? isCloud
      ? `将删除 ${device.name}，相关云设备资源会被释放。`
      : `将删除 ${device.name} 的本地设备注册记录。设备重新连接后会自动重新注册。`
    : `将重启 ${device.name}，设备会短暂离线，进行中的连接可能中断。`
  const confirmLabel = isDelete ? '确认删除' : '确认重启'
  const dialogTestId = isDelete
    ? 'confirm-delete-device-dialog'
    : 'confirm-restart-device-dialog'
  const confirmTestId = isDelete
    ? 'confirm-delete-device-button'
    : 'confirm-restart-device-button'
  const iconClassName = isDelete
    ? 'bg-red-500/10 text-red-500'
    : 'bg-muted text-text-secondary'
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
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              {description}
            </p>
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

function DeviceCard({ device, onChanged }: { device: DeviceInfo; onChanged: () => void }) {
  const [sessionLoading, setSessionLoading] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(device.name)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmDeviceAction | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const actionMenuRef = useRef<HTMLDivElement>(null)

  const handleStartSession = useCallback(
    async (type: 'terminal' | 'code-server') => {
      if (device.status !== 'online') return
      setSessionLoading(type)
      try {
        const { apiBaseUrl } = getRuntimeConfig()
        const client = createHttpClient({ baseUrl: apiBaseUrl })
        const deviceApi = createDeviceApi(client)
        const result =
          type === 'terminal'
            ? await deviceApi.startTerminal(device.device_id)
            : await deviceApi.startCodeServer(device.device_id)
        if (result.url) {
          window.open(result.url, '_blank', 'noopener')
        }
      } catch (e) {
        console.error(`Failed to start ${type}:`, e)
      } finally {
        setSessionLoading(null)
      }
    },
    [device.device_id, device.status],
  )

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
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
      await deviceApi.renameDevice(device.device_id, trimmed)
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
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
      await deviceApi.restartCloudDevice(device.device_id)
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
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
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

  const isOnline = device.status === 'online'
  const isCloud = isCloudDevice(device)
  const canUseCloudSessions = supportsCloudSessions(device)
  const canUseCloudLifecycleActions = supportsCloudLifecycleActions(device)
  const canDeleteOfflineLocalDevice = !isCloud && device.status === 'offline'

  return (
    <>
      <div
        data-testid={`connection-device-${device.device_id}`}
        className="rounded-lg border border-border bg-surface p-3"
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
                  {device.name}
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
            {canUseCloudSessions && (
              <>
                <DeviceActionButton
                  testId={`connection-terminal-button-${device.device_id}`}
                  icon={Terminal}
                  label="终端"
                  onClick={() => handleStartSession('terminal')}
                  disabled={!isOnline || sessionLoading === 'terminal'}
                />
                <DeviceActionButton
                  testId={`connection-code-server-button-${device.device_id}`}
                  icon={Code2}
                  label="IDE"
                  onClick={() => handleStartSession('code-server')}
                  disabled={!isOnline || sessionLoading === 'code-server'}
                />
                <VncDesktopButton deviceId={device.device_id} />
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
                    className="absolute right-0 top-9 z-20 w-32 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-[0_8px_24px_rgba(0,0,0,0.22)]"
                  >
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
            {canDeleteOfflineLocalDevice && (
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

        {supportsDeviceMetrics(device) && <DeviceMetrics deviceId={device.device_id} />}
      </div>

      {confirmAction && (
        <ConfirmDeviceActionDialog
          device={device}
          action={confirmAction}
          loading={confirmAction === 'delete' ? deleting : restarting}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirmAction === 'delete' ? handleDeleteDevice : handleRestartDevice}
        />
      )}
    </>
  )
}

function DeviceSection({
  title,
  devices,
  onChanged,
  icon: Icon,
  showScaleWiki = false,
}: {
  title: string
  devices: DeviceInfo[]
  onChanged: () => void
  icon: ComponentType<{ className?: string }>
  showScaleWiki?: boolean
}) {
  const { t } = useTranslation('common')
  const scaleWikiUrl = getRuntimeConfig().cloudDeviceScalingWikiUrl

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
        {showScaleWiki && (
          <div
            data-testid="connection-scale-wiki"
            className="rounded-lg border border-border bg-surface px-4 py-3"
          >
            <div className="flex items-start gap-3">
              <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text-primary">
                  {t('workbench.connection_scale_wiki_title', '说明')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.connection_scale_wiki_desc',
                    '当 CPU、MEM 或磁盘持续超过 80% 时，建议扩容云设备规格或清理工作区缓存。',
                  )}
                  {scaleWikiUrl && (
                    <a
                      href={scaleWikiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="connection-scale-wiki-link"
                      className="ml-2 inline-flex items-center gap-1 align-middle font-medium text-text-secondary transition-colors hover:text-primary hover:underline"
                    >
                      {t('workbench.connection_scale_wiki_link', '详细见Wiki')}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function ConnectionsDeviceSettingsPage({
  autoOpenAddCloudDeviceDialog = false,
}: {
  autoOpenAddCloudDeviceDialog?: boolean
}) {
  const { t } = useTranslation('common')
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(autoOpenAddCloudDeviceDialog)
  const [creating, setCreating] = useState(false)

  const fetchDevices = useCallback(async () => {
    try {
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
      const allDevices = await deviceApi.getAllDevices()
      const claudeCodeDevices = allDevices.filter(isClaudeCodeDevice)
      setDevices(claudeCodeDevices)
      if (claudeCodeDevices.some(isCloudDevice)) {
        setCreating(false)
      }
    } catch (e) {
      console.error('Failed to fetch devices:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const cloudDevices = devices.filter(isCloudDevice)
  const localDevices = devices.filter(device => !isCloudDevice(device))

  useEffect(() => {
    void Promise.resolve().then(fetchDevices)
  }, [fetchDevices])

  return (
    <>
      <div className="mx-auto w-full max-w-[760px]">
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">
          {t('workbench.connections_title', '连接')}
        </h1>

        <div className="mt-9 flex border-b border-border">
          {[t('workbench.connections_tab_this_mac', '连接设备')].map((tab, index) => (
            <button
              key={tab}
              type="button"
              data-testid={`connections-tab-${index}`}
              className={[
                'h-10 px-6 text-sm font-medium',
                index === 0
                  ? 'border-b border-text-primary text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {tab}
            </button>
          ))}
        </div>

        <section className="mt-6 space-y-5">
          <div className="rounded-lg border border-border bg-background p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                {t('workbench.connections_authorized_devices', '可连接的设备')}
              </h2>
              {!loading && cloudDevices.length === 0 && (
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
                <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2.5 text-xs text-primary">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  云设备创建中，初始化约需 2-3 分钟，完成后将自动出现在列表中
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-sm text-text-secondary">
                  {t('common.loading', '加载中...')}
                </div>
              ) : devices.length === 0 ? (
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
                      showScaleWiki
                      onChanged={fetchDevices}
                    />
                  )}
                  {localDevices.length > 0 && (
                    <DeviceSection
                      title={t('workbench.connection_local_devices')}
                      devices={localDevices}
                      icon={Monitor}
                      onChanged={fetchDevices}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      <AddCloudDeviceDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onCreated={fetchDevices}
        onCreatingChange={setCreating}
      />
    </>
  )
}

function formatArchivedDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ArchivedChatsSettingsPage({
  onListArchivedTasks,
  onUnarchiveTask,
  onDeleteTask,
  onDeleteArchivedTasks,
}: Required<
  Omit<ConnectionsSettingsPageProps, 'onBack' | 'autoOpenAddCloudDeviceDialog'>
>) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<ArchivedTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadArchivedTasks = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await onListArchivedTasks()
      setItems(result.items)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [onListArchivedTasks])

  useEffect(() => {
    let cancelled = false

    async function loadInitialArchivedTasks() {
      try {
        const result = await onListArchivedTasks()
        if (cancelled) return
        setItems(result.items)
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadInitialArchivedTasks()
    return () => {
      cancelled = true
    }
  }, [onListArchivedTasks])

  return (
    <div data-testid="archived-chats-settings" className="mx-auto w-full max-w-[860px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.archived_chats_title', '已归档会话')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.archived_chats_subtitle', '查看、恢复或删除已归档的会话')}
          </p>
        </div>
        <button
          type="button"
          data-testid="delete-all-archived-chats-button"
          disabled={items.length === 0 || loading}
          onClick={async () => {
            await onDeleteArchivedTasks()
            await loadArchivedTasks()
          }}
          className="h-9 rounded-full border border-red-500/20 bg-red-500/10 px-3 text-sm font-medium text-red-500 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-text-muted"
        >
          {t('workbench.archived_chats_delete_all', '全部删除')}
        </button>
      </div>

      <div className="mt-8 overflow-hidden rounded-lg border border-border bg-surface">
        {loading && (
          <p className="px-5 py-8 text-sm text-text-muted">
            {t('common.loading', '加载中...')}
          </p>
        )}
        {!loading && error && <p className="px-5 py-6 text-sm text-red-500">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <div className="flex min-h-[156px] flex-col items-center justify-center px-5 py-10 text-center">
            <Archive className="mb-3 h-7 w-7 text-text-muted" />
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.archived_chats_empty_title', '暂无已归档会话')}
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-text-secondary">
              {t('workbench.archived_chats_empty_desc', '归档后的会话会显示在这里，方便之后恢复或清理。')}
            </p>
          </div>
        )}
        {!loading &&
          !error &&
          items.map(item => (
            <div
              key={item.id}
              data-testid="archived-chat-row"
              className="flex min-h-[74px] items-center gap-4 border-b border-border bg-background px-5 py-3 last:border-b-0 hover:bg-muted"
            >
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-text-primary">
                  {item.title}
                </h2>
                <p className="mt-1 truncate text-sm text-text-secondary">
                  {formatArchivedDate(item.updated_at)}
                  {item.project_name ? ` · ${item.project_name}` : ''}
                </p>
              </div>
              <button
                type="button"
                data-testid={`delete-archived-chat-${item.id}`}
                onClick={async () => {
                  await onDeleteTask(item.id)
                  await loadArchivedTasks()
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-red-500/10 hover:text-red-500"
                aria-label={t('workbench.archived_chats_delete_one', '删除归档会话')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                data-testid={`unarchive-chat-${item.id}`}
                onClick={async () => {
                  await onUnarchiveTask(item.id)
                  await loadArchivedTasks()
                }}
                className="h-9 shrink-0 rounded-md bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
              >
                {t('workbench.archived_chats_unarchive', '恢复')}
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}

export function ConnectionsSettingsPage({
  onBack,
  autoOpenAddCloudDeviceDialog = false,
  onListArchivedTasks = emptyArchivedTasks,
  onUnarchiveTask = noopArchivedAction,
  onDeleteTask = noopArchivedAction,
  onDeleteArchivedTasks = noopArchivedAction,
}: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')
  const [activeNav, setActiveNav] = useState(() =>
    getSettingsNavFromPath(window.location.pathname)
  )

  useEffect(() => {
    const handlePopState = () => {
      setActiveNav(getSettingsNavFromPath(window.location.pathname))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return (
    <div
      data-testid="wework-settings-page"
      className="flex h-screen min-w-0 flex-1 overflow-hidden bg-background text-text-primary"
    >
      <aside className="flex w-[294px] shrink-0 flex-col bg-[rgb(var(--color-sidebar))] px-3 py-4 backdrop-blur-xl">
        <button
          type="button"
          data-testid="settings-back-button"
          onClick={onBack}
          className="mb-4 flex h-9 items-center gap-2 rounded-md px-2 text-sm text-text-secondary hover:bg-[rgb(var(--color-sidebar-hover))]"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('workbench.settings_back_to_app', '返回')}
        </button>

        <nav className="space-y-1">
          {settingsNavItems.map((item, index) => {
            const showCategory =
              item.category && settingsNavItems[index - 1]?.category !== item.category
            const categoryLabel = item.category ? settingsCategoryLabels[item.category] : null
            return (
              <div key={item.key}>
                {showCategory && categoryLabel && (
                  <div
                    data-testid={`settings-category-${item.category}`}
                    className="mb-1 mt-5 px-2.5 text-xs font-medium text-text-muted"
                  >
                    {t(`workbench.${categoryLabel.label}`, categoryLabel.fallback)}
                  </div>
                )}
                <button
                  type="button"
                  data-testid={`settings-nav-${item.key}`}
                  onClick={() => {
                    setActiveNav(item.key)
                    navigateTo(getSettingsNavPath(item.key))
                  }}
                  className={[
                    'flex min-h-[31px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium',
                    activeNav === item.key
                      ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
                      : 'text-text-primary hover:bg-[rgb(var(--color-sidebar-hover))]',
                  ].join(' ')}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {t(`workbench.${item.label}`, item.fallback)}
                  </span>
                </button>
              </div>
            )
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto bg-background px-8 py-16">
        {activeNav === 'archived-chats' ? (
          <ArchivedChatsSettingsPage
            onListArchivedTasks={onListArchivedTasks}
            onUnarchiveTask={onUnarchiveTask}
            onDeleteTask={onDeleteTask}
            onDeleteArchivedTasks={onDeleteArchivedTasks}
          />
        ) : activeNav === 'appearance' ? (
          <AppearanceSettingsPage />
        ) : activeNav === 'codex-auth' ? (
          <RuntimeConfigSettingsPage />
        ) : activeNav === 'worktrees' ? (
          <WorktreesSettingsPage />
        ) : (
          <ConnectionsDeviceSettingsPage
            autoOpenAddCloudDeviceDialog={autoOpenAddCloudDeviceDialog}
          />
        )}
      </main>
    </div>
  )
}
