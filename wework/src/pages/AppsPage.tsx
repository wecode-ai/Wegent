import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  FolderOpen,
  Grid3X3,
  Loader2,
  Network,
  PackagePlus,
  Play,
  Power,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import type { ComponentType, UIEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import {
  getExecutorReadiness,
  getLocalExecutorStatus,
  getStartupEnv,
  getWecodeInstallCommand,
  openExecutorLogsDirectory,
  runLocalExecutorAction,
  saveStartupEnv,
  type ExecutorAction,
  type ExecutorCommandOutput,
  type ExecutorStatus,
  type LocalExecutorReadiness,
  type StartupEnvVar,
} from '@/api/local-executor'
import { createUserApi } from '@/api/users'
import type { UserRuntimeConfig, UserProxyConfig } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
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

interface LocalExecutorState {
  status: ExecutorStatus | null
  envVars: StartupEnvVar[]
  isLoading: boolean
  isMutating: boolean
  activeAction: ExecutorAction | null
  isOpeningLogs: boolean
  isSavingEnv: boolean
  envExpanded: boolean
  error: string | null
  message: string | null
  commandOutput: string
  commandSucceeded: boolean | null
  commandExitCode: number | null
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

const initialLocalExecutorState: LocalExecutorState = {
  status: null,
  envVars: [],
  isLoading: true,
  isMutating: false,
  activeAction: null,
  isOpeningLogs: false,
  isSavingEnv: false,
  envExpanded: false,
  error: null,
  message: null,
  commandOutput: '',
  commandSucceeded: null,
  commandExitCode: null,
}

type AppsSection =
  | 'overview'
  | 'local-management'
  | 'coding-agent'
  | 'installed-apps'

const HEADER_COLLAPSE_DISTANCE = 96
const EXECUTOR_ACTION_MIN_FEEDBACK_MS = 400
const ENV_AUTO_SAVE_DELAY_MS = 500
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

function waitForDuration(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs))
}

function canSaveEnvVars(envVars: StartupEnvVar[]): boolean {
  return envVars.every((envVar) => ENV_KEY_PATTERN.test(envVar.key.trim()))
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
  return devices.filter((device) => device.status === 'online').length
}

function getSlotUsage(devices: DeviceInfo[]) {
  return devices.reduce(
    (result, device) => ({
      used: result.used + (device.slot_used ?? 0),
      total: result.total + (device.slot_max ?? 0),
    }),
    { used: 0, total: 0 },
  )
}

function getLatestExecutorVersion(devices: DeviceInfo[]): string {
  const onlineDevice = devices.find((device) => device.status !== 'offline')
  return onlineDevice?.executor_version || '--'
}

