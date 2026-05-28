import {
  ArrowLeft,
  Archive,
  BookOpen,
  Cloud,
  Code2,
  Cpu,
  Folder,
  Globe2,
  HardDrive,
  MemoryStick,
  Monitor,
  Plus,
  Trash2,
  Terminal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ArchivedTask } from '@/types/api'

interface ConnectionsSettingsPageProps {
  onBack: () => void
  onListArchivedTasks: () => Promise<{ items: ArchivedTask[]; total: number }>
  onUnarchiveTask: (taskId: number) => Promise<void>
  onDeleteTask: (taskId: number) => Promise<void>
  onDeleteArchivedTasks: () => Promise<void>
}

interface SettingsNavItem {
  key: string
  icon: ComponentType<{ className?: string }>
  label: string
  fallback: string
}

interface DeviceRow {
  name: string
  id: string
  status: 'online' | 'offline'
  version?: string
  cpuUsage: number
  memoryUsage: number
  diskUsage: number
}

const settingsNavItems: SettingsNavItem[] = [
  {
    key: 'connections',
    icon: Globe2,
    label: 'settings_nav_connections',
    fallback: '连接',
  },
  { key: 'projects', icon: Folder, label: 'settings_nav_projects', fallback: '项目' },
  {
    key: 'archived-chats',
    icon: Archive,
    label: 'settings_nav_archived_chats',
    fallback: '已归档会话',
  },
]

const cloudDevices: DeviceRow[] = [
  {
    name: 'yunpeng7-executor-372706c30fcd',
    id: '24a59054-4638-4744-983d-372706c30fcd',
    status: 'online',
    version: 'v1.712',
    cpuUsage: 42,
    memoryUsage: 68,
    diskUsage: 57,
  },
]

