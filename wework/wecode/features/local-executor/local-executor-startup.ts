import {
  getLocalExecutorStatus,
  runLocalExecutorAction,
  type ExecutorStatus,
} from '@wecode/api/local-executor'

export type StartupCheckTone = 'checking' | 'success' | 'warning' | 'error'
export type StartupStepTone = 'pending' | 'running' | 'success' | 'warning' | 'error'

export interface StartupCheckStep {
  id: string
  title: string
  detail: string
  tone: StartupStepTone
  logs?: string
}

export interface LocalExecutorStartupState {
  tone: StartupCheckTone
  label: string
  progress: number
  steps: StartupCheckStep[]
}

const initialState: LocalExecutorStartupState = {
  tone: 'checking',
  label: '准备检测本机环境',
  progress: 0,
  steps: [],
}

let state = initialState
let startupPromise: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(nextState: LocalExecutorStartupState) {
  state = nextState
  listeners.forEach(listener => listener())
}

function updateState(patch: Partial<LocalExecutorStartupState>) {
  emit({ ...state, ...patch })
}

function appendStep(step: StartupCheckStep) {
  updateState({ steps: [...state.steps, step] })
}

function updateStep(id: string, patch: Partial<StartupCheckStep>) {
  updateState({
    steps: state.steps.map(step => (step.id === id ? { ...step, ...patch } : step)),
  })
}

function appendStepLog(id: string, content: string) {
  if (!content) return
  updateState({
    steps: state.steps.map(step =>
      step.id === id ? { ...step, logs: (step.logs ?? '') + content } : step
    ),
  })
}

function executorStatusDetail(status: ExecutorStatus): string {
  if (!status.installed) return '未安装 Executor'
  if (status.running) {
    return status.pid ? `正在运行，PID ${status.pid}` : '正在运行'
  }
  return '已安装，当前未运行'
}

async function revealStep(step: StartupCheckStep, progress: number, label = step.title) {
  appendStep(step)
  updateState({
    label,
    progress,
  })
  await new Promise(resolve => window.setTimeout(resolve, 120))
}

function commandError(result: { stdout: string; stderr: string }, fallback: string) {
  return result.stderr || result.stdout || fallback
}

