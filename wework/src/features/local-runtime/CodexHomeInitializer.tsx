import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { LocalCodexHomeMigrationStatus } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'

const CODEX_MIGRATION_DISMISSED_STORAGE_KEY = 'wework.plugins.codexMigrationDismissed'
const SHOULD_SKIP_CODEX_HOME_INITIALIZATION = import.meta.env.VITE_WEWORK_E2E === 'true'

function CodexHomeInitializationDialog({
  status,
  isInitializing,
  remoteAppsEnabled,
  error,
  onRemoteAppsEnabledChange,
  onCreate,
  onMigrate,
}: {
  status: LocalCodexHomeMigrationStatus
  isInitializing: boolean
  remoteAppsEnabled: boolean
  error: string | null
  onRemoteAppsEnabledChange: (enabled: boolean) => void
  onCreate: () => void
  onMigrate: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm">
      <div
        data-testid="codex-home-initializer-dialog"
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <div className="space-y-2">
          <h2 className="text-base font-medium text-text-primary">
            {t('workbench.codex_home_init_title')}
          </h2>
          <p className="text-sm leading-6 text-text-secondary">
            {t('workbench.codex_home_init_description')}
          </p>
        </div>
        <div className="mt-4 rounded-lg bg-surface px-3 py-2 text-xs leading-5 text-text-muted">
          <div className="truncate">
            {t('workbench.codex_home_init_source')}：{status.nativeCodexHome}
          </div>
          <div className="truncate">
            {t('workbench.codex_home_init_target')}：{status.weworkCodexHome}
          </div>
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background px-3 py-3 text-sm">
          <input
            type="checkbox"
            data-testid="codex-home-initializer-remote-apps-checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
            checked={remoteAppsEnabled}
            onChange={event => onRemoteAppsEnabledChange(event.currentTarget.checked)}
            disabled={isInitializing}
          />
          <span className="min-w-0">
            <span className="block font-medium text-text-primary">
              {t('workbench.codex_plugin_remote_apps_title')}
            </span>
            <span className="mt-1 block text-xs leading-5 text-text-muted">
              {t('workbench.codex_home_init_remote_apps_description')}
            </span>
          </span>
        </label>
        {error && (
          <div
            data-testid="codex-home-initializer-error"
            className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
          >
            {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
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
        </div>
      </div>
    </div>
  )
}

export function CodexHomeInitializer({ children }: { children?: ReactNode }) {
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const [status, setStatus] = useState<LocalCodexHomeMigrationStatus | null>(null)
  const [checked, setChecked] = useState(SHOULD_SKIP_CODEX_HOME_INITIALIZATION)
  const [isInitializing, setIsInitializing] = useState(false)
  const [remoteAppsEnabled, setRemoteAppsEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (SHOULD_SKIP_CODEX_HOME_INITIALIZATION) return

    let isCurrent = true
    const migrationDismissed =
      typeof window !== 'undefined' &&
      window.localStorage.getItem(CODEX_MIGRATION_DISMISSED_STORAGE_KEY) === '1'

    localPluginApi
      .codexHomeMigrationStatus()
      .then(nextStatus => {
        if (!isCurrent) return
        if (migrationDismissed && !nextStatus.shouldPromptMigration) {
          setStatus(null)
          setChecked(true)
          return
        }
        setStatus(nextStatus.shouldPromptMigration ? nextStatus : null)
        setChecked(true)
      })
      .catch(() => {
        if (!isCurrent) return
        setStatus(null)
        setChecked(true)
      })

    return () => {
      isCurrent = false
    }
  }, [localPluginApi])

  const initialize = (migrateNativeHome: boolean) => {
    console.warn('[Wework Codex init] initialization requested', {
      migrateNativeHome,
      remoteAppsEnabled,
    })
    setIsInitializing(true)
    setError(null)
    localPluginApi
      .initializeCodexHome({
        migrateNativeHome,
        remoteAppsEnabled,
      })
      .then(() => {
        console.warn('[Wework Codex init] initialization finished')
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(CODEX_MIGRATION_DISMISSED_STORAGE_KEY, '1')
        }
        setStatus(null)
        setChecked(true)
      })
      .catch((initializationError: Error) => {
        console.warn('[Wework Codex init] initialization failed', initializationError)
        setError(initializationError.message)
      })
      .finally(() => setIsInitializing(false))
  }

  if (!checked) return null

  if (!status) return <>{children}</>

  return (
    <CodexHomeInitializationDialog
      status={status}
      isInitializing={isInitializing}
      remoteAppsEnabled={remoteAppsEnabled}
      error={error}
      onRemoteAppsEnabledChange={setRemoteAppsEnabled}
      onCreate={() => initialize(false)}
      onMigrate={() => initialize(true)}
    />
  )
}
