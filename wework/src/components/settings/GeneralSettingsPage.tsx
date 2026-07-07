import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { applyLanguagePreference, languagePreferenceOptions } from '@/i18n/languagePreference'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppLanguagePreference,
  type AppPreferences,
} from '@/tauri/appPreferences'

export function GeneralSettingsPage() {
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
        console.error('[Wework] Failed to load app preferences', fetchError)
        if (!cancelled) {
          setError(t('workbench.general_settings_load_failed'))
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

  const handleLaunchVisibilityChange = async (showMainWindowOnLaunch: boolean) => {
    setPreferences(current => ({ ...current, showMainWindowOnLaunch }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ showMainWindowOnLaunch })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[Wework] Failed to update app preferences', saveError)
      setPreferences(current => ({
        ...current,
        showMainWindowOnLaunch: !showMainWindowOnLaunch,
      }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleCloseToTrayChange = async (closeToTrayEnabled: boolean) => {
    setPreferences(current => ({ ...current, closeToTrayEnabled }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ closeToTrayEnabled })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[Wework] Failed to update app preferences', saveError)
      setPreferences(current => ({
        ...current,
        closeToTrayEnabled: !closeToTrayEnabled,
      }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleLanguageChange = async (language: AppLanguagePreference) => {
    if (language === preferences.language) {
      return
    }

    const previousLanguage = preferences.language
    setPreferences(current => ({ ...current, language }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ language })
      setPreferences(nextPreferences)
      await applyLanguagePreference(nextPreferences.language)
    } catch (saveError) {
      console.error('[Wework] Failed to update app language preference', saveError)
      setPreferences(current => ({ ...current, language: previousLanguage }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="general-settings-page" className="mx-auto w-full max-w-[880px] pb-10">
      <div>
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">
          {t('workbench.general_settings_title')}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          {t('workbench.general_settings_subtitle')}
        </p>
      </div>

      <section className="mt-8 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.general_settings_language_title')}
          </h2>
        </div>
        <div className="flex min-h-[72px] flex-col justify-center gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">
              {t('workbench.general_settings_language_preference')}
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.general_settings_language_description')}
            </p>
          </div>
          <div className="grid h-8 w-full shrink-0 grid-cols-3 rounded-md border border-border bg-background p-0.5 md:w-[300px]">
            {languagePreferenceOptions.map(option => {
              const active = preferences.language === option.value

              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`general-language-${option.value}-button`}
                  disabled={loading || saving}
                  title={t(`workbench.${option.descriptionKey}`)}
                  aria-pressed={active}
                  onClick={() => {
                    void handleLanguageChange(option.value)
                  }}
                  className={[
                    'flex min-w-0 items-center justify-center rounded-[5px] px-2 text-[13px] font-medium leading-[18px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    active
                      ? 'bg-text-primary text-background shadow-sm'
                      : 'text-text-secondary hover:bg-muted hover:text-text-primary',
                  ].join(' ')}
                >
                  <span className="truncate">{t(`workbench.${option.shortLabelKey}`)}</span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.general_settings_startup')}
          </h2>
        </div>
        <div className="flex min-h-[72px] items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">
              {t('workbench.general_settings_show_main_window_on_launch')}
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.general_settings_show_main_window_on_launch_description')}
            </p>
          </div>
          <label className="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center">
            <input
              data-testid="general-show-main-window-on-launch-toggle"
              type="checkbox"
              checked={preferences.showMainWindowOnLaunch}
              disabled={loading || saving}
              onChange={event => {
                void handleLaunchVisibilityChange(event.target.checked)
              }}
              className="peer sr-only"
            />
            <span className="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-text-primary peer-disabled:opacity-50" />
            <span className="absolute left-1 h-5 w-5 rounded-full bg-background shadow transition peer-checked:translate-x-5 peer-disabled:opacity-70" />
          </label>
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.general_settings_background_title')}
          </h2>
        </div>
        <div className="flex min-h-[72px] items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">
              {t('workbench.general_settings_close_to_tray')}
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {preferences.closeToTrayEnabled
                ? t('workbench.general_settings_background_description')
                : t('workbench.general_settings_background_disabled_description')}
            </p>
          </div>
          <label className="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center">
            <input
              data-testid="general-close-to-tray-toggle"
              type="checkbox"
              checked={preferences.closeToTrayEnabled}
              disabled={loading || saving}
              onChange={event => {
                void handleCloseToTrayChange(event.target.checked)
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
          data-testid="general-settings-status"
          className="mt-4 flex items-center gap-2 text-xs text-text-secondary"
        >
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            {error ??
              (loading ? t('common.loading', '加载中...') : t('workbench.general_settings_saving'))}
          </span>
        </div>
      )}
    </div>
  )
}