function percent(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.min(100, Math.round((value / max) * 100))
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: 'online' | 'warning' | 'neutral'
}) {
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
  { key: 'local-management', label: '本机管理' },
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
    <aside className="hidden min-h-0 flex-col rounded-xl border border-border/60 bg-background p-3 shadow-[0_3px_16px_rgba(0,0,0,0.04)] xl:flex">
      <div className="flex items-center gap-3 px-2 pb-4 pt-2">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-primary to-sky-500 text-sm font-bold text-white">
          A
        </div>
        <div>
          <div className="text-sm font-semibold text-text-primary">
            应用中心
          </div>
          <div className="text-xs text-text-muted">运行时、代理与小程序</div>
        </div>
      </div>

      <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">
        管理
      </div>
      <div className="mt-2 space-y-1">
        {navItems.map((item) => (
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
    <div className="border-b border-border/70 bg-background px-4 py-3 xl:hidden">
      <div className="flex gap-2 overflow-x-auto">
        {navItems.map((item) => (
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
        <MetricRow
          label="版本"
          value={version === '--' ? 0 : 1}
          max={1}
          display={version}
        />
      </div>
    </article>
  )
}

function getReadinessCopy(readiness: LocalExecutorReadiness) {
  switch (readiness) {
    case 'desktop_only':
      return {
        label: '仅桌面端',
        detail: '请在 macOS 或 Windows 桌面 App 中管理本机 executor。',
        tone: 'neutral' as const,
      }
    case 'cli_missing':
      return {
        label: '未安装 CLI',
        detail: '未检测到 WeCode CLI，请先安装后重新检测。',
        tone: 'warning' as const,
      }
    case 'node_missing':
      return {
        label: 'Node 不可用',
        detail: '未检测到 Node.js >= 20，请先安装或修复 Node。',
        tone: 'warning' as const,
      }
    case 'executor_missing':
      return {
        label: '未安装 Executor',
        detail: '已检测到 WeCode CLI，可以直接安装本机 executor。',
        tone: 'warning' as const,
      }
    case 'executor_stopped':
      return {
        label: '已停止',
        detail: 'Executor 已安装但未运行，可以从这里启动。',
        tone: 'neutral' as const,
      }
    case 'executor_running':
      return {
        label: '本机运行中',
        detail: 'Executor 进程已运行，正在通过设备列表确认连接状态。',
        tone: 'online' as const,
      }
  }
}

function getCommandOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

function ExecutorTerminal({
  output,
  isRunning,
  succeeded,
  exitCode,
}: {
  output: string
  isRunning: boolean
  succeeded: boolean | null
  exitCode: number | null
}) {
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const element = outputRef.current
    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }, [output])

  const status = isRunning
    ? '执行中'
    : succeeded === null
      ? '等待命令'
      : succeeded
        ? '执行完成'
        : `执行失败${exitCode === null ? '' : ` · code ${exitCode}`}`

  return (
    <div
      data-testid="executor-command-terminal"
      className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100"
    >
      <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
          <TerminalSquare className="h-3.5 w-3.5" />
          命令输出
        </div>
        <span
          className={`text-[11px] ${
            isRunning
              ? 'text-amber-300'
              : succeeded === false
                ? 'text-red-300'
                : 'text-zinc-400'
          }`}
        >
          {status}
        </span>
      </div>
      <pre
        ref={outputRef}
        data-testid="executor-command-output"
        aria-live="polite"
        className="h-52 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-zinc-200"
      >
        {output || '$ 等待执行 Executor 命令...'}
        {isRunning ? <span className="animate-pulse">▋</span> : null}
      </pre>
    </div>
  )
}

function localDeviceOnline(devices: DeviceInfo[]): boolean {
  return devices.some(
    (device) => device.device_type === 'local' && device.status !== 'offline',
  )
}

function LocalManagementPage({
  state,
  devices,
  onRefresh,
  onRunAction,
  onOpenLogs,
  onChangeEnv,
  onAddEnv,
  onDeleteEnv,
  onToggleEnvExpanded,
}: {
  state: LocalExecutorState
  devices: DeviceInfo[]
  onRefresh: () => void
  onRunAction: (action: ExecutorAction) => void
  onOpenLogs: () => void
  onChangeEnv: (index: number, patch: Partial<StartupEnvVar>) => void
  onAddEnv: () => void
  onDeleteEnv: (index: number) => void
  onToggleEnvExpanded: () => void
}) {
  const readiness = getExecutorReadiness(state.status)
  const copy = getReadinessCopy(readiness)
  const installCommand = getWecodeInstallCommand()
  const isBusy = state.isLoading || state.isMutating
  const online = localDeviceOnline(devices)
  const node = state.status?.node
  const cli = state.status?.cli
  const hasCollapsibleEnvVars = state.envVars.length > 4
  const envVarsSavable = canSaveEnvVars(state.envVars)
  const envRows = state.envExpanded ? state.envVars : state.envVars.slice(0, 4)

  const copyInstallCommand = useCallback(() => {
    navigator.clipboard?.writeText(installCommand)
  }, [installCommand])

  return (
    <div data-testid="local-management-page" className="space-y-4">
      <div className="flex flex-col gap-4 border-b border-border/70 bg-background/90 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-primary">
            Local Management
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-text-primary">
            本机管理
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
            管理本机 Node、WeCode CLI、Wegent Executor、启动环境变量和连接诊断。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExecutorActionButton
            testId="executor-refresh-button"
            icon={RefreshCw}
            label="重新检测"
            disabled={isBusy}
            onClick={onRefresh}
          />
          <ExecutorPrimaryActionButton
            testId="executor-primary-action-button"
            readiness={readiness}
            disabled={isBusy}
            activeAction={state.activeAction}
            onRunAction={onRunAction}
          />
        </div>
      </div>

      <div className="px-5 pb-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <LocalSummaryCard
            label="Node.js"
            value={node?.version || '未检测'}
            note={
              node?.meets_minimum
                ? '满足 Node >= 20'
                : node?.error || '需要 Node >= 20'
            }
          />
          <LocalSummaryCard
            label="WeCode CLI"
            value={
              cli?.version?.replace('wecode-cli version: ', '') || '未检测'
            }
            note={cli?.path || cli?.error || '等待检测'}
          />
          <LocalSummaryCard
            label="Executor"
            value={
              state.status?.running
                ? '运行中'
                : state.status?.installed
                  ? '已停止'
                  : '未安装'
            }
            note={state.status?.pid ? `PID ${state.status.pid}` : copy.detail}
          />
          <LocalSummaryCard
            label="Wegent 连接"
            value={online ? '已在线' : '未在线'}
            note={online ? 'Backend 已看到本机设备' : '启动后等待设备心跳'}
          />
          <LocalSummaryCard
            label="环境变量"
            value={`${state.envVars.length} 项`}
            note="仅存储在本机 App"
          />
        </div>

        {(state.error || state.message || state.status?.error) && (
          <div className="mt-4 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-text-secondary">
            {state.error || state.message || state.status?.error}
          </div>
        )}

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.85fr)]">
          <section className="rounded-2xl border border-border bg-background">
            <div className="flex items-center justify-between gap-3 border-b border-border p-4">
              <div>
                <h2 className="text-base font-bold text-text-primary">
                  本机依赖检测
                </h2>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  启动前检查 Node、CLI、Executor 二进制、登录用户和 Backend
                  URL。
                </p>
              </div>
              <StatusPill label={copy.label} tone={copy.tone} />
            </div>
            <div className="space-y-3 p-4">
              <LocalDetailRow
                label="Node.js"
                value={
                  node?.path
                    ? `${node.path} · ${node.version || '--'}`
                    : node?.error || '未检测到'
                }
                status={node?.meets_minimum ? '通过' : '需安装'}
                tone={node?.meets_minimum ? 'online' : 'warning'}
              />
              <LocalDetailRow
                label="WeCode CLI"
                value={
                  cli?.path
                    ? `${cli.path} · ${cli.version || '--'}`
                    : cli?.error || '未检测到'
                }
                status={cli?.available ? '已检测' : '未检测'}
                tone={cli?.available ? 'online' : 'warning'}
              />
              <LocalDetailRow
                label="Executor binary"
                value={
                  state.status?.installed
                    ? '~/.wecode/wegent-executor/bin/wegent-executor'
                    : '未安装'
                }
                status={state.status?.installed ? '已安装' : '未安装'}
                tone={state.status?.installed ? 'online' : 'warning'}
              />
              <LocalDetailRow
                label="Backend 连接"
                value={
                  online
                    ? 'Backend /devices 已存在在线 local device'
                    : '暂未看到在线本机设备'
                }
                status={online ? '已连接' : '等待连接'}
                tone={online ? 'online' : 'neutral'}
              />
              {readiness === 'cli_missing' && (
                <div className="rounded-xl border border-border bg-surface p-3">
                  <div className="mb-2 text-xs font-semibold text-text-primary">
                    WeCode CLI 安装命令
                  </div>
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-text-primary p-3 text-xs leading-5 text-background">
                    {installCommand}
                  </pre>
                  <button
                    type="button"
                    data-testid="executor-copy-install-command-button"
                    onClick={copyInstallCommand}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-text-primary hover:bg-muted"
                  >
                    <Copy className="h-4 w-4" />
                    复制安装命令
                  </button>
                </div>
              )}
              <pre className="rounded-xl bg-text-primary p-4 text-xs leading-6 text-background">
                node --version{'\n'}wecode version{'\n'}wecode executor status
              </pre>
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-background">
            <div className="border-b border-border p-4">
              <h2 className="text-base font-bold text-text-primary">
                快捷操作
              </h2>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                按钮根据当前状态启用，避免用户执行无效操作。
              </p>
            </div>
            <div className="grid gap-3 p-4">
              <ExecutorPrimaryActionButton
                testId="executor-local-primary-action-button"
                readiness={readiness}
                disabled={isBusy}
                activeAction={state.activeAction}
                onRunAction={onRunAction}
              />
              <ExecutorActionButton
                testId="executor-local-install-button"
                icon={Download}
                label="安装 / 修复 Executor"
                disabled={
                  isBusy ||
                  readiness === 'desktop_only' ||
                  readiness === 'cli_missing'
                }
                onClick={() => onRunAction('install')}
              />
              <ExecutorActionButton
                testId="executor-stop-button"
                icon={Power}
                label="停止 Executor"
                loading={state.activeAction === 'stop'}
                loadingLabel="停止中..."
                disabled={isBusy || readiness !== 'executor_running'}
                onClick={() => onRunAction('stop')}
              />
              <ExecutorActionButton
                testId="executor-upgrade-button"
                icon={CheckCircle2}
                label="升级 CLI / Executor"
                disabled={
                  isBusy ||
                  readiness === 'desktop_only' ||
                  readiness === 'cli_missing'
                }
                onClick={() => onRunAction('upgrade')}
              />
              <ExecutorTerminal
                output={state.commandOutput}
                isRunning={state.isMutating}
                succeeded={state.commandSucceeded}
                exitCode={state.commandExitCode}
              />
            </div>
          </section>
        </div>

        <section className="mt-4 rounded-2xl border border-border bg-background">
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-bold text-text-primary">
                启动环境变量
              </h2>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                启动 executor 时自动注入。多于 4
                项时默认折叠，展开后可查看全部。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ExecutorActionButton
                testId="executor-env-add-button"
                icon={Plus}
                label="新增变量"
                disabled={false}
                onClick={onAddEnv}
              />
            </div>
          </div>
          <div className="p-4">
            <div className="grid gap-3">
              {envRows.map((envVar, index) => (
                <EnvVarRow
                  key={`${envVar.key}-${index}`}
                  envVar={envVar}
                  index={index}
                  onChange={onChangeEnv}
                  onDelete={onDeleteEnv}
                />
              ))}
            </div>
            <div
              className={`mt-3 flex flex-col gap-3 sm:flex-row sm:items-center ${
                hasCollapsibleEnvVars ? 'sm:justify-between' : 'sm:justify-end'
              }`}
            >
              {hasCollapsibleEnvVars && (
                <button
                  type="button"
                  data-testid="executor-env-toggle-button"
                  onClick={onToggleEnvExpanded}
                  className="inline-flex h-9 items-center gap-2 text-sm font-semibold text-primary"
                >
                  <ChevronDown
                    className={`h-4 w-4 transition ${
                      state.envExpanded ? 'rotate-180' : ''
                    }`}
                  />
                  {state.envExpanded
                    ? '收起环境变量'
                    : `展开全部 ${state.envVars.length} 项`}
                </button>
              )}
              <StatusPill
                label={
                  !envVarsSavable
                    ? '填写变量名后自动保存'
                    : state.isSavingEnv
                      ? '保存中...'
                      : '已自动保存，重启后生效'
                }
                tone={
                  !envVarsSavable || state.isSavingEnv ? 'warning' : 'neutral'
                }
              />
            </div>
            <div className="mt-3 rounded-xl bg-primary/10 px-3 py-2 text-xs leading-5 text-primary">
              启动动作会读取本机保存的 env 配置，再执行 wecode executor start。
              敏感值显示为掩码，配置仅保存在本机 App。
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-border bg-background">
          <div className="flex items-center justify-between gap-3 border-b border-border p-4">
            <div>
              <h2 className="text-base font-bold text-text-primary">
                连接诊断
              </h2>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                把 Node、CLI、进程和 Backend 在线状态拆开显示。
              </p>
            </div>
            <StatusPill label="5 步检查" tone="neutral" />
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-5">
            <DiagnosticStep
              index={1}
              title="Node 可用"
              detail="Node >= 20，路径可执行。"
            />
            <DiagnosticStep
              index={2}
              title="CLI 可用"
              detail="通过 PATH 或 ~/.wecode 查找 wecode。"
            />
            <DiagnosticStep
              index={3}
              title="Executor 已安装"
              detail="读取 status 的 Installed 字段。"
            />
            <DiagnosticStep
              index={4}
              title="本机进程运行"
              detail="展示 PID、启动错误和日志。"
            />
            <DiagnosticStep
              index={5}
              title="设备在线"
              detail="对照 Backend /devices 的 local device。"
            />
          </div>
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <section className="rounded-2xl border border-border bg-background">
            <div className="border-b border-border p-4">
              <h2 className="text-base font-bold text-text-primary">
                本机插件
              </h2>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                安装 executor 可选能力。
              </p>
            </div>
            <div className="grid gap-3 p-4">
              <PluginAction
                title="Browser 自动化"
                detail="用于浏览器检查、截图和网页交互。"
                disabled={isBusy}
                onClick={() => onRunAction('install-browser')}
              />
              <PluginAction
                title="Mail 客户端"
                detail="用于本机邮件工作流。"
                disabled={isBusy}
                onClick={() => onRunAction('install-mail')}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-background">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-bold text-text-primary">
                  最近输出
                </h2>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  保留最近一次检测或操作结果。
                </p>
              </div>
              <ExecutorActionButton
                testId="executor-open-logs-button"
                icon={FolderOpen}
                label="打开日志目录"
                loading={state.isOpeningLogs}
                loadingLabel="打开中..."
                disabled={state.isOpeningLogs}
                onClick={onOpenLogs}
              />
            </div>
            <div className="space-y-2 p-4">
              <LogLine
                text={`node: ${node?.version || 'not found'}, path=${
                  node?.path || '--'
                }`}
              />
              <LogLine
                text={`wecode: ${cli?.version || 'not found'}, path=${
                  cli?.path || '--'
                }`}
              />
              <LogLine
                text={`executor: installed=${
                  state.status?.installed ? 'yes' : 'no'
                }, running=${state.status?.running ? 'yes' : 'no'}`}
              />
              <LogLine
                text={`startup env: ${state.envVars.length} variables loaded from local app config`}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function ExecutorPrimaryActionButton({
  testId,
  readiness,
  disabled,
  activeAction,
  onRunAction,
}: {
  testId: string
  readiness: LocalExecutorReadiness
  disabled: boolean
  activeAction: ExecutorAction | null
  onRunAction: (action: ExecutorAction) => void
}) {
  if (readiness === 'cli_missing') {
    return (
      <ExecutorActionButton
        testId={testId}
        icon={Download}
        label="安装 WeCode CLI"
        loading={activeAction === 'install-cli'}
        loadingLabel="安装 CLI 中..."
        disabled={disabled}
        primary
        onClick={() => onRunAction('install-cli')}
      />
    )
  }

  if (readiness === 'executor_missing') {
    return (
      <ExecutorActionButton
        testId={testId}
        icon={Download}
        label="安装 Executor"
        loading={activeAction === 'install'}
        loadingLabel="安装中..."
        disabled={disabled}
        primary
        onClick={() => onRunAction('install')}
      />
    )
  }

  if (readiness === 'executor_running') {
    return (
      <ExecutorActionButton
        testId={testId}
        icon={RefreshCw}
        label="重启 Executor"
        loading={activeAction === 'restart'}
        loadingLabel="重启中..."
        disabled={disabled}
        primary
        onClick={() => onRunAction('restart')}
      />
    )
  }

  return (
    <ExecutorActionButton
      testId={testId}
      icon={Play}
      label="启动 Executor"
      loading={activeAction === 'start'}
      loadingLabel="启动中..."
      disabled={disabled || readiness !== 'executor_stopped'}
      primary
      onClick={() => onRunAction('start')}
    />
  )
}

function LocalSummaryCard({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <article className="min-w-0 rounded-2xl border border-border bg-background p-4">
      <div className="text-sm font-semibold text-text-secondary">{label}</div>
      <div className="mt-3 truncate text-xl font-bold text-text-primary">
        {value}
      </div>
      <div className="mt-2 truncate text-xs text-text-muted">{note}</div>
    </article>
  )
}

function LocalDetailRow({
  label,
  value,
  status,
  tone,
}: {
  label: string
  value: string
  status: string
  tone: 'online' | 'warning' | 'neutral'
}) {
  return (
    <div className="grid gap-2 rounded-xl border border-border bg-surface px-3 py-3 text-sm md:grid-cols-[150px_minmax(0,1fr)_auto] md:items-center">
      <div className="font-semibold text-text-secondary">{label}</div>
      <div className="min-w-0 truncate font-medium text-text-primary">
        {value}
      </div>
      <StatusPill label={status} tone={tone} />
    </div>
  )
}

function EnvVarRow({
  envVar,
  index,
  onChange,
  onDelete,
}: {
  envVar: StartupEnvVar
  index: number
  onChange: (index: number, patch: Partial<StartupEnvVar>) => void
  onDelete: (index: number) => void
}) {
  return (
    <div className="grid gap-2 rounded-xl border border-border bg-surface p-3 lg:grid-cols-[auto_minmax(140px,0.7fr)_minmax(180px,1fr)_auto_auto] lg:items-center">
      <label className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-text-secondary">
        <input
          data-testid={`executor-env-enabled-checkbox-${index}`}
          type="checkbox"
          checked={envVar.enabled}
          onChange={(event) =>
            onChange(index, { enabled: event.target.checked })
          }
        />
        启用
      </label>
      <input
        data-testid={`executor-env-key-input-${index}`}
        value={envVar.key}
        onChange={(event) => onChange(index, { key: event.target.value })}
        placeholder="KEY"
        className="h-10 rounded-md border border-border bg-background px-3 text-sm font-semibold text-text-primary outline-none focus:border-primary"
      />
      <input
        data-testid={`executor-env-value-input-${index}`}
        value={envVar.value}
        type={envVar.sensitive ? 'password' : 'text'}
        onChange={(event) => onChange(index, { value: event.target.value })}
        placeholder="value"
        className="h-10 rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary"
      />
      <label className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-text-secondary">
        <input
          data-testid={`executor-env-sensitive-checkbox-${index}`}
          type="checkbox"
          checked={envVar.sensitive}
          onChange={(event) =>
            onChange(index, { sensitive: event.target.checked })
          }
        />
        敏感
      </label>
      <button
        type="button"
        data-testid={`executor-env-delete-button-${index}`}
        onClick={() => onDelete(index)}
        className="inline-flex h-10 min-w-[44px] items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary"
        aria-label="删除环境变量"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}

function DiagnosticStep({
  index,
  title,
  detail,
}: {
  index: number
  title: string
  detail: string
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">
        {index}
      </div>
      <div className="mt-3 text-sm font-bold text-text-primary">{title}</div>
      <div className="mt-1 text-xs leading-5 text-text-muted">{detail}</div>
    </div>
  )
}

function PluginAction({
  title,
  detail,
  disabled,
  onClick,
}: {
  title: string
  detail: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`executor-plugin-${title}-button`}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-16 items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      <span>
        <span className="block text-sm font-bold text-text-primary">
          {title}
        </span>
        <span className="mt-1 block text-xs leading-5 text-text-muted">
          {detail}
        </span>
      </span>
      <PackagePlus className="h-4 w-4 shrink-0 text-text-secondary" />
    </button>
  )
}

function LogLine({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-text-primary px-3 py-2 font-mono text-xs leading-5 text-background">
      {text}
    </div>
  )
}

function ExecutorActionButton({
  icon: Icon,
  label,
  testId,
  disabled,
  loading = false,
  loadingLabel,
  primary = false,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  testId: string
  disabled: boolean
  loading?: boolean
  loadingLabel?: string
  primary?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-10 min-w-[44px] items-center gap-2 rounded-md px-3 text-sm font-semibold transition disabled:pointer-events-none disabled:opacity-50 ${
        primary
          ? 'bg-text-primary text-background hover:bg-text-primary/90'
          : 'border border-border bg-background text-text-primary hover:bg-muted'
      }`}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Icon className="h-4 w-4" />
      )}
      {loading ? loadingLabel || label : label}
    </button>
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
        使用公司的模型服务代理 Claude 和
        Codex，执行器负责本地/云端运行时，小程序负责办公流程。
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
        <button
          type="button"
          onClick={() => navigateTo('/app/wegent')}
          className="inline-flex h-9 items-center rounded-full border border-border bg-background px-4 text-sm font-semibold text-text-primary hover:bg-muted"
        >
          打开 Wegent
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
          集中查看 executor 运行状态，配置 Claude / Codex
          代理，安装内部应用和第三方小程序。
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
        <div
          className={`grid h-11 w-11 place-items-center rounded-2xl ${app.iconClassName}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <StatusPill label={app.status} tone={app.statusTone} />
      </div>
      <div className="mt-4 text-sm font-bold text-text-primary">
        {app.title}
      </div>
      <p className="mt-2 text-sm leading-6 text-text-secondary">
        {app.description}
      </p>
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
      <div className="text-2xl font-bold tracking-[-0.04em] text-text-primary">
        {value}
      </div>
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
        <div className="truncate text-sm font-semibold text-text-primary">
          {title}
        </div>
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
      description:
        '使用 WeWork 模型服务代理 Claude Code，统一接入账号、模型与运行时环境。',
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
      description:
        '管理 Codex auth.json、代理开关与默认 GPT 模型，可从在线执行器导入认证。',
      icon: Cpu,
      iconClassName: 'bg-gradient-to-br from-slate-900 to-slate-500 text-white',
      status: codexConfigured ? '已认证' : '需认证',
      statusTone: codexConfigured ? 'online' : 'warning',
      meta: codexConfigured ? 'auth.json 已保存' : 'auth.json 缺失',
      action: codexConfigured ? '打开' : '去配置',
      onClick: () => navigateTo('/settings/personal/codex'),
    },
    {
      title: 'Wegent Web',
      description:
        '以 iframe 方式打开主 Web 前端，用于完整 AI 编码、聊天和资源管理场景。',
      icon: Grid3X3,
      iconClassName: 'bg-gradient-to-br from-primary to-sky-500 text-white',
      status: '内置',
      statusTone: 'online',
      meta: 'iframe app',
      action: '打开新 tab',
      onClick: () => navigateTo('/app/wegent'),
    },
  ]
}

export function AppsPage() {
  const { t } = useTranslation('common')
  const [state, setState] = useState<AppsPageState>(initialState)
  const [localExecutorState, setLocalExecutorState] =
    useState<LocalExecutorState>(initialLocalExecutorState)
  const [activeSection, setActiveSection] = useState<AppsSection>('overview')
  const [headerCollapseProgress, setHeaderCollapseProgress] = useState(0)
  const scrollFrameRef = useRef<number | null>(null)
  const envSaveTimerRef = useRef<number | null>(null)
  const envSaveGenerationRef = useRef(0)
  const lastSavedEnvSnapshotRef = useRef<string | null>(null)

  const refreshLocalExecutor = useCallback(async () => {
    setLocalExecutorState((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
      message: null,
    }))

    try {
      const [status, envVars] = await Promise.all([
        getLocalExecutorStatus(),
        getStartupEnv(),
      ])
      lastSavedEnvSnapshotRef.current = JSON.stringify(envVars)
      setLocalExecutorState((prev) => ({
        ...prev,
        status,
        envVars,
        isLoading: false,
        isSavingEnv: false,
        error: null,
        message: null,
      }))
    } catch (error) {
      setLocalExecutorState((prev) => ({
        ...prev,
        isLoading: false,
        error:
          error instanceof Error ? error.message : '本机 executor 检测失败',
      }))
    }
  }, [])

  const runExecutorAction = useCallback(
    async (action: ExecutorAction) => {
      setLocalExecutorState((prev) => ({
        ...prev,
        isMutating: true,
        activeAction: action,
        error: null,
        message: null,
        commandOutput:
          action === 'install-cli'
            ? '$ 安装 WeCode CLI\n'
            : `$ wecode executor ${action}\n`,
        commandSucceeded: null,
        commandExitCode: null,
      }))

      try {
        if (action === 'start' || action === 'restart') {
          if (!canSaveEnvVars(localExecutorState.envVars)) {
            throw new Error('请先填写合法的环境变量名')
          }

          const envVars = await saveStartupEnv(localExecutorState.envVars)
          lastSavedEnvSnapshotRef.current = JSON.stringify(envVars)
        }

        await waitForNextPaint()
        const appendCommandOutput = (output: ExecutorCommandOutput) => {
          setLocalExecutorState((prev) => ({
            ...prev,
            commandOutput: `${prev.commandOutput}${output.content}`,
          }))
        }
        const [result] = await Promise.all([
          runLocalExecutorAction(action, appendCommandOutput),
          waitForDuration(EXECUTOR_ACTION_MIN_FEEDBACK_MS),
        ])
        await refreshLocalExecutor()
        setLocalExecutorState((prev) => ({
          ...prev,
          isMutating: false,
          activeAction: null,
          commandSucceeded: result.success,
          commandExitCode: result.code,
          error: result.success
            ? null
            : getCommandOutput(result) || 'Executor 操作失败',
          message: null,
        }))
      } catch (error) {
        setLocalExecutorState((prev) => ({
          ...prev,
          isMutating: false,
          activeAction: null,
          commandSucceeded: false,
          commandExitCode: null,
          commandOutput: `${prev.commandOutput}\n${
            error instanceof Error ? error.message : 'Executor 操作失败'
          }\n`,
          error: error instanceof Error ? error.message : 'Executor 操作失败',
        }))
      }
    },
    [localExecutorState.envVars, refreshLocalExecutor],
  )

  const openExecutorLogs = useCallback(async () => {
    setLocalExecutorState((prev) => ({
      ...prev,
      isOpeningLogs: true,
      error: null,
      message: null,
    }))

    try {
      await openExecutorLogsDirectory()
      setLocalExecutorState((prev) => ({
        ...prev,
        isOpeningLogs: false,
        message: '日志目录已打开',
      }))
    } catch (error) {
      setLocalExecutorState((prev) => ({
        ...prev,
        isOpeningLogs: false,
        error: error instanceof Error ? error.message : '日志目录打开失败',
      }))
    }
  }, [])

  const changeExecutorEnv = useCallback(
    (index: number, patch: Partial<StartupEnvVar>) => {
      setLocalExecutorState((prev) => ({
        ...prev,
        envVars: prev.envVars.map((envVar, currentIndex) =>
          currentIndex === index ? { ...envVar, ...patch } : envVar,
        ),
      }))
    },
    [],
  )

  const addExecutorEnv = useCallback(() => {
    setLocalExecutorState((prev) => ({
      ...prev,
      envExpanded: true,
      envVars: [
        ...prev.envVars,
        { key: '', value: '', enabled: true, sensitive: false },
      ],
    }))
  }, [])

  const deleteExecutorEnv = useCallback((index: number) => {
    setLocalExecutorState((prev) => ({
      ...prev,
      envVars: prev.envVars.filter((_, currentIndex) => currentIndex !== index),
    }))
  }, [])

  const toggleExecutorEnvExpanded = useCallback(() => {
    setLocalExecutorState((prev) => ({
      ...prev,
      envExpanded: !prev.envExpanded,
    }))
  }, [])

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
        setState({
          devices,
          codexConfig,
          proxyConfig,
          isLoading: false,
          error: null,
        })
      })
      .catch((error) => {
        if (cancelled) return
        setState((prev) => ({
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
    refreshLocalExecutor()
  }, [refreshLocalExecutor])

  useEffect(() => {
    if (localExecutorState.isLoading) return

    const envVars = localExecutorState.envVars
    const snapshot = JSON.stringify(envVars)
    if (snapshot === lastSavedEnvSnapshotRef.current) return

    envSaveGenerationRef.current += 1
    const generation = envSaveGenerationRef.current

    if (envSaveTimerRef.current !== null) {
      window.clearTimeout(envSaveTimerRef.current)
      envSaveTimerRef.current = null
    }

    if (!canSaveEnvVars(envVars)) {
      setLocalExecutorState((prev) => ({ ...prev, isSavingEnv: false }))
      return
    }

    envSaveTimerRef.current = window.setTimeout(async () => {
      setLocalExecutorState((prev) => ({
        ...prev,
        isSavingEnv: true,
        error: null,
        message: null,
      }))

      try {
        await saveStartupEnv(envVars)
        if (envSaveGenerationRef.current !== generation) return

        lastSavedEnvSnapshotRef.current = snapshot
        setLocalExecutorState((prev) => ({
          ...prev,
          isSavingEnv: false,
          message: '环境变量已自动保存，重启 Executor 后生效',
        }))
      } catch (error) {
        if (envSaveGenerationRef.current !== generation) return

        setLocalExecutorState((prev) => ({
          ...prev,
          isSavingEnv: false,
          error: error instanceof Error ? error.message : '环境变量保存失败',
        }))
      }
    }, ENV_AUTO_SAVE_DELAY_MS)

    return () => {
      if (envSaveTimerRef.current !== null) {
        window.clearTimeout(envSaveTimerRef.current)
        envSaveTimerRef.current = null
      }
    }
  }, [localExecutorState.envVars, localExecutorState.isLoading])

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

  return (
    <div
      data-testid="apps-page"
      className="grid h-full min-h-0 grid-cols-1 gap-1.5 overflow-hidden bg-transparent p-1.5 xl:grid-cols-[220px_minmax(0,1fr)]"
    >
      <SidebarNav activeSection={activeSection} onSelect={setActiveSection} />

      <section
        data-testid="apps-scroll-container"
        className="min-w-0 overflow-auto rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]"
        onScroll={handleScroll}
      >
        <AppsPageHeader collapseProgress={headerCollapseProgress} />
        <SectionTabs
          activeSection={activeSection}
          onSelect={setActiveSection}
        />

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
          ) : activeSection === 'local-management' ? (
            <LocalManagementPage
              state={localExecutorState}
              devices={state.devices}
              onRefresh={refreshLocalExecutor}
              onRunAction={runExecutorAction}
              onOpenLogs={openExecutorLogs}
              onChangeEnv={changeExecutorEnv}
              onAddEnv={addExecutorEnv}
              onDeleteEnv={deleteExecutorEnv}
              onToggleEnvExpanded={toggleExecutorEnvExpanded}
            />
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
                  {recommendedApps.map((app) => (
                    <AppCard key={app.title} app={app} />
                  ))}
                </div>
              </section>

              <section className="mt-6">
                <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">
                  运行概览
                </h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <SummaryCard value={`${onlineCount}`} label="在线执行器" />
                  <SummaryCard value="3" label="内置应用" />
                  <SummaryCard
                    value={`${slotUsage.total || 0}`}
                    label="可用任务槽位"
                  />
                  <SummaryCard
                    value={state.proxyConfig?.configured ? '已配置' : '未配置'}
                    label="模型代理"
                  />
                </div>
              </section>

              <section className="mt-6">
                <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">
                  快速入口
                </h2>
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <QuickAction
                    icon={Server}
                    title="本机管理"
                    detail="检测 Node、CLI 和本机 Executor"
                  />
                  <QuickAction
                    icon={Network}
                    title="模型代理"
                    detail="配置公司代理服务"
                  />
                  <QuickAction
                    icon={Grid3X3}
                    title="内置应用"
                    detail="打开 Wegent、Codex 等工作入口"
                  />
                  <QuickAction
                    icon={ShieldCheck}
                    title="权限与认证"
                    detail="管理 Codex 与应用授权"
                  />
                </div>
              </section>

              <section className="mt-6">
                <h2 className="text-lg font-bold tracking-[-0.02em] text-text-primary">
                  最近活动
                </h2>
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

function PlaceholderSection({
  title,
  detail,
}: {
  title: string
  detail: string
}) {
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
