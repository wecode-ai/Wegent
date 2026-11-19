import { useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createCodexHomeInitializationSource } from './codexHomeInitializationSource'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'

const SHOULD_SKIP_CODEX_HOME_INITIALIZATION =
  import.meta.env.VITE_WEWORK_E2E === 'true'
    ? getDesktopE2ERuntimeConfig().codexHomeInitialization !== true
    : isElectronRuntime()

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function CodexHomeInitializationDialog({
  isInitializing,
  checking,
  checkComplete,
  canInitialize,
  onRetryStatus,
  error,
  onCreate,
  onMigrate,
}: {
  isInitializing: boolean
  checking: boolean
  checkComplete: boolean
  canInitialize: boolean
  onRetryStatus: () => void
  error: string | null
  onCreate: () => void
  onMigrate: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm">
      <div
        data-testid={
          checkComplete ? 'codex-home-initializer-dialog' : 'codex-home-initializer-check'
        }
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <div className="space-y-2">
          <h2 className="text-base font-medium text-text-primary">
            {t(
              canInitialize ? 'workbench.codex_home_init_title' : 'workbench.codex_home_check_title'
            )}
          </h2>
          <p
            role={checking ? 'status' : undefined}
            className="text-sm leading-6 text-text-secondary"
          >
            {t(
              canInitialize
                ? 'workbench.codex_home_init_description'
                : checking
                  ? 'workbench.codex_home_check_loading'
                  : 'workbench.codex_home_check_recovery'
            )}
          </p>
        </div>
        {error && (
          <div
            data-testid="codex-home-initializer-error"
            className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-500"
          >
            {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {canInitialize ? (
            <>
              <button
                type="button"
                data-testid="codex-home-initializer-create-button"
                className="h-9 rounded-lg px-3 text-sm text-text-secondary hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                onClick={onCreate}
                disabled={isInitializing}
              >
                {t('workbench.codex_home_init_create')}
              </button>
              <button
                type="button"
                data-testid="codex-home-initializer-migrate-button"
                className="h-9 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={onMigrate}
                disabled={isInitializing}
              >
                {isInitializing
                  ? t('workbench.codex_home_init_processing')
                  : t('workbench.codex_home_init_migrate')}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="codex-home-initializer-status-retry-button"
              className="h-9 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90"
              onClick={onRetryStatus}
            >
              {t('workbench.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function CodexHomeInitializer({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('localRuntime')
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const source = useMemo(
    () =>
      createCodexHomeInitializationSource(localPluginApi, SHOULD_SKIP_CODEX_HOME_INITIALIZATION),
    [localPluginApi]
  )
  const {
    status,
    checked,
    checking,
    isInitializing,
    error: failure,
  } = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const error = failure ? errorMessage(failure.cause, t('fallback_error')) : null
  const initialize = source.initialize

  if (checked && !checking && !status && error === null) return <>{children}</>

  return (
    <CodexHomeInitializationDialog
      isInitializing={isInitializing}
      checking={checking}
      checkComplete={checked}
      canInitialize={checked && !checking && status !== null}
      onRetryStatus={() => void source.refreshStatus()}
      error={error}
      onCreate={() => initialize(false)}
      onMigrate={() => initialize(true)}
    />
  )
}
