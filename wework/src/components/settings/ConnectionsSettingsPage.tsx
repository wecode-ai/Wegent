import {
  ArrowLeft,
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
  Terminal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

interface ConnectionsSettingsPageProps {
  onBack: () => void
}

interface SettingsNavItem {
  key: string
  icon: ComponentType<{ className?: string }>
  label: string
  fallback: string
  active?: boolean
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
    active: true,
  },
  { key: 'projects', icon: Folder, label: 'settings_nav_projects', fallback: '项目' },
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

export function ConnectionsSettingsPage({ onBack }: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')

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
              className={[
                'flex min-h-[31px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium',
                item.active ? 'bg-black/5 text-[#202124]' : 'text-[#202124] hover:bg-black/5',
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
        <div className="mx-auto w-full max-w-[760px]">
          <h1 className="text-xl font-semibold tracking-normal text-[#111]">
            {t('workbench.connections_title', '连接')}
          </h1>

          <div className="mt-9 flex border-b border-[#e5e5e5]">
            {[
              t('workbench.connections_tab_this_mac', '连接这台设备'),
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
      </main>
    </div>
  )
}
