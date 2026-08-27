import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, Check, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { getRuntimeConfig } from '@/config/runtime'
import {
  applyLocalExecutorCloudConnection,
  type LocalExecutorCloudConnection,
} from '@/features/cloud-connection/localExecutorCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { getPlatform } from '@/lib/platform'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import {
  copyLocalExecutorDebugInfo,
  ensureLocalExecutorStarted,
  readLocalExecutorLog,
  type LocalExecutorLog,
  type LocalExecutorStatus,
} from '@/desktop/localExecutor'

function getLocalExecutorLogDisplayPath(): string {
  return getPlatform() === 'win'
    ? '%USERPROFILE%\\.wework\\logs\\executor.log'
    : '~/.wework/logs/executor.log'
}
const LOCAL_RUNTIME_SLOW_STARTUP_MS = 10000

type LocalRuntimePhase = 'starting' | 'ready' | 'failed'
type CopyDebugState = 'idle' | 'copying' | 'copied' | 'failed'

interface LocalRuntimeInitializerProps {
  children: ReactNode
  initialCloudConnection?: LocalExecutorCloudConnection
  startupReady?: boolean
}

interface LocalRuntimeState {
  phase: LocalRuntimePhase
  error: string | null
}

interface LocalRuntimeErrorText {
  notRunning: string
  notReady: string
}

interface LocalRuntimeDebugInfo {
  capturedAt: string
  runtimeMode: string
  phase: LocalRuntimePhase
  startupReady: boolean
  ensureCallState: string
  error: string | null
  log: LocalExecutorLog | null
  logError: string | null
}

function shouldInitializeLocalRuntime(): boolean {
  return isLocalFirstAppRuntime()
}

function localRuntimeError(
  status: LocalExecutorStatus,
  errorText: LocalRuntimeErrorText
): string | null {
  if (status.error) return status.error
  if (!status.running) return errorText.notRunning
  if (status.ready === false) return errorText.notReady
  return null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback)
}

function sanitizeLocalRuntimeDebugText(text: string): string {
  return text.replace(/\bsidecar\b/gi, 'executor process')
}

async function resolveLocalRuntimeState(
  fallbackError: string,
  errorText: LocalRuntimeErrorText
): Promise<LocalRuntimeState> {
  try {
    const status = await ensureLocalExecutorStarted()
    const statusError = localRuntimeError(status, errorText)
    if (statusError) {
      throw new Error(statusError)
    }
    return { phase: 'ready', error: null }
  } catch (error) {
    return {
      phase: 'failed',
      error: errorMessage(error, fallbackError),
    }
  }
}

function formatLocalRuntimeDebugInfo(info: LocalRuntimeDebugInfo): string {
  const logPath = info.log?.path ?? getLocalExecutorLogDisplayPath()
  const logContent = info.logError
    ? `Failed to read executor log: ${info.logError}`
    : info.log?.content || '(executor log is empty)'

  const debugText = [
    'Wework startup debug',
    `Captured at: ${info.capturedAt}`,
    `App mode: ${info.runtimeMode}`,
    `Startup phase: ${info.phase}`,
    `Startup ready: ${info.startupReady ? 'true' : 'false'}`,
    `Startup check: ${info.ensureCallState}`,
    `Error: ${info.error ?? 'none'}`,
    `IPC transport: ${info.log?.transport ?? 'unknown'}`,
    `IPC connected: ${info.log ? String(info.log.transportConnected) : 'unknown'}`,
    `Executor PID(s): ${info.log?.processPids.length ? info.log.processPids.join(', ') : 'none'}`,
    `Executor process path(s): ${info.log?.processPaths.length ? info.log.processPaths.join(', ') : 'none'}`,
    `Executor launch source: ${info.log?.sidecarSource ?? 'unknown'}`,
    `Executor launch path: ${info.log?.sidecarPath ?? 'unknown'}`,
    `Current working directory: ${info.log?.currentDir ?? 'unknown'}`,
    `Executor home: ${info.log?.executorHome ?? 'unknown'}`,
    `Backend URL: ${info.log?.backendUrl ?? 'none'}`,
    `Backend auth token configured: ${info.log ? String(info.log.hasBackendAuthToken) : 'unknown'}`,
    `Pending request count: ${info.log?.pendingRequestCount ?? 'unknown'}`,
    `Local executor status: running=${info.log?.status.running ?? 'unknown'} ready=${info.log?.status.ready ?? 'unknown'} deviceId=${info.log?.status.deviceId ?? 'none'} version=${info.log?.status.version ?? 'none'} error=${info.log?.status.error ?? 'none'}`,
    `Executor log path: ${logPath}`,
    `Executor log truncated: ${info.log?.truncated ? 'true' : 'false'}`,
    `Executor log lines: last ${info.log?.lineCount ?? 0}`,
    '',
    '--- Executor log ---',
    logContent,
  ].join('\n')

  return sanitizeLocalRuntimeDebugText(debugText)
}