async function runStartupCheck() {
  updateState(initialState)

  let status: ExecutorStatus | null
  try {
    status = await getLocalExecutorStatus()
  } catch (error) {
    updateState({
      tone: 'error',
      label: '本机环境检测失败',
      progress: 100,
      steps: [
        {
          id: 'detection',
          title: '检测本机环境',
          detail: error instanceof Error ? error.message : '无法读取本机环境',
          tone: 'error',
        },
      ],
    })
    return
  }

  if (!status) {
    updateState({
      tone: 'warning',
      label: '仅桌面 App 支持本机检测',
      progress: 100,
    })
    return
  }

  await revealStep(
    {
      id: 'node',
      title: '检测 Node.js',
      detail: status.node.available
        ? `${status.node.version || '版本未知'}${
            status.node.meets_minimum ? '，满足 Node >= 20' : '，需要 Node >= 20'
          }`
        : status.node.error || '未检测到 Node.js',
      tone: status.node.meets_minimum ? 'success' : 'error',
    },
    25,
    '正在检测 Node.js'
  )

  if (!status.node.meets_minimum) {
    updateState({
      tone: 'error',
      label: 'Node.js 需要处理',
      progress: 100,
    })
    return
  }

  await revealStep(
    {
      id: 'cli',
      title: '检测 WeCode CLI',
      detail: status.cli.available
        ? `${status.cli.version || '版本未知'}，已找到可执行文件`
        : status.cli.error || '未安装 WeCode CLI',
      tone: status.cli.available ? 'success' : 'error',
    },
    40,
    '正在检测 WeCode CLI'
  )

  if (!status.cli.available) {
    await revealStep(
      {
        id: 'install-cli',
        title: '自动安装 WeCode CLI',
        detail: '正在下载安装 WeCode CLI...',
        tone: 'running',
      },
      50,
      '正在安装 WeCode CLI'
    )

    try {
      const installCliResult = await runLocalExecutorAction('install-cli', output =>
        appendStepLog('install-cli', output.content)
      )
      if (!installCliResult.success) {
        updateStep('install-cli', {
          detail: commandError(installCliResult, 'WeCode CLI 安装失败'),
          tone: 'error',
        })
        updateState({
          tone: 'error',
          label: 'WeCode CLI 安装失败',
          progress: 100,
        })
        return
      }

      status = await getLocalExecutorStatus()
      if (!status?.cli.available) {
        updateStep('install-cli', {
          detail: '安装命令已完成，但仍未检测到 WeCode CLI',
          tone: 'error',
        })
        updateState({
          tone: 'error',
          label: 'WeCode CLI 安装失败',
          progress: 100,
        })
        return
      }

      updateStep('cli', {
        detail: `${status.cli.version || '版本未知'}，安装成功`,
        tone: 'success',
      })
      updateStep('install-cli', {
        detail: 'WeCode CLI 安装完成',
        tone: 'success',
      })
    } catch (error) {
      updateStep('install-cli', {
        detail: error instanceof Error ? error.message : 'WeCode CLI 安装失败',
        tone: 'error',
      })
      updateState({
        tone: 'error',
        label: 'WeCode CLI 安装失败',
        progress: 100,
      })
      return
    }
  }

  await revealStep(
    {
      id: 'executor',
      title: '检测 Executor 状态',
      detail: executorStatusDetail(status),
      tone: status.installed ? 'success' : 'warning',
    },
    65,
    '正在检测 Executor'
  )

  if (!status.installed) {
    await revealStep(
      {
        id: 'install-executor',
        title: '自动安装 Executor',
        detail: '正在安装本机 Executor...',
        tone: 'running',
      },
      75,
      '正在安装 Executor'
    )

    try {
      const installExecutorResult = await runLocalExecutorAction('install', output =>
        appendStepLog('install-executor', output.content)
      )
      if (!installExecutorResult.success) {
        updateStep('install-executor', {
          detail: commandError(installExecutorResult, 'Executor 安装失败'),
          tone: 'error',
        })
        updateState({
          tone: 'error',
          label: 'Executor 安装失败',
          progress: 100,
        })
        return
      }

      status = await getLocalExecutorStatus()
      if (!status?.installed) {
        updateStep('install-executor', {
          detail: '安装命令已完成，但仍未检测到 Executor',
          tone: 'error',
        })
        updateState({
          tone: 'error',
          label: 'Executor 安装失败',
          progress: 100,
        })
        return
      }

      updateStep('executor', {
        detail: executorStatusDetail(status),
        tone: 'success',
      })
      updateStep('install-executor', {
        detail: 'Executor 安装完成',
        tone: 'success',
      })
    } catch (error) {
      updateStep('install-executor', {
        detail: error instanceof Error ? error.message : 'Executor 安装失败',
        tone: 'error',
      })
      updateState({
        tone: 'error',
        label: 'Executor 安装失败',
        progress: 100,
      })
      return
    }
  }

  if (status.running) {
    await revealStep(
      {
        id: 'start',
        title: '确认 Executor 运行状态',
        detail: 'Executor 已运行，无需重复启动',
        tone: 'success',
      },
      100,
      '正在确认 Executor 状态'
    )
    updateState({ tone: 'success', label: '本机环境已就绪' })
    return
  }

  await revealStep(
    {
      id: 'start',
      title: '自动启动 Executor',
      detail: '正在启动本机服务...',
      tone: 'running',
    },
    90,
    '正在启动 Executor'
  )

  try {
    const result = await runLocalExecutorAction('start', output =>
      appendStepLog('start', output.content)
    )
    if (!result.success) {
      updateStep('start', {
        detail: commandError(result, 'Executor 启动失败'),
        tone: 'error',
      })
      updateState({
        tone: 'error',
        label: 'Executor 启动失败',
        progress: 100,
      })
      return
    }

    const refreshedStatus = await getLocalExecutorStatus()
    if (!refreshedStatus?.running) {
      updateStep('start', {
        detail: '启动命令已完成，但未检测到运行中的 Executor',
        tone: 'error',
      })
      updateState({
        tone: 'error',
        label: 'Executor 启动失败',
        progress: 100,
      })
      return
    }

    updateStep('start', {
      detail: refreshedStatus.pid ? `启动成功，PID ${refreshedStatus.pid}` : '启动成功',
      tone: 'success',
    })
    updateState({
      tone: 'success',
      label: '本机环境已就绪',
      progress: 100,
    })
  } catch (error) {
    updateStep('start', {
      detail: error instanceof Error ? error.message : 'Executor 启动失败',
      tone: 'error',
    })
    updateState({
      tone: 'error',
      label: 'Executor 启动失败',
      progress: 100,
    })
  }
}

export function startLocalExecutorStartupCheck(): Promise<void> {
  startupPromise ??= runStartupCheck()
  return startupPromise
}

export function resetLocalExecutorStartupCheck(): Promise<void> {
  startupPromise = runStartupCheck()
  return startupPromise
}

export function subscribeLocalExecutorStartup(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLocalExecutorStartupSnapshot() {
  return state
}
