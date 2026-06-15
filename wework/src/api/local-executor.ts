import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauriRuntime } from '@/lib/runtime-environment'

export type ExecutorAction =
  | 'install-cli'
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'upgrade'
  | 'install-browser'
  | 'install-mail'

export interface WecodeCliStatus {
  available: boolean
  path: string | null
  version: string | null
  error: string | null
}

export interface NodeStatus {
  available: boolean
  path: string | null
  version: string | null
  major_version: number | null
  meets_minimum: boolean
  error: string | null
}

export interface StartupEnvVar {
  key: string
  value: string
  enabled: boolean
  sensitive: boolean
}

export interface WecodeCommandResult {
  success: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface ExecutorCommandOutput {
  execution_id: string
  stream: 'stdout' | 'stderr'
  content: string
}

export interface ExecutorStatus {
  node: NodeStatus
  cli: WecodeCliStatus
  installed: boolean
  running: boolean
  pid: number | null
  version: string | null
  output: string
  error: string | null
}

export type LocalExecutorReadiness =
  | 'desktop_only'
  | 'node_missing'
  | 'cli_missing'
  | 'executor_missing'
  | 'executor_stopped'
  | 'executor_running'

export function getExecutorReadiness(
  status: ExecutorStatus | null,
): LocalExecutorReadiness {
  if (!isTauriRuntime()) return 'desktop_only'
  if (!status?.node.available || !status.node.meets_minimum)
    return 'node_missing'
  if (!status?.cli.available) return 'cli_missing'
  if (!status.installed) return 'executor_missing'
  return status.running ? 'executor_running' : 'executor_stopped'
}

export function getWecodeInstallCommand(): string {
  const platform = window.navigator.platform.toLowerCase()
  const isWindows = platform.includes('win')

  if (isWindows) {
    return '$t=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); Invoke-WebRequest -UseBasicParsing -Uri "https://git.intra.weibo.com/api/v4/projects/weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/repository/files/scripts%2Finstall.ps1/raw?ref=master&_t=$t" -Headers @{"PRIVATE-TOKEN"="<your-token>";"Cache-Control"="no-cache"} -OutFile "$env:TEMP\\install.ps1"; pwsh -ExecutionPolicy Bypass -File "$env:TEMP\\install.ps1"'
  }

  return 'curl -fsSL -H "PRIVATE-TOKEN: <your-token>" "https://git.intra.weibo.com/api/v4/projects/weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/repository/files/scripts%2Finstall.sh/raw?ref=master" | bash'
}

export async function getLocalExecutorStatus(): Promise<ExecutorStatus | null> {
  if (!isTauriRuntime()) return null
  return invoke<ExecutorStatus>('get_executor_status')
}

export async function getStartupEnv(): Promise<StartupEnvVar[]> {
  if (!isTauriRuntime()) return []
  return invoke<StartupEnvVar[]>('get_startup_env')
}

export async function saveStartupEnv(
  envVars: StartupEnvVar[],
): Promise<StartupEnvVar[]> {
  if (!isTauriRuntime()) return envVars
  return invoke<StartupEnvVar[]>('save_startup_env', { envVars })
}

export async function runLocalExecutorAction(
  action: ExecutorAction,
  onOutput: (output: ExecutorCommandOutput) => void,
): Promise<WecodeCommandResult> {
  if (!isTauriRuntime()) {
    throw new Error('Executor management is only available in the desktop app')
  }

  const executionId = crypto.randomUUID()
  const unlisten = await listen<ExecutorCommandOutput>(
    'executor-command-output',
    ({ payload }) => {
      if (payload.execution_id === executionId) {
        onOutput(payload)
      }
    },
  )

  try {
    return await invoke<WecodeCommandResult>('run_executor_command', {
      action,
      executionId,
    })
  } finally {
    unlisten()
  }
}

export async function openExecutorLogsDirectory(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('Executor logs are only available in the desktop app')
  }

  return invoke<void>('open_executor_logs_directory')
}
