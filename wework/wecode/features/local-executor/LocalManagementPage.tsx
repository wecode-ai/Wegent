import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  PackagePlus,
  Play,
  Power,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import {
  getExecutorReadiness,
  getWecodeInstallCommand,
  type ExecutorAction,
  type ExecutorProcessDiagnostics,
  type LocalExecutorReadiness,
  type StartupEnvVar,
} from '@wecode/api/local-executor'
import type { DeviceInfo } from '@/types/api'
import { canSaveEnvVars, type LocalExecutorState } from './localManagementState'

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

function getCleanupProcessPids(
  diagnostics: ExecutorProcessDiagnostics | null,
  currentExecutorPid: number | null
): number[] {
  if (!diagnostics) return []

  const pids = new Set<number>()
  diagnostics.port_occupants
    .filter(occupant => occupant.is_executor_like && occupant.pid !== currentExecutorPid)
    .filter(occupant => !processBelongsToPid(occupant.pid, currentExecutorPid, diagnostics))
    .forEach(occupant => pids.add(occupant.pid))

  return [...pids]
}

function processBelongsToPid(
  pid: number,
  rootPid: number | null,
  diagnostics: ExecutorProcessDiagnostics | null
): boolean {
  if (!rootPid || !diagnostics) return false
  if (pid === rootPid) return true

  let currentPid = pid
  for (let index = 0; index < 32; index += 1) {
    const process = diagnostics.processes.find(item => item.pid === currentPid)
    if (!process?.parent_pid) return false
    if (process.parent_pid === rootPid) return true
    if (process.parent_pid === currentPid) return false
    currentPid = process.parent_pid
  }

  return false
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
            isRunning ? 'text-amber-300' : succeeded === false ? 'text-red-300' : 'text-zinc-400'
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
  return devices.some(device => device.device_type === 'local' && device.status !== 'offline')
}