async function copyDebugInfoText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch (error) {
    console.warn('[Wework] Clipboard copy failed; retrying with native app copy.', error)
  }

  await copyLocalExecutorDebugInfo(text)
}

interface SlowStartupHelpProps {
  copyState: CopyDebugState
  onCopyDebugInfo: () => void
}

function SlowStartupHelp({ copyState, onCopyDebugInfo }: SlowStartupHelpProps) {
  const { t } = useTranslation('localRuntime')
  const copied = copyState === 'copied'
  const copying = copyState === 'copying'
  const failed = copyState === 'failed'
  const buttonLabel = copied
    ? t('copy_debug_copied')
    : copying
      ? t('copy_debug_copying')
      : failed
        ? t('copy_debug_failed')
        : t('copy_debug')
  const Icon = copied ? Check : Copy

  return (
    <div
      data-testid="local-runtime-slow-startup-help"
      className="mt-5 flex w-full max-w-[480px] flex-col items-stretch gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3 text-left sm:flex-row sm:items-center sm:px-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <span
          data-testid="local-runtime-slow-startup-icon"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-700 sm:h-8 sm:w-8 dark:text-amber-300"
        >
          <AlertCircle className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{t('slow_startup_title')}</p>
          <p className="mt-0.5 text-xs leading-5 text-text-secondary">
            {t('slow_startup_description')}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        className="h-11 min-w-[44px] border-border bg-base px-3 text-xs text-text-primary hover:bg-muted sm:h-9 sm:w-auto"
        onClick={onCopyDebugInfo}
        disabled={copying}
        data-testid="local-runtime-copy-debug-button"
      >
        <Icon className="h-4 w-4" />
        {buttonLabel}
      </Button>
    </div>
  )
}

