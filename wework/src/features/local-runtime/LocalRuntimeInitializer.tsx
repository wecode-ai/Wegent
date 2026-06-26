import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertCircle,
  FileText,
  FolderOpen,
  MessageSquareText,
  MousePointer2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { ensureLocalExecutorStarted, type LocalExecutorStatus } from '@/tauri/localExecutor'

const LOCAL_EXECUTOR_LOG_PATH = '~/.wegent-executor/logs/executor.log'
const LOCAL_RUNTIME_ANIMATION_CYCLE_MS = 4800

type LocalRuntimePhase = 'starting' | 'ready' | 'failed'

interface LocalRuntimeInitializerProps {
  children: ReactNode
}

interface LocalRuntimeState {
  phase: LocalRuntimePhase
  error: string | null
}

interface LocalRuntimeErrorText {
  notRunning: string
  notReady: string
}

function shouldInitializeLocalRuntime(): boolean {
  return getRuntimeConfig().runtimeMode === 'local-first' && isTauriRuntime()
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

function localRuntimeMinimumReadyDelayMs(): number {
  return import.meta.env.DEV ? LOCAL_RUNTIME_ANIMATION_CYCLE_MS : 0
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

async function resolveLocalRuntimeState(
  fallbackError: string,
  errorText: LocalRuntimeErrorText,
  minimumReadyDelayMs = localRuntimeMinimumReadyDelayMs()
): Promise<LocalRuntimeState> {
  const startedAt = Date.now()
  try {
    const status = await ensureLocalExecutorStarted()
    const statusError = localRuntimeError(status, errorText)
    if (statusError) {
      throw new Error(statusError)
    }
    await delay(minimumReadyDelayMs - (Date.now() - startedAt))
    return { phase: 'ready', error: null }
  } catch (error) {
    return {
      phase: 'failed',
      error: errorMessage(error, fallbackError),
    }
  }
}

function WorkspaceSetupAnimation() {
  const { t } = useTranslation('localRuntime')
  const cards = [
    {
      key: 'project',
      label: t('animation_project'),
      Icon: FolderOpen,
      className: 'local-runtime-card-project',
    },
    {
      key: 'files',
      label: t('animation_files'),
      Icon: FileText,
      className: 'local-runtime-card-files',
    },
    {
      key: 'chat',
      label: t('animation_chat'),
      Icon: MessageSquareText,
      className: 'local-runtime-card-chat',
    },
  ]

  return (
    <div
      aria-hidden="true"
      className="relative mb-8 h-[180px] w-full max-w-[360px] overflow-hidden"
    >
      <div className="absolute left-1/2 top-[112px] h-12 w-[260px] -translate-x-1/2 rounded-lg border border-border bg-surface/80" />
      <div className="absolute left-1/2 top-[128px] h-1.5 w-[210px] -translate-x-1/2 overflow-hidden rounded-full bg-muted">
        <div className="local-runtime-progress-track h-full w-1/2 rounded-full bg-primary/70" />
      </div>
      <Sparkles className="local-runtime-sparkle absolute left-[58%] top-4 h-5 w-5 text-primary" />
      {cards.map(({ key, label, Icon, className }) => (
        <div
          key={key}
          className={`local-runtime-setup-card ${className} absolute left-1/2 top-10 flex h-14 w-[132px] items-center gap-2 rounded-lg border border-border bg-base px-3 text-left shadow-[0_14px_34px_rgb(0_0_0_/_0.08)]`}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <span className="truncate text-sm font-medium text-text-primary">{label}</span>
        </div>
      ))}
      <MousePointer2 className="local-runtime-cursor absolute h-5 w-5 text-text-primary" />
    </div>
  )
}

function StartupStatusList() {
  const { t } = useTranslation('localRuntime')
  const steps = [t('step_workspace'), t('step_files'), t('step_assistant')]

  return (
    <div className="mt-7 grid w-full max-w-[400px] grid-cols-3 gap-2" aria-hidden="true">
      {steps.map((step, index) => (
        <div
          key={step}
          className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-2 text-xs text-text-secondary"
        >
          <span
            className="local-runtime-step-dot h-1.5 w-1.5 rounded-full bg-primary"
            style={{ animationDelay: `${index * 0.22}s` }}
          />
          <span className="truncate">{step}</span>
        </div>
      ))}
    </div>
  )
}

export function LocalRuntimeInitializer({ children }: LocalRuntimeInitializerProps) {
  const { t } = useTranslation('localRuntime')
  const enabled = useMemo(() => shouldInitializeLocalRuntime(), [])
  const fallbackError = t('fallback_error')
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

  const retryInitialize = useCallback(async () => {
    if (!enabled) return
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

  if (state.phase === 'ready') {
    return <>{children}</>
  }

  const failed = state.phase === 'failed'

  return (
    <main
      data-testid="local-runtime-initializer"
      className="flex h-screen min-h-[520px] items-center justify-center overflow-hidden bg-base px-6 py-10 text-text-primary"
    >
      <section className="flex w-full max-w-[520px] flex-col items-center text-center">
        {failed ? (
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
            <AlertCircle className="h-6 w-6 text-amber-600" />
          </div>
        ) : (
          <WorkspaceSetupAnimation />
        )}
        {!failed && (
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-text-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {t('starting_status')}
          </div>
        )}
        <h1 className="text-xl font-semibold">
          {failed ? t('failed_title') : t('starting_title')}
        </h1>
        <p className="mt-3 max-w-[360px] text-sm leading-6 text-text-secondary">
          {failed ? t('failed_description') : t('starting_description')}
        </p>

        {failed ? (
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
                {LOCAL_EXECUTOR_LOG_PATH}
              </code>
            </div>
          </div>
        ) : (
          <StartupStatusList />
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
  )
}