export function LocalManagementPage({
  state,
  devices,
  onRefresh,
  onRunAction,
  onOpenLogs,
  onCleanProcesses,
  onChangeEnv,
  onAddEnv,
  onDeleteEnv,
  onToggleEnvExpanded,
  advancedSettingsEnabled,
  onTitleClick,
}: {
  state: LocalExecutorState
  devices: DeviceInfo[]
  onRefresh: () => void
  onRunAction: (action: ExecutorAction) => void
  onOpenLogs: () => void
  onCleanProcesses: (pids: number[]) => void
  onChangeEnv: (index: number, patch: Partial<StartupEnvVar>) => void
  onAddEnv: () => void
  onDeleteEnv: (index: number) => void
  onToggleEnvExpanded: () => void
  advancedSettingsEnabled: boolean
  onTitleClick: () => void
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
  const currentExecutorPid = state.status?.pid ?? null
  const cleanupProcessPids = getCleanupProcessPids(state.diagnostics, currentExecutorPid)

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
          <h1
            data-testid="local-management-title"
            className="mt-1 text-2xl font-bold tracking-[-0.02em] text-text-primary"
            onClick={onTitleClick}
          >
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
            note={node?.meets_minimum ? '满足 Node >= 20' : node?.error || '需要 Node >= 20'}
          />
          <LocalSummaryCard
            label="WeCode CLI"
            value={cli?.version?.replace('wecode-cli version: ', '') || '未检测'}
            note={cli?.path || cli?.error || '等待检测'}
          />
          <LocalSummaryCard
            label="Executor"
            value={state.status?.running ? '运行中' : state.status?.installed ? '已停止' : '未安装'}
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
                <h2 className="text-base font-bold text-text-primary">本机依赖检测</h2>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  启动前检查 Node、CLI、Executor 二进制、登录用户和 Backend URL。
                </p>
              </div>
              <StatusPill label={copy.label} tone={copy.tone} />
            </div>
            <div className="space-y-3 p-4">
              <LocalDetailRow
                label="Node.js"
                value={
                  node?.path ? `${node.path} · ${node.version || '--'}` : node?.error || '未检测到'
                }
                status={node?.meets_minimum ? '通过' : '需安装'}
                tone={node?.meets_minimum ? 'online' : 'warning'}
              />
              <LocalDetailRow
                label="WeCode CLI"
                value={
                  cli?.path ? `${cli.path} · ${cli.version || '--'}` : cli?.error || '未检测到'
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
                value={online ? 'Backend /devices 已存在在线 local device' : '暂未看到在线本机设备'}
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
              <ProcessDiagnosticsPanel
                diagnostics={state.diagnostics}
                currentExecutorPid={currentExecutorPid}
                cleanupPids={cleanupProcessPids}
                isCleaning={state.isCleaningProcesses}
                onCleanProcesses={onCleanProcesses}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-background">
            <div className="border-b border-border p-4">
              <h2 className="text-base font-bold text-text-primary">快捷操作</h2>
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
                disabled={isBusy || readiness === 'desktop_only' || readiness === 'cli_missing'}
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
                disabled={isBusy || readiness === 'desktop_only' || readiness === 'cli_missing'}
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

        {advancedSettingsEnabled ? (
          <>
            <section className="mt-4 rounded-2xl border border-border bg-background">
              <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-base font-bold text-text-primary">启动环境变量</h2>
                  <p className="mt-1 text-xs leading-5 text-text-muted">
                    启动 executor 时自动注入。多于 4 项时默认折叠，展开后可查看全部。
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
                        className={`h-4 w-4 transition ${state.envExpanded ? 'rotate-180' : ''}`}
                      />
                      {state.envExpanded ? '收起环境变量' : `展开全部 ${state.envVars.length} 项`}
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
                    tone={!envVarsSavable || state.isSavingEnv ? 'warning' : 'neutral'}
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
                  <h2 className="text-base font-bold text-text-primary">连接诊断</h2>
                  <p className="mt-1 text-xs leading-5 text-text-muted">
                    把 Node、CLI、进程和 Backend 在线状态拆开显示。
                  </p>
                </div>
                <StatusPill label="5 步检查" tone="neutral" />
              </div>
              <div className="grid gap-3 p-4 md:grid-cols-5">
                <DiagnosticStep index={1} title="Node 可用" detail="Node >= 20，路径可执行。" />
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
                  <h2 className="text-base font-bold text-text-primary">本机插件</h2>
                  <p className="mt-1 text-xs leading-5 text-text-muted">安装 executor 可选能力。</p>
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
                    <h2 className="text-base font-bold text-text-primary">最近输出</h2>
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
                    text={`node: ${node?.version || 'not found'}, path=${node?.path || '--'}`}
                  />
                  <LogLine
                    text={`wecode: ${cli?.version || 'not found'}, path=${cli?.path || '--'}`}
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
          </>
        ) : null}
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

function LocalSummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="min-w-0 rounded-2xl border border-border bg-background p-4">
      <div className="text-sm font-semibold text-text-secondary">{label}</div>
      <div className="mt-3 truncate text-xl font-bold text-text-primary">{value}</div>
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
      <div className="min-w-0 truncate font-medium text-text-primary">{value}</div>
      <StatusPill label={status} tone={tone} />
    </div>
  )
}

function ProcessDiagnosticsPanel({
  diagnostics,
  currentExecutorPid,
  cleanupPids,
  isCleaning,
  onCleanProcesses,
}: {
  diagnostics: ExecutorProcessDiagnostics | null
  currentExecutorPid: number | null
  cleanupPids: number[]
  isCleaning: boolean
  onCleanProcesses: (pids: number[]) => void
}) {
  const executorCount = diagnostics?.processes.length ?? 0
  const portCount = diagnostics?.port_occupants.length ?? 0
  const hasCleanup = cleanupPids.length > 0

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-bold text-text-primary">进程与端口诊断</div>
          <div className="mt-1 text-xs leading-5 text-text-muted">
            检测本机 wegent-executor 进程和 Gateway 端口占用。
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill
            label={`Executor 进程 ${executorCount} 个`}
            tone={executorCount > 1 ? 'warning' : executorCount === 1 ? 'online' : 'neutral'}
          />
          <StatusPill
            label={`端口占用 ${portCount} 个`}
            tone={portCount > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </div>

      {diagnostics?.error && (
        <div className="mt-3 rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-xs leading-5 text-orange-600">
          {diagnostics.error}
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ProcessList
          title="Executor 进程"
          emptyText="未检测到 wegent-executor 进程"
          rows={(diagnostics?.processes ?? []).map(process => ({
            pid: process.pid,
            title: processBelongsToPid(process.pid, currentExecutorPid, diagnostics)
              ? `PID ${process.pid} · 当前运行`
              : `PID ${process.pid}`,
            detail: process.command,
            tone: processBelongsToPid(process.pid, currentExecutorPid, diagnostics)
              ? ('online' as const)
              : ('warning' as const),
          }))}
        />
        <ProcessList
          title="Gateway 端口监听"
          emptyText="Gateway 端口未被占用"
          rows={(diagnostics?.port_occupants ?? []).map(occupant => ({
            pid: occupant.pid,
            title: `PID ${occupant.pid} · :${occupant.port}`,
            detail: occupant.command,
            tone: processBelongsToPid(occupant.pid, currentExecutorPid, diagnostics)
              ? ('online' as const)
              : occupant.is_executor_like
                ? ('warning' as const)
                : ('neutral' as const),
          }))}
        />
      </div>

      {hasCleanup && (
        <button
          type="button"
          data-testid="executor-clean-processes-button"
          disabled={isCleaning}
          onClick={() => onCleanProcesses(cleanupPids)}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-text-primary hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          {isCleaning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          {isCleaning ? '清理中...' : `清理残留进程 ${cleanupPids.join(', ')}`}
        </button>
      )}
    </div>
  )
}

function ProcessList({
  title,
  emptyText,
  rows,
}: {
  title: string
  emptyText: string
  rows: Array<{
    pid: number
    title: string
    detail: string
    tone: 'online' | 'warning' | 'neutral'
  }>
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs font-bold text-text-secondary">{title}</div>
      <div className="mt-2 space-y-2">
        {rows.length === 0 ? (
          <div className="text-xs leading-5 text-text-muted">{emptyText}</div>
        ) : (
          rows.map(row => (
            <div key={`${title}-${row.pid}`} className="min-w-0 rounded-md bg-surface px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-text-primary">{row.title}</span>
                <StatusPill label={row.tone === 'online' ? '当前' : '需检查'} tone={row.tone} />
              </div>
              <div
                className="mt-1 truncate font-mono text-[11px] leading-5 text-text-muted"
                title={row.detail}
              >
                {row.detail || '--'}
              </div>
            </div>
          ))
        )}
      </div>
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
          onChange={event => onChange(index, { enabled: event.target.checked })}
        />
        启用
      </label>
      <input
        data-testid={`executor-env-key-input-${index}`}
        value={envVar.key}
        onChange={event => onChange(index, { key: event.target.value })}
        placeholder="KEY"
        className="h-10 rounded-md border border-border bg-background px-3 text-sm font-semibold text-text-primary outline-none focus:border-primary"
      />
      <input
        data-testid={`executor-env-value-input-${index}`}
        value={envVar.value}
        type={envVar.sensitive ? 'password' : 'text'}
        onChange={event => onChange(index, { value: event.target.value })}
        placeholder="value"
        className="h-10 rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary"
      />
      <label className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-text-secondary">
        <input
          data-testid={`executor-env-sensitive-checkbox-${index}`}
          type="checkbox"
          checked={envVar.sensitive}
          onChange={event => onChange(index, { sensitive: event.target.checked })}
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
        <span className="block text-sm font-bold text-text-primary">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-text-muted">{detail}</span>
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
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {loading ? loadingLabel || label : label}
    </button>
  )
}
