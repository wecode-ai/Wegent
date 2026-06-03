import {
  ArrowLeft,
  Archive,
  Palette,
  BookOpen,
  Check,
  Cloud,
  Code2,
  Folder,
  Globe2,
  Loader2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { buildVncPageUrl } from '@/lib/vnc'
import type { ArchivedTask } from '@/types/api'
import type { CloudDeviceMetricsResponse, DeviceInfo } from '@/types/devices'
import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { AddCloudDeviceDialog } from './AddCloudDeviceDialog'

interface ConnectionsSettingsPageProps {
  onBack: () => void
  onListArchivedTasks?: () => Promise<{ items: ArchivedTask[]; total: number }>
  onUnarchiveTask?: (taskId: number) => Promise<void>
  onDeleteTask?: (taskId: number) => Promise<void>
  onDeleteArchivedTasks?: () => Promise<void>
}

interface SettingsNavItem {
  key: string
  icon: ComponentType<{ className?: string }>
  label: string
  fallback: string
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
  { key: 'projects', icon: Folder, label: 'settings_nav_projects', fallback: '项目' },
  {
    key: 'archived-chats',
    icon: Archive,
    label: 'settings_nav_archived_chats',
    fallback: '已归档会话',
  },
]

const emptyArchivedTasks = async () => ({ items: [], total: 0 })
const noopArchivedAction = async () => undefined

function StatusPill({ status }: { status: DeviceInfo['status'] }) {
  const isOnline = status === 'online'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] ${
        isOnline
          ? 'bg-[#eff6ff] text-[#2563eb]'
          : 'bg-[#f3f4f6] text-[#9ca3af]'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-[#409eff]' : 'bg-[#d1d5db]'}`}
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
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dedede] bg-white px-2.5 text-xs font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:cursor-not-allowed disabled:opacity-50"
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
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#dedede] bg-white text-[#6b6f76] hover:bg-[#f7f7f8] hover:text-[#3c4043] disabled:cursor-not-allowed disabled:opacity-50"
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
      className="flex flex-wrap items-center gap-3 text-xs text-[#6b6f76]"
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
  const Icon = isDelete ? Trash2 : RotateCcw
  const title = isDelete ? '删除云设备' : '重启云设备'
  const description = isDelete
    ? `将删除 ${device.name}，相关云设备资源会被释放。`
    : `将重启 ${device.name}，设备会短暂离线，进行中的连接可能中断。`
  const confirmLabel = isDelete ? '确认删除' : '确认重启'
  const dialogTestId = isDelete
    ? 'confirm-delete-device-dialog'
    : 'confirm-restart-device-dialog'
  const confirmTestId = isDelete
    ? 'confirm-delete-device-button'
    : 'confirm-restart-device-button'
  const iconClassName = isDelete
    ? 'bg-[#fef2f2] text-[#dc2626]'
    : 'bg-[#f7f7f8] text-[#5f6368]'
  const confirmClassName = isDelete
    ? 'bg-[#dc2626] hover:bg-[#b91c1c]'
    : 'bg-[#2d2d2d] hover:bg-[#111]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35"
      onClick={e => {
        if (!loading && e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        data-testid={dialogTestId}
        className="w-[420px] rounded-lg border border-[#e2e2e2] bg-white p-5 shadow-[0_18px_50px_rgba(0,0,0,0.16)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${iconClassName}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[#111]">{title}</h2>
            <p className="mt-1.5 text-xs leading-5 text-[#6b6f76]">
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
            className="h-8 rounded-md px-3 text-sm text-[#3c4043] hover:bg-[#f5f5f5] disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${confirmClassName}`}
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
      await deviceApi.deleteCloudDevice(device.device_id)
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

  return (
    <>
      <div
        data-testid={`connection-device-${device.device_id}`}
        className="rounded-lg border border-[#e2e2e2] bg-white p-3"
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
                  className="h-6 w-48 rounded border border-[#409eff] bg-white px-1.5 text-sm text-[#2d2d2d] outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="rounded p-0.5 text-[#409eff] hover:bg-[#eef6ff]"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="rounded p-0.5 text-[#999] hover:bg-[#f5f5f5]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="group flex items-center gap-1.5">
                <h3
                  className="cursor-pointer truncate text-sm font-semibold text-[#2d2d2d]"
                  onClick={handleStartEdit}
                  title="点击修改名称"
                >
                  {device.name}
                </h3>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="rounded p-0.5 text-[#bbb] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#666]"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
            <span className="shrink-0 rounded-full bg-[#f7f7f8] px-2 py-0.5 text-xs text-[#6b6f76]">
              {device.executor_version ? `v${device.executor_version}` : '-'}
            </span>
            <StatusPill status={device.status} />
          </div>

          <div className="flex shrink-0 gap-2">
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
                  className="absolute right-0 top-9 z-20 w-32 overflow-hidden rounded-md border border-[#dedede] bg-white py-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
                >
                  <button
                    type="button"
                    data-testid={`connection-restart-menu-item-${device.device_id}`}
                    onClick={() => openConfirmAction('restart')}
                    className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-[#3c4043] hover:bg-[#f7f7f8]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>重启设备</span>
                  </button>
                  <button
                    type="button"
                    data-testid={`connection-delete-menu-item-${device.device_id}`}
                    onClick={() => openConfirmAction('delete')}
                    className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-[#dc2626] hover:bg-[#fef2f2]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>删除设备</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <DeviceMetrics deviceId={device.device_id} />
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
}: {
  title: string
  devices: DeviceInfo[]
  onChanged: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-secondary">
          <Cloud className="h-3.5 w-3.5" />
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="text-xs text-text-muted">({devices.length})</span>
        </div>
      </div>
      <div className="space-y-3">
        {devices.map(device => (
          <DeviceCard key={device.device_id} device={device} onChanged={onChanged} />
        ))}
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
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ConnectionsDeviceSettingsPage() {
  const { t } = useTranslation('common')
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const fetchDevices = useCallback(async () => {
    try {
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
      const allDevices = await deviceApi.getAllDevices()
      const cloudClaudeDevices = allDevices.filter(
        d => d.device_type === 'cloud' && d.bind_shell === 'claudecode',
      )
      setDevices(cloudClaudeDevices)
      if (cloudClaudeDevices.length > 0) {
        setCreating(false)
      }
    } catch (e) {
      console.error('Failed to fetch devices:', e)
    } finally {
      setLoading(false)
    }
  }, [])

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
              {!loading && devices.length === 0 && (
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
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#409eff]" />
                  云设备创建中，初始化约需 2-3 分钟，完成后将自动出现在列表中
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-sm text-text-secondary">加载中...</div>
              ) : devices.length === 0 ? (
                <div className="py-8 text-center text-sm text-text-secondary">暂无云设备</div>
              ) : (
                <DeviceSection
                  title={t('workbench.connection_cloud_devices', '云设备')}
                  devices={devices}
                  onChanged={fetchDevices}
                />
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
}: Required<Omit<ConnectionsSettingsPageProps, 'onBack'>>) {
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
        {!loading && error && <p className="px-5 py-6 text-sm text-[#c44]">{error}</p>}
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
  onListArchivedTasks = emptyArchivedTasks,
  onUnarchiveTask = noopArchivedAction,
  onDeleteTask = noopArchivedAction,
  onDeleteArchivedTasks = noopArchivedAction,
}: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')
  const [activeNav, setActiveNav] = useState('connections')

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
          {settingsNavItems.map(item => (
            <button
              key={item.key}
              type="button"
              data-testid={`settings-nav-${item.key}`}
              onClick={() => setActiveNav(item.key)}
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
          ))}
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
        ) : (
          <ConnectionsDeviceSettingsPage />
        )}
      </main>
    </div>
  )
}
