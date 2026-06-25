import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, Loader2, RefreshCw, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { ensureLocalExecutorStarted, type LocalExecutorStatus } from '@/tauri/localExecutor'

const LOCAL_EXECUTOR_LOG_PATH = '~/.wegent-executor/logs/executor.log'

type LocalRuntimePhase = 'starting' | 'ready' | 'failed'

interface LocalRuntimeInitializerProps {
  children: ReactNode
}

interface LocalRuntimeState {
  phase: LocalRuntimePhase
  error: string | null
}

function shouldInitializeLocalRuntime(): boolean {
  return getRuntimeConfig().runtimeMode === 'local-first' && isTauriRuntime()
}

function localRuntimeError(status: LocalExecutorStatus): string | null {
  if (status.error) return status.error
  if (!status.running) return 'Local executor is not running'
  if (status.ready === false) return 'Local executor is not ready'
  return null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback)
}

async function resolveLocalRuntimeState(fallbackError: string): Promise<LocalRuntimeState> {
  try {
    const status = await ensureLocalExecutorStarted()
    const statusError = localRuntimeError(status)
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

export function LocalRuntimeInitializer({ children }: LocalRuntimeInitializerProps) {
  const { t } = useTranslation('localRuntime')
  const enabled = useMemo(() => shouldInitializeLocalRuntime(), [])
  const fallbackError = t('fallback_error')
  const [state, setState] = useState<LocalRuntimeState>(() => ({
    phase: enabled ? 'starting' : 'ready',
    error: null,
  }))

  const retryInitialize = useCallback(async () => {
    if (!enabled) return
    setState({ phase: 'starting', error: null })
    setState(await resolveLocalRuntimeState(fallbackError))
  }, [enabled, fallbackError])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    void resolveLocalRuntimeState(fallbackError).then(nextState => {
      if (!cancelled) {
        setState(nextState)
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, fallbackError])

  if (state.phase === 'ready') {
    return <>{children}</>
  }

  const failed = state.phase === 'failed'

  return (
    <main
      data-testid="local-runtime-initializer"
      className="flex h-screen min-h-[480px] items-center justify-center bg-base px-6 text-text-primary"
    >
      <section className="flex w-full max-w-[420px] flex-col items-center text-center">
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
          {failed ? (
            <AlertCircle className="h-6 w-6 text-amber-600" />
          ) : (
            <TerminalSquare className="h-6 w-6" />
          )}
        </div>
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
          <div className="mt-6 flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>{t('starting_title')}</span>
          </div>
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