function StatusPill({ status }: { status: DeviceRow['status'] }) {
  const { t } = useTranslation('common')
  const isOnline = status === 'online'

  return (
    <span className="inline-flex items-center gap-2 text-xs text-[#6b6f76]">
      <span
        className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-[#35c26b]' : 'bg-[#aab1bc]'}`}
        aria-hidden="true"
      />
      {isOnline
        ? t('workbench.connection_status_online', '在线')
        : t('workbench.connection_status_offline', '离线')}
    </span>
  )
}

function DeviceCard({ device }: { device: DeviceRow }) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid={`connection-device-${device.id}`}
      className="rounded-lg border border-[#e2e2e2] bg-white p-3"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            data-testid={`connection-device-icon-${device.id}`}
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-[#3c4043]"
          >
            <Cloud className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-[#2d2d2d]">{device.name}</h3>
              <span className="shrink-0 rounded-full bg-[#f7f7f8] px-2 py-0.5 text-xs text-[#6b6f76]">
                {device.version || '-'}
              </span>
            </div>
            <div className="mt-1">
              <StatusPill status={device.status} />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <DeviceActionButton
            testId={`connection-terminal-button-${device.id}`}
            icon={Terminal}
            label="终端"
          />
          <DeviceActionButton
            testId={`connection-code-server-button-${device.id}`}
            icon={Code2}
            label="IDE"
          />
          <DeviceActionButton
            testId={`connection-vnc-button-${device.id}`}
            icon={Monitor}
            label="桌面"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md bg-[#fafafa] px-3 py-2">
        <ResourceMetric
          icon={Cpu}
          label={t('workbench.connection_resource_cpu', 'CPU')}
          value={device.cpuUsage}
        />
        <ResourceMetric
          icon={MemoryStick}
          label={t('workbench.connection_resource_memory', 'MEM')}
          value={device.memoryUsage}
        />
        <ResourceMetric
          icon={HardDrive}
          label={t('workbench.connection_resource_disk', '磁盘')}
          value={device.diskUsage}
        />
      </div>
    </div>
  )
}

function DeviceActionButton({
  testId,
  icon: Icon,
  label,
}: {
  testId: string
  icon: ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dedede] bg-white px-2.5 text-xs font-medium text-[#3c4043] hover:bg-[#f7f7f8]"
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  )
}

function ResourceMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: number
}) {
  return (
    <div className="flex min-w-[150px] items-center gap-2 text-xs text-[#6b6f76]">
      <span className="inline-flex w-12 shrink-0 items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e8eaed]">
        <div className="h-full rounded-full bg-[#3c4043]" style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right font-medium text-[#3c4043]">{value}%</span>
    </div>
  )
}

function DeviceSection({ title, devices }: { title: string; devices: DeviceRow[] }) {
  const { t } = useTranslation('common')

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[#5f6368]">
          <Cloud className="h-4 w-4" />
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="text-xs text-[#8a8f98]">({devices.length})</span>
        </div>
      </div>
      <div className="space-y-3">
        {devices.map(device => (
          <DeviceCard key={device.id} device={device} />
        ))}
        <div
          data-testid="connection-scale-wiki"
          className="rounded-lg border border-[#e6e6e6] bg-[#fafafa] px-4 py-3"
        >
          <div className="flex items-start gap-3">
            <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-[#5f6368]" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[#2d2d2d]">
                {t('workbench.connection_scale_wiki_title', '说明')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-[#6b6f76]">
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
}: Omit<ConnectionsSettingsPageProps, 'onBack'>) {
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
        <h1 className="text-xl font-semibold tracking-normal text-[#111]">
          Archived chats
        </h1>
        <button
          type="button"
          data-testid="delete-all-archived-chats-button"
          disabled={items.length === 0 || loading}
          onClick={async () => {
            await onDeleteArchivedTasks()
            await loadArchivedTasks()
          }}
          className="h-9 rounded-full bg-[#fee2e2] px-3 text-sm font-medium text-[#b42318] hover:bg-[#fecaca] disabled:opacity-50"
        >
          Delete all
        </button>
      </div>

      <div className="mt-10 overflow-hidden rounded-lg border border-[#e2e2e2]">
        {loading && <p className="px-5 py-6 text-sm text-[#8a8f98]">加载中...</p>}
        {!loading && error && <p className="px-5 py-6 text-sm text-[#c44]">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="px-5 py-6 text-sm text-[#8a8f98]">暂无已归档会话</p>
        )}
        {!loading &&
          !error &&
          items.map(item => (
            <div
              key={item.id}
              data-testid="archived-chat-row"
              className="flex min-h-[74px] items-center gap-4 border-b border-[#e8eaed] px-5 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-[#202124]">
                  {item.title}
                </h2>
                <p className="mt-1 truncate text-sm text-[#6b6f76]">
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
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#777] hover:bg-[#f1f3f4] hover:text-[#b42318]"
                aria-label="Delete archived chat"
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
                className="h-9 shrink-0 rounded-md bg-[#f1f3f4] px-3 text-sm font-medium text-[#3c4043] hover:bg-[#e8eaed]"
              >
                Unarchive
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}

export function ConnectionsSettingsPage({
  onBack,
  onListArchivedTasks,
  onUnarchiveTask,
  onDeleteTask,
  onDeleteArchivedTasks,
}: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')
  const [activeNav, setActiveNav] = useState('connections')

  return (
    <div
      data-testid="wework-settings-page"
      className="flex h-screen min-w-0 flex-1 overflow-hidden bg-white text-[#1f1f1f]"
    >
      <aside className="flex w-[294px] shrink-0 flex-col bg-[#d6d0c5] px-3 py-4">
        <button
          type="button"
          data-testid="settings-back-button"
          onClick={onBack}
          className="mb-4 flex h-9 items-center gap-2 rounded-md px-2 text-sm text-[#777] hover:bg-black/5"
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
                activeNav === item.key ? 'bg-black/5 text-[#202124]' : 'text-[#202124] hover:bg-black/5',
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

      <main className="min-w-0 flex-1 overflow-auto bg-white px-8 py-16">
        {activeNav === 'archived-chats' ? (
          <ArchivedChatsSettingsPage
            onListArchivedTasks={onListArchivedTasks}
            onUnarchiveTask={onUnarchiveTask}
            onDeleteTask={onDeleteTask}
            onDeleteArchivedTasks={onDeleteArchivedTasks}
          />
        ) : (
        <div className="mx-auto w-full max-w-[760px]">
          <h1 className="text-xl font-semibold tracking-normal text-[#111]">
            {t('workbench.connections_title', '连接')}
          </h1>

          <div className="mt-9 flex border-b border-[#e5e5e5]">
            {[
              t('workbench.connections_tab_this_mac', '连接设备'),
            ].map((tab, index) => (
              <button
                key={tab}
                type="button"
                data-testid={`connections-tab-${index}`}
                className={[
                  'h-10 px-6 text-sm font-medium',
                  index === 0
                    ? 'border-b border-[#111] text-[#111]'
                    : 'text-[#606368] hover:text-[#111]',
                ].join(' ')}
              >
                {tab}
              </button>
            ))}
          </div>

          <section className="mt-6 space-y-5">
            <div className="rounded-lg border border-[#e2e2e2] p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[#2d2d2d]">
                  {t('workbench.connections_authorized_devices', '可连接的设备')}
                </h2>
                <button
                  type="button"
                  data-testid="connection-add-device-button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[#f5f5f5] px-3 text-sm text-[#2d2d2d] hover:bg-[#ececec]"
                >
                  <Plus className="h-4 w-4" />
                  {t('workbench.connection_add', '添加')}
                </button>
              </div>

              <div className="space-y-5">
                <DeviceSection
                  title={t('workbench.connection_cloud_devices', '云设备')}
                  devices={cloudDevices}
                />
              </div>
            </div>
          </section>
        </div>
        )}
      </main>
    </div>
  )
}
