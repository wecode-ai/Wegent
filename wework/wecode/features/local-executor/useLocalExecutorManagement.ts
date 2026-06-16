import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getExecutorProcessDiagnostics,
  getLocalExecutorStatus,
  getStartupEnv,
  killExecutorProcesses,
  openExecutorLogsDirectory,
  runLocalExecutorAction,
  saveStartupEnv,
  type ExecutorAction,
  type ExecutorCommandOutput,
  type StartupEnvVar,
} from '@wecode/api/local-executor'
import {
  canSaveEnvVars,
  initialLocalExecutorState,
  type LocalExecutorState,
} from './LocalManagementPage'

const EXECUTOR_ACTION_MIN_FEEDBACK_MS = 400
const ENV_AUTO_SAVE_DELAY_MS = 500

function waitForNextPaint(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

function waitForDuration(durationMs: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, durationMs))
}

function getCommandOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

export function useLocalExecutorManagement() {
  const [state, setState] = useState<LocalExecutorState>(initialLocalExecutorState)
  const envSaveTimerRef = useRef<number | null>(null)
  const envSaveGenerationRef = useRef(0)
  const lastSavedEnvSnapshotRef = useRef<string | null>(null)

  const refreshLocalExecutor = useCallback(async () => {
    setState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
      message: null,
    }))

    try {
      const [status, envVars, diagnostics] = await Promise.all([
        getLocalExecutorStatus(),
        getStartupEnv(),
        getExecutorProcessDiagnostics(),
      ])
      lastSavedEnvSnapshotRef.current = JSON.stringify(envVars)
      setState(prev => ({
        ...prev,
        status,
        diagnostics,
        envVars,
        isLoading: false,
        isSavingEnv: false,
        error: null,
        message: null,
      }))
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : '本机 executor 检测失败',
      }))
    }
  }, [])

  const runExecutorAction = useCallback(
    async (action: ExecutorAction) => {
      setState(prev => ({
        ...prev,
        isMutating: true,
        activeAction: action,
        error: null,
        message: null,
        commandOutput:
          action === 'install-cli' ? '$ 安装 WeCode CLI\n' : `$ wecode executor ${action}\n`,
        commandSucceeded: null,
        commandExitCode: null,
      }))

      try {
        if (action === 'start' || action === 'restart') {
          if (!canSaveEnvVars(state.envVars)) {
            throw new Error('请先填写合法的环境变量名')
          }

          const envVars = await saveStartupEnv(state.envVars)
          lastSavedEnvSnapshotRef.current = JSON.stringify(envVars)
        }

        await waitForNextPaint()
        const appendCommandOutput = (output: ExecutorCommandOutput) => {
          setState(prev => ({
            ...prev,
            commandOutput: `${prev.commandOutput}${output.content}`,
          }))
        }
        const [result] = await Promise.all([
          runLocalExecutorAction(action, appendCommandOutput),
          waitForDuration(EXECUTOR_ACTION_MIN_FEEDBACK_MS),
        ])
        await refreshLocalExecutor()
        setState(prev => ({
          ...prev,
          isMutating: false,
          activeAction: null,
          commandSucceeded: result.success,
          commandExitCode: result.code,
          error: result.success ? null : getCommandOutput(result) || 'Executor 操作失败',
          message: null,
        }))
      } catch (error) {
        setState(prev => ({
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
    [state.envVars, refreshLocalExecutor]
  )

  const openExecutorLogs = useCallback(async () => {
    setState(prev => ({
      ...prev,
      isOpeningLogs: true,
      error: null,
      message: null,
    }))

    try {
      await openExecutorLogsDirectory()
      setState(prev => ({
        ...prev,
        isOpeningLogs: false,
        message: '日志目录已打开',
      }))
    } catch (error) {
      setState(prev => ({
        ...prev,
        isOpeningLogs: false,
        error: error instanceof Error ? error.message : '日志目录打开失败',
      }))
    }
  }, [])

  const cleanExecutorProcesses = useCallback(
    async (pids: number[]) => {
      if (pids.length === 0) return

      setState(prev => ({
        ...prev,
        isCleaningProcesses: true,
        error: null,
        message: null,
      }))

      try {
        const result = await killExecutorProcesses(pids)
        await refreshLocalExecutor()
        setState(prev => ({
          ...prev,
          isCleaningProcesses: false,
          error: result.success ? null : getCommandOutput(result) || '残留进程清理失败',
          message: result.success ? getCommandOutput(result) || '残留进程已清理' : null,
        }))
      } catch (error) {
        setState(prev => ({
          ...prev,
          isCleaningProcesses: false,
          error: error instanceof Error ? error.message : '残留进程清理失败',
        }))
      }
    },
    [refreshLocalExecutor]
  )

  const changeExecutorEnv = useCallback((index: number, patch: Partial<StartupEnvVar>) => {
    setState(prev => ({
      ...prev,
      envVars: prev.envVars.map((envVar, currentIndex) =>
        currentIndex === index ? { ...envVar, ...patch } : envVar
      ),
    }))
  }, [])

  const addExecutorEnv = useCallback(() => {
    setState(prev => ({
      ...prev,
      envExpanded: true,
      envVars: [...prev.envVars, { key: '', value: '', enabled: true, sensitive: false }],
    }))
  }, [])

  const deleteExecutorEnv = useCallback((index: number) => {
    setState(prev => ({
      ...prev,
      envVars: prev.envVars.filter((_, currentIndex) => currentIndex !== index),
    }))
  }, [])

  const toggleExecutorEnvExpanded = useCallback(() => {
    setState(prev => ({
      ...prev,
      envExpanded: !prev.envExpanded,
    }))
  }, [])

  useEffect(() => {
    refreshLocalExecutor()
  }, [refreshLocalExecutor])

  useEffect(() => {
    if (state.isLoading) return

    const envVars = state.envVars
    const snapshot = JSON.stringify(envVars)
    if (snapshot === lastSavedEnvSnapshotRef.current) return

    envSaveGenerationRef.current += 1
    const generation = envSaveGenerationRef.current

    if (envSaveTimerRef.current !== null) {
      window.clearTimeout(envSaveTimerRef.current)
      envSaveTimerRef.current = null
    }

    if (!canSaveEnvVars(envVars)) {
      setState(prev => ({ ...prev, isSavingEnv: false }))
      return
    }

    envSaveTimerRef.current = window.setTimeout(async () => {
      setState(prev => ({
        ...prev,
        isSavingEnv: true,
        error: null,
        message: null,
      }))

      try {
        await saveStartupEnv(envVars)
        if (envSaveGenerationRef.current !== generation) return

        lastSavedEnvSnapshotRef.current = snapshot
        setState(prev => ({
          ...prev,
          isSavingEnv: false,
          message: '环境变量已自动保存，重启 Executor 后生效',
        }))
      } catch (error) {
        if (envSaveGenerationRef.current !== generation) return

        setState(prev => ({
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
  }, [state.envVars, state.isLoading])

  return {
    state,
    refreshLocalExecutor,
    runExecutorAction,
    openExecutorLogs,
    cleanExecutorProcesses,
    changeExecutorEnv,
    addExecutorEnv,
    deleteExecutorEnv,
    toggleExecutorEnvExpanded,
  }
}