export function LocalRuntimeInitializer({
  children,
  initialCloudConnection,
  startupReady = true,
}: LocalRuntimeInitializerProps) {
  const { t } = useTranslation('localRuntime')
  const enabled = useMemo(() => shouldInitializeLocalRuntime(), [])
  const fallbackError = t('fallback_error')
  const initialCloudConnectionRef = useRef(initialCloudConnection)
  const [slowStartupTimedOut, setSlowStartupTimedOut] = useState(false)
  const [startupAttempt, setStartupAttempt] = useState(0)
  const [copyDebugState, setCopyDebugState] = useState<CopyDebugState>('idle')
  const runtimeErrorText = useMemo(
    () => ({
      notRunning: t('error_not_running'),
      notReady: t('error_not_ready'),
    }),
    [t]
  )
  const [state, setState] = useState<LocalRuntimeState>(() => ({
    phase: enabled ? 'starting' : 'ready',
    error: null,
  }))

  useEffect(() => {
    initialCloudConnectionRef.current = initialCloudConnection
  }, [initialCloudConnection])

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      setSlowStartupTimedOut(true)
    }, LOCAL_RUNTIME_SLOW_STARTUP_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, startupAttempt])

  const retryInitialize = useCallback(async () => {
    if (!enabled) return
    setStartupAttempt(attempt => attempt + 1)
    setSlowStartupTimedOut(false)
    setCopyDebugState('idle')
    setState({ phase: 'starting', error: null })
    setState(await resolveLocalRuntimeState(fallbackError, runtimeErrorText))
  }, [enabled, fallbackError, runtimeErrorText])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    void resolveLocalRuntimeState(fallbackError, runtimeErrorText).then(nextState => {
      if (!cancelled) {
        setState(nextState)
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, fallbackError, runtimeErrorText])

  useEffect(() => {
    if (!enabled || state.phase !== 'ready' || !initialCloudConnectionRef.current) return

    void applyLocalExecutorCloudConnection(initialCloudConnectionRef.current).catch(error => {
      console.error('[Wework] Failed to apply cloud connection to local executor:', error)
    })
  }, [enabled, state.phase])

  const handleCopyDebugInfo = useCallback(async () => {
    setCopyDebugState('copying')
    let log: LocalExecutorLog | null = null
    let logError: string | null = null

    try {
      log = await readLocalExecutorLog()
    } catch (error) {
      logError = errorMessage(error, t('debug_log_read_failed'))
    }

    const debugInfo = formatLocalRuntimeDebugInfo({
      capturedAt: new Date().toISOString(),
      runtimeMode: getRuntimeConfig().runtimeMode,
      phase: state.phase,
      startupReady,
      ensureCallState:
        state.phase === 'starting' ? 'pending' : state.phase === 'failed' ? 'failed' : 'resolved',
      error: state.error,
      log,
      logError,
    })

    try {
      await copyDebugInfoText(debugInfo)
      setCopyDebugState('copied')
    } catch {
      setCopyDebugState('failed')
    }
  }, [startupReady, state.error, state.phase, t])

  const canMountChildren = state.phase === 'ready'
  const canRevealChildren = canMountChildren
  const shouldShowStartupScreen = !canRevealChildren
  const failed = state.phase === 'failed'

  return (
    <>
      {canMountChildren && (
        <div hidden={!canRevealChildren} aria-hidden={!canRevealChildren}>
          {children}
        </div>
      )}
      {shouldShowStartupScreen && (
        <main
          data-testid="local-runtime-initializer"
          className="relative flex h-screen min-h-[520px] items-center justify-center overflow-hidden bg-base px-6 py-10 text-text-primary"
        >
          <div
            data-testid="local-runtime-titlebar-drag-region"
            className="absolute inset-x-0 top-0 h-[52px]"
          >
            <MacOSTitleBarDragRegion className="h-full w-full" />
          </div>
          <section className="flex w-full max-w-[520px] flex-col items-center text-center">
            {failed ? (
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
                <AlertCircle className="h-6 w-6 text-amber-600" />
              </div>
            ) : null}
            <h1 className="heading-base">{failed ? t('failed_title') : t('starting_title')}</h1>
            <p className="mt-3 max-w-[360px] text-sm leading-6 text-text-secondary">
              {failed ? t('failed_description') : t('starting_description')}
            </p>

            {failed && (
              <div className="mt-6 w-full rounded-lg border border-border bg-surface px-4 py-3 text-left">
                {state.error && (
                  <p
                    data-testid="local-runtime-error"
                    className="break-words text-sm leading-6 text-text-primary"
                  >
                    {state.error}
                  </p>
                )}
                <div className="mt-3 text-xs leading-5 text-text-secondary">
                  <span className="font-medium">{t('log_label')}: </span>
                  <code className="break-all rounded bg-base px-1.5 py-0.5 text-text-primary">
                    {getLocalExecutorLogDisplayPath()}
                  </code>
                </div>
              </div>
            )}

            {!failed && slowStartupTimedOut && (
              <SlowStartupHelp copyState={copyDebugState} onCopyDebugInfo={handleCopyDebugInfo} />
            )}

            {failed && (
              <Button
                type="button"
                variant="primary"
                className="mt-6 h-10 min-w-[112px]"
                onClick={() => void retryInitialize()}
                data-testid="local-runtime-retry-button"
              >
                <RefreshCw className="h-4 w-4" />
                {t('retry')}
              </Button>
            )}
          </section>
        </main>
      )}
    </>
  )
}
