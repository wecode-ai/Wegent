import { Cpu, Loader2, Network, Search, Server, ShieldCheck, TerminalSquare } from 'lucide-react'
import type { ComponentType, UIEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { createUserApi } from '@/api/users'
import type { UserRuntimeConfig, UserProxyConfig } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import { appsPageSectionExtensions } from '@extensions/apps'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { DeviceInfo } from '@/types/devices'

interface AppsPageState {
  devices: DeviceInfo[]
  codexConfig: UserRuntimeConfig | null
  proxyConfig: UserProxyConfig | null
  isLoading: boolean
  error: string | null
}

interface AppCardData {
  title: string
  description: string
  icon: ComponentType<{ className?: string }>
  iconClassName: string
  status: string
  statusTone: 'online' | 'warning' | 'neutral'
  meta: string
  action: string
  onClick: () => void
}

const initialState: AppsPageState = {
  devices: [],
  codexConfig: null,
  proxyConfig: null,
  isLoading: true,
  error: null,
}

type AppsSection = 'overview' | 'coding-agent' | 'installed-apps' | string

function getAppsSectionFromLocation(): AppsSection {
  const section = new URLSearchParams(window.location.search).get('section')
  if (!section) return 'overview'

  if (
    section === 'coding-agent' ||
    section === 'installed-apps' ||
    appsPageSectionExtensions.some(extension => extension.key === section)
  ) {
    return section
  }
  return 'overview'
}

const HEADER_COLLAPSE_DISTANCE = 96

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

function createAppsPageApis() {
  const { apiBaseUrl } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
  return {
    deviceApi: createDeviceApi(client),
    userApi: createUserApi(client),
  }
}

function countOnlineDevices(devices: DeviceInfo[]): number {
  return devices.filter(device => device.status === 'online').length
}

function getSlotUsage(devices: DeviceInfo[]) {
  return devices.reduce(
    (result, device) => ({
      used: result.used + (device.slot_used ?? 0),
      total: result.total + (device.slot_max ?? 0),
    }),
    { used: 0, total: 0 }
  )
}

function getLatestExecutorVersion(devices: DeviceInfo[]): string {
  const onlineDevice = devices.find(device => device.status !== 'offline')
  return onlineDevice?.executor_version || '--'
}

function percent(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.min(100, Math.round((value / max) * 100))
}

function StatusPill({ label, tone }: { label: string; tone: 'online' | 'warning' | 'neutral' }) {
  const classNameByTone = {
    online: 'bg-primary/10 text-primary',
    warning: 'bg-orange-500/10 text-orange-600',
    neutral: 'bg-muted text-text-muted',
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${classNameByTone[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function MetricRow({
  label,
  value,
  max,
  display,
}: {
  label: string
  value: number
  max: number
  display: string
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)_46px] items-center gap-3 text-xs text-text-secondary">
      <span>{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-gradient-to-r from-primary to-sky-400"
          style={{ width: `${percent(value, max)}%` }}
        />
      </div>
      <strong className="text-right text-text-primary">{display}</strong>
    </div>
  )
}

const navItems: Array<{ key: AppsSection; label: string }> = [
  { key: 'overview', label: '总览' },
  ...appsPageSectionExtensions.map(extension => ({
    key: extension.key,
    label: extension.label,
  })),
  { key: 'coding-agent', label: 'AI 编码代理' },
  { key: 'installed-apps', label: '已安装应用' },
]

function SidebarNav({
  activeSection,
  onSelect,
}: {
  activeSection: AppsSection
  onSelect: (section: AppsSection) => void
}) {
  return (
    <aside
      data-testid="apps-sidebar-nav"
      className="hidden min-h-0 flex-col rounded-xl border border-border/60 bg-background p-3 shadow-[0_3px_16px_rgba(0,0,0,0.04)] md:flex"
    >
      <div className="flex items-center gap-3 px-2 pb-4 pt-2">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-primary to-sky-500 text-sm font-bold text-white">
          A
        </div>
        <div>
          <div className="text-sm font-semibold text-text-primary">应用中心</div>
          <div className="text-xs text-text-muted">运行时、代理与小程序</div>
        </div>
      </div>

      <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">
        管理
      </div>
      <div className="mt-2 space-y-1">
        {navItems.map(item => (
          <button
            key={item.key}
            type="button"
            data-testid={`apps-nav-${item.key}`}
            onClick={() => onSelect(item.key)}
            className={`flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium ${
              activeSection === item.key
                ? 'bg-primary/10 text-primary'
                : 'text-text-secondary hover:bg-muted hover:text-text-primary'
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-current" />
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-auto" />
    </aside>
  )
}

function SectionTabs({
  activeSection,
  onSelect,
}: {
  activeSection: AppsSection
  onSelect: (section: AppsSection) => void
}) {
  return (
    <div
      data-testid="apps-section-tabs"
      className="border-b border-border/70 bg-background px-4 py-3 md:hidden"
    >
      <div className="flex gap-2 overflow-x-auto">
        {navItems.map(item => (
          <button
            key={item.key}
            type="button"
            data-testid={`apps-mobile-nav-${item.key}`}
            onClick={() => onSelect(item.key)}
            className={`h-10 shrink-0 rounded-full px-4 text-sm font-semibold ${
              activeSection === item.key
                ? 'bg-primary text-white'
                : 'border border-border bg-background text-text-secondary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ExecutorStatusCard({ devices }: { devices: DeviceInfo[] }) {
  const slotUsage = getSlotUsage(devices)
  const onlineCount = countOnlineDevices(devices)
  const version = getLatestExecutorVersion(devices)

  return (
    <article className="rounded-3xl border border-border bg-background p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-bold text-text-primary">Executor 状态</div>
        <StatusPill
          label={onlineCount > 0 ? '运行中' : '未连接'}
          tone={onlineCount > 0 ? 'online' : 'neutral'}
        />
      </div>
      <div className="mt-5 space-y-3">
        <MetricRow
          label="任务槽位"
          value={slotUsage.used}
          max={slotUsage.total}
          display={`${slotUsage.used}/${slotUsage.total || 0}`}
        />
        <MetricRow
          label="在线设备"
          value={onlineCount}
          max={Math.max(devices.length, 1)}
          display={`${onlineCount}`}
        />
        <MetricRow label="版本" value={version === '--' ? 0 : 1} max={1} display={version} />
      </div>
    </article>
  )
}

function HeroSection() {
  return (
    <article className="relative overflow-hidden rounded-3xl border border-border bg-background p-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/10 blur-2xl" />
      <div className="relative max-w-2xl text-2xl font-bold leading-tight tracking-[-0.04em] text-text-primary">
        让 WeWork 成为所有 AI 工具的统一入口
      </div>
      <p className="relative mt-3 max-w-3xl text-sm leading-7 text-text-secondary">
        使用公司的模型服务代理 Claude 和 Codex，任务服务负责本地/云端运行，小程序负责办公流程。
        用户不用理解底层差异，只需要打开应用、授权、开始工作。
      </p>
      <div className="relative mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="apps-open-codex-button"
          onClick={() => navigateTo('/settings/personal/codex')}
          className="inline-flex h-9 items-center rounded-full bg-text-primary px-4 text-sm font-semibold text-background hover:opacity-90"
        >
          打开 Codex
        </button>
        <button
          type="button"
          onClick={() => navigateTo('/settings/personal/proxy')}
          className="inline-flex h-9 items-center rounded-full border border-border bg-background px-4 text-sm font-semibold text-text-primary hover:bg-muted"
        >
          配置模型代理
        </button>
      </div>
    </article>
  )
}

function AppsPageHeader({ collapseProgress }: { collapseProgress: number }) {
  const detailOpacity = 1 - collapseProgress
  const headerPadding = interpolate(20, 8, collapseProgress)
  const titleFontSize = interpolate(24, 20, collapseProgress)
  const titleLineHeight = interpolate(32, 28, collapseProgress)
  const eyebrowHeight = interpolate(18, 0, collapseProgress)
  const descriptionHeight = interpolate(24, 0, collapseProgress)
  const titleMarginTop = interpolate(4, 0, collapseProgress)
  const searchHeight = interpolate(44, 40, collapseProgress)

  return (
    <div
      data-testid="apps-page-header"
      data-collapse-progress={collapseProgress.toFixed(2)}
      className="sticky top-0 z-10 flex flex-col gap-3 border-b border-border/70 bg-background/90 backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between"
      style={{
        padding: `${headerPadding}px`,
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="overflow-hidden text-xs font-bold uppercase tracking-[0.12em] text-primary"
          style={{
            height: `${eyebrowHeight}px`,
            opacity: detailOpacity,
          }}
          aria-hidden={collapseProgress >= 0.98}
        >
          App Center
        </div>
        <h1
          className="truncate font-bold text-text-primary"
          style={{
            fontSize: `${titleFontSize}px`,
            lineHeight: `${titleLineHeight}px`,
            marginTop: `${titleMarginTop}px`,
          }}
        >
          管理你的办公与编码应用
        </h1>
        <p
          className="max-w-2xl overflow-hidden text-sm leading-6 text-text-secondary"
          style={{
            height: `${descriptionHeight}px`,
            marginTop: `${interpolate(8, 0, collapseProgress)}px`,
            opacity: detailOpacity,
          }}
          aria-hidden={collapseProgress >= 0.98}
        >
          集中查看任务服务状态，配置 Claude / Codex 代理，安装内部应用和第三方小程序。
        </p>
      </div>
      <label className="relative min-w-0 lg:w-80">
        <Search
          className="absolute left-3 h-4 w-4 text-text-muted"
          style={{ top: `${(searchHeight - 16) / 2}px` }}
        />
        <input
          data-testid="apps-search-input"
          className="w-full rounded-full border border-border bg-background pl-9 pr-4 text-sm text-text-primary outline-none placeholder:text-text-muted"
          style={{ height: `${searchHeight}px` }}
          placeholder="搜索应用、运行时或代理..."
          aria-label="搜索应用"
        />
      </label>
    </div>
  )
}

function AppCard({ app }: { app: AppCardData }) {
  const Icon = app.icon

  return (
    <article className="flex min-h-44 flex-col rounded-2xl border border-border bg-background p-4 transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_12px_28px_rgba(15,23,42,0.07)]">
      <div className="flex items-start justify-between gap-3">
        <div className={`grid h-11 w-11 place-items-center rounded-2xl ${app.iconClassName}`}>
          <Icon className="h-5 w-5" />
        </div>
        <StatusPill label={app.status} tone={app.statusTone} />
      </div>
      <div className="mt-4 text-sm font-bold text-text-primary">{app.title}</div>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{app.description}</p>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <button
          type="button"
          onClick={app.onClick}
          className="text-sm font-bold text-primary hover:underline"
        >
          {app.action}
        </button>
        <span className="truncate text-xs text-text-muted">{app.meta}</span>
      </div>
    </article>
  )
}

function SummaryCard({ value, label }: { value: string; label: string }) {
  return (
    <article className="rounded-2xl border border-border bg-background p-4">
      <div className="text-2xl font-bold tracking-[-0.04em] text-text-primary">{value}</div>
      <div className="mt-1 text-xs text-text-muted">{label}</div>
    </article>
  )
}

function ActivityRow({
  color,
  title,
  meta,
  time,
}: {
  color: string
  title: string
  meta: string
  time: string
}) {
  return (
    <div className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-border bg-background px-4 py-3">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-text-primary">{title}</div>
        <div className="mt-0.5 truncate text-xs text-text-muted">{meta}</div>
      </div>
      <span className="text-xs text-text-muted">{time}</span>
    </div>
  )
}

function buildRecommendedApps(state: AppsPageState): AppCardData[] {
  const proxyConfigured = state.proxyConfig?.configured ?? false
  const codexConfigured = state.codexConfig?.configured ?? false

  return [
    {
      title: 'Claude Code',
      description: '使用 WeWork 模型服务代理 Claude Code，统一接入账号、模型与运行时环境。',
      icon: TerminalSquare,
      iconClassName: 'bg-gradient-to-br from-orange-400 to-red-500 text-white',
      status: proxyConfigured ? '已代理' : '待配置',
      statusTone: proxyConfigured ? 'online' : 'warning',
      meta: proxyConfigured ? '模型代理可用' : '未配置代理',
      action: proxyConfigured ? '打开' : '去配置',
      onClick: () => navigateTo('/settings/personal/proxy'),
    },
    {
      title: 'Codex',
      description: '管理 Codex auth.json、代理开关与默认 GPT 模型，可从在线设备导入认证。',
      icon: Cpu,
      iconClassName: 'bg-gradient-to-br from-slate-900 to-slate-500 text-white',
      status: codexConfigured ? '已认证' : '需认证',
      statusTone: codexConfigured ? 'online' : 'warning',
      meta: codexConfigured ? 'auth.json 已保存' : 'auth.json 缺失',
      action: codexConfigured ? '打开' : '去配置',
      onClick: () => navigateTo('/settings/personal/codex'),
    },
  ]
}

export function AppsPage() {
  const { t } = useTranslation('common')
  const [state, setState] = useState<AppsPageState>(initialState)
  const [activeSection, setActiveSection] = useState<AppsSection>(() =>
    getAppsSectionFromLocation()
  )
  const [headerCollapseProgress, setHeaderCollapseProgress] = useState(0)
  const scrollFrameRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const { deviceApi, userApi } = createAppsPageApis()

    Promise.all([
      deviceApi.getAllDevices(),
      userApi.getRuntimeConfig('codex'),
      userApi.getProxyConfig(),
    ])
      .then(([devices, codexConfig, proxyConfig]) => {
        if (cancelled) return
        setState({ devices, codexConfig, proxyConfig, isLoading: false, error: null })
      })
      .catch(error => {
        if (cancelled) return
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: error instanceof Error ? error.message : '应用中心加载失败',
        }))
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const syncSectionFromLocation = () => {
      setActiveSection(getAppsSectionFromLocation())
    }
    window.addEventListener('popstate', syncSectionFromLocation)
    return () => window.removeEventListener('popstate', syncSectionFromLocation)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
    }
  }, [])

  const handleScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const scrollTop = event.currentTarget.scrollTop

    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const nextProgress = clamp(scrollTop / HEADER_COLLAPSE_DISTANCE, 0, 1)
      setHeaderCollapseProgress(nextProgress)
      scrollFrameRef.current = null
    })
  }, [])

  const onlineCount = countOnlineDevices(state.devices)
  const slotUsage = getSlotUsage(state.devices)
  const recommendedApps = useMemo(() => buildRecommendedApps(state), [state])
  const extensionSection = appsPageSectionExtensions.find(
    extension => extension.key === activeSection
  )

  return (
    <div
      data-testid="apps-page"
      className="grid h-full min-h-0 grid-cols-1 gap-1.5 overflow-hidden bg-transparent p-1.5 md:grid-cols-[220px_minmax(0,1fr)]"
    >
      <SidebarNav activeSection={activeSection} onSelect={setActiveSection} />

      <section
        data-testid="apps-scroll-container"
        className="min-w-0 overflow-auto rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]"
        onScroll={handleScroll}
      >
        <AppsPageHeader collapseProgress={headerCollapseProgress} />
        <SectionTabs activeSection={activeSection} onSelect={setActiveSection} />

        <div className="p-5">
          {state.error && (
            <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-500">
              {state.error}
            </div>
          )}

          {state.isLoading ? (
            <div className="flex h-80 items-center justify-center gap-3 text-sm text-text-secondary">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('common.loading', '加载中...')}
            </div>
          ) : extensionSection ? (
            extensionSection.render({ devices: state.devices })
          ) : activeSection === 'coding-agent' ? (
            <PlaceholderSection
              title="AI 编码代理"
              detail="这里会集中展示 Claude Code、Codex 和模型代理等编码类应用。"
            />
          ) : activeSection === 'installed-apps' ? (
            <PlaceholderSection
              title="已安装应用"
              detail="这里会展示用户已经安装的小程序、插件和办公工作流入口。"
            />
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]">
                <HeroSection />
                <ExecutorStatusCard devices={state.devices} />
              </div>

              <section className="mt-6">
                <div className="mb-4 flex items-end justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">
                      推荐应用
                    </h2>
                    <p className="mt-1 text-sm text-text-muted">
                      优先展示用户最常用、最需要配置状态感知的应用。
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 lg:grid-cols-3">
                  {recommendedApps.map(app => (
                    <AppCard key={app.title} app={app} />
                  ))}
                </div>
              </section>

              <section className="mt-6">
                <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">运行概览</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <SummaryCard value={`${onlineCount}`} label="在线设备" />
                  <SummaryCard value={`${recommendedApps.length}`} label="内置应用" />
                  <SummaryCard value={`${slotUsage.total || 0}`} label="可用任务槽位" />
                  <SummaryCard
                    value={state.proxyConfig?.configured ? '已配置' : '未配置'}
                    label="模型代理"
                  />
                </div>
              </section>

              <section className="mt-6">
                <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">快速入口</h2>
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <QuickAction icon={Server} title="设备管理" detail="查看设备、任务槽位和版本" />
                  <QuickAction icon={Network} title="模型代理" detail="配置公司代理服务" />
                  <QuickAction icon={Cpu} title="内置应用" detail="打开 Codex 等工作入口" />
                  <QuickAction
                    icon={ShieldCheck}
                    title="权限与认证"
                    detail="管理 Codex 与应用授权"
                  />
                </div>
              </section>

              <section className="mt-6">
                <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">最近活动</h2>
                <div className="mt-4 space-y-2">
                  <ActivityRow
                    color="bg-primary"
                    title="Codex 代理配置已同步"
                    meta="影响当前账号"
                    time="刚刚"
                  />
                  <ActivityRow
                    color="bg-sky-500"
                    title={`Executor ${onlineCount > 0 ? '在线可用' : '等待连接'}`}
                    meta={`设备总数 ${state.devices.length}`}
                    time="实时"
                  />
                  <ActivityRow
                    color="bg-violet-500"
                    title="应用中心框架已启用"
                    meta="顶部固定入口 · 办公与编码应用"
                    time="今天"
                  />
                </div>
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function PlaceholderSection({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="rounded-2xl border border-border bg-background p-8">
      <div className="max-w-xl">
        <h2 className="text-xl font-bold text-text-primary">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{detail}</p>
      </div>
    </section>
  )
}

function QuickAction({
  icon: Icon,
  title,
  detail,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
}) {
  return (
    <article className="rounded-2xl border border-border bg-background p-4">
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-muted text-text-secondary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-sm font-semibold text-text-primary">{title}</div>
      </div>
      <div className="mt-2 text-xs leading-5 text-text-muted">{detail}</div>
    </article>
  )
}
