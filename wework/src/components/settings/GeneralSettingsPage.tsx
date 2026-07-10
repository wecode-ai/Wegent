import { useEffect, useState } from 'react'
import { Activity, Bell, Check, CircleDot, Gauge, Loader2, type LucideIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { applyLanguagePreference, languagePreferenceOptions } from '@/i18n/languagePreference'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppLanguagePreference,
  type AppPreferences,
  type AppPreferencesPatch,
} from '@/tauri/appPreferences'

type BooleanPreferenceKey = keyof AppPreferencesPatch

interface SwitchRowProps {
  preferenceKey: BooleanPreferenceKey
  testId: string
  label: string
  description: string
  compact?: boolean
}

interface TrayDisplayOption {
  preferenceKey: BooleanPreferenceKey
  testId: string
  label: string
  description: string
  icon: LucideIcon
}

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

  const handlePreferenceChange = async (key: BooleanPreferenceKey, value: boolean) => {
    setPreferences(current => ({ ...current, [key]: value }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ [key]: value })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[Wework] Failed to update app preferences', saveError)
      setPreferences(current => ({
        ...current,
        [key]: !value,
      }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const renderSwitchRow = ({
    preferenceKey,
    testId,
    label,
    description,
    compact = false,
  }: SwitchRowProps) => (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <p className={`${compact ? 'mt-0.5' : 'mt-1'} text-xs leading-5 text-text-secondary`}>
          {description}
        </p>
      </div>
      <label className="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center">
        <input
          data-testid={testId}
          type="checkbox"
          checked={Boolean(preferences[preferenceKey])}
          disabled={loading || saving}
          onChange={event => {
            void handlePreferenceChange(preferenceKey, event.target.checked)
          }}
          className="peer sr-only"
        />
        <span className="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-text-primary peer-disabled:opacity-50" />
        <span className="absolute left-1 h-5 w-5 rounded-full bg-background shadow transition peer-checked:translate-x-5 peer-disabled:opacity-70" />
      </label>
    </div>
  )

  const trayDisplayOptions: TrayDisplayOption[] = [
    {
      preferenceKey: 'trayUnreadEnabled',
      testId: 'general-tray-unread-toggle',
      label: t('workbench.general_settings_tray_unread'),
      description: t('workbench.general_settings_tray_unread_description'),
      icon: CircleDot,
    },
    {
      preferenceKey: 'trayRunningEnabled',
      testId: 'general-tray-running-toggle',
      label: t('workbench.general_settings_tray_running'),
      description: t('workbench.general_settings_tray_running_description'),
      icon: Activity,
    },
    {
      preferenceKey: 'trayUsageEnabled',
      testId: 'general-tray-usage-toggle',
      label: t('workbench.general_settings_tray_usage'),
      description: t('workbench.general_settings_tray_usage_description'),
      icon: Gauge,
    },
  ]

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
    <div data-testid="general-settings-page" className="mx-auto w-full max-w-[760px] pb-10">
      <div>
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">
          {t('workbench.general_settings_title')}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          {t('workbench.general_settings_subtitle')}
        </p>
      </div>

      <section className="mt-6 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5">
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
        {renderSwitchRow({
          preferenceKey: 'showMainWindowOnLaunch',
          testId: 'general-show-main-window-on-launch-toggle',
          label: t('workbench.general_settings_show_main_window_on_launch'),
          description: t('workbench.general_settings_show_main_window_on_launch_description'),
          compact: true,
        })}
      </section>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.general_settings_background_title')}
          </h2>
        </div>
        {renderSwitchRow({
          preferenceKey: 'closeToTrayEnabled',
          testId: 'general-close-to-tray-toggle',
          label: t('workbench.general_settings_close_to_tray'),
          description: preferences.closeToTrayEnabled
            ? t('workbench.general_settings_background_description')
            : t('workbench.general_settings_background_disabled_description'),
          compact: true,
        })}
      </section>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.general_settings_system_tray_title')}
          </h2>
        </div>
        {renderSwitchRow({
          preferenceKey: 'taskCompletionNotificationsEnabled',
          testId: 'general-task-completion-notifications-toggle',
          label: t('workbench.general_settings_task_completion_notifications'),
          description: t('workbench.general_settings_task_completion_notifications_description'),
          compact: true,
        })}
        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Bell className="h-4 w-4 text-text-secondary" />
              <span>{t('workbench.general_settings_tray_display_content')}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.general_settings_tray_display_content_description')}
            </p>
          </div>
          <div className="grid w-[420px] shrink-0 grid-cols-3 gap-2">
            {trayDisplayOptions.map(option => {
              const Icon = option.icon
              const selected = Boolean(preferences[option.preferenceKey])
              return (
                <button
                  key={option.preferenceKey}
                  data-testid={option.testId}
                  type="button"
                  aria-pressed={selected}
                  title={option.description}
                  disabled={loading || saving}
                  onClick={() => {
                    void handlePreferenceChange(option.preferenceKey, !selected)
                  }}
                  className={`group flex h-9 items-center justify-between gap-2 rounded-md border px-2.5 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected
                      ? 'border-text-primary/50 bg-muted text-text-primary'
                      : 'border-border bg-background text-text-secondary hover:border-text-muted/40 hover:bg-muted/40 hover:text-text-primary'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        selected ? 'text-text-primary' : 'text-text-secondary'
                      }`}
                    />
                    <span className="truncate">{option.label}</span>
                  </span>
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition ${
                      selected
                        ? 'border-text-primary bg-text-primary text-background'
                        : 'border-border bg-surface group-hover:border-text-muted/40'
                    }`}
                  >
                    {selected && <Check className="h-3 w-3" />}
                  </span>
                </button>
              )
            })}
          </div>
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
