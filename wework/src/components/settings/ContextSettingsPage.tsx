import { useEffect, useState } from 'react'
import { Loader2, Terminal } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'

export function ContextSettingsPage() {
  const { t } = useTranslation('common')
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    getAppPreferences()
      .then(nextPreferences => {
        if (!cancelled) {
          setPreferences(nextPreferences)
          setError(null)
        }
      })
      .catch(fetchError => {
        console.error('[Wework] Failed to load context settings', fetchError)
        if (!cancelled) {
          setError(t('workbench.context_settings_load_failed'))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [t])

  const handleTerminalContextChange = async (enabled: boolean) => {
    setPreferences(current => ({ ...current, terminalContextInjectionEnabled: enabled }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({
        terminalContextInjectionEnabled: enabled,
      })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[Wework] Failed to update context settings', saveError)
      setPreferences(current => ({
        ...current,
        terminalContextInjectionEnabled: !enabled,
      }))
      setError(t('workbench.context_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="context-settings-page" className="mx-auto w-full max-w-[760px] pb-10">
      <div>
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">
          {t('workbench.context_settings_title')}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          {t('workbench.context_settings_subtitle')}
        </p>
      </div>

      <section className="mt-6 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.context_settings_terminal_title')}
          </h2>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Terminal className="h-4 w-4 text-text-secondary" />
              <span>{t('workbench.context_settings_terminal_injection')}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_terminal_injection_description')}
            </p>
          </div>
          <label className="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center">
            <input
              data-testid="context-terminal-injection-toggle"
              type="checkbox"
              checked={preferences.terminalContextInjectionEnabled}
              disabled={loading || saving}
              onChange={event => {
                void handleTerminalContextChange(event.target.checked)
              }}
              className="peer sr-only"
            />
            <span className="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-text-primary peer-disabled:opacity-50" />
            <span className="absolute left-1 h-5 w-5 rounded-full bg-background shadow transition peer-checked:translate-x-5 peer-disabled:opacity-70" />
          </label>
        </div>
      </section>

      {(loading || saving || error) && (
        <div
          data-testid="context-settings-status"
          className="mt-4 flex items-center gap-2 text-xs text-text-secondary"
        >
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            {error ??
              (loading ? t('common.loading', '加载中...') : t('workbench.context_settings_saving'))}
          </span>
        </div>
      )}
    </div>
  )
}
