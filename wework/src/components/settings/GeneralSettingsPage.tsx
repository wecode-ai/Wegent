import { useContext, useEffect, useState } from 'react'
import {
  Activity,
  Bell,
  Check,
  CircleDot,
  Gauge,
  Loader2,
  Pencil,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'
import { applyLanguagePreference, languagePreferenceOptions } from '@/i18n/languagePreference'
import { ExternalContentImportDialog } from './ExternalContentImportDialog'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppLanguagePreference,
  type AppPreferences,
  type AppPreferencesPatch,
} from '@/tauri/appPreferences'
import { keybindingFromKeyboardEvent, normalizeKeybinding } from '@/lib/keybindings'
import { getWegentUsageDisplay } from '@/api/wegentUsage'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'

type BooleanPreferenceKey = {
  [Key in keyof AppPreferencesPatch]-?: AppPreferencesPatch[Key] extends boolean | undefined
    ? Key
    : never
}[keyof AppPreferencesPatch]

interface SwitchRowProps {
  preferenceKey: BooleanPreferenceKey
  testId: string
  label: string
  description: string
}

const GENERAL_ROW_CLASS_NAME = 'py-4'
const GENERAL_ROW_LABEL_CLASS_NAME = 'font-normal'
const FRIENDLY_TITLE_TASK_MODEL_VALUE = 'task-model'

interface TrayDisplayOption {
  preferenceKey: BooleanPreferenceKey
  testId: string
  label: string
  description: string
  icon: LucideIcon
}

export function GeneralSettingsPage() {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const workbench = useContext(WorkbenchContext)
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [cloudQuotaName, setCloudQuotaName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [recordingPopoutShortcut, setRecordingPopoutShortcut] = useState(false)

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

  useEffect(() => {
    if (!cloudConnection.isConnected) return

    let cancelled = false
    getWegentUsageDisplay({
      isConnected: cloudConnection.isConnected,
      apiBaseUrl: cloudConnection.apiBaseUrl,
      token: cloudConnection.token,
    })
      .then(usage => {
        if (!cancelled) {
          setCloudQuotaName(usage.status === 'available' ? usage.sourceText : null)
        }
      })
      .catch(() => {
        if (!cancelled) setCloudQuotaName(null)
      })

    return () => {
      cancelled = true
    }
  }, [
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.serviceKey,
    cloudConnection.token,
  ])

  const handlePreferenceChange = async (key: BooleanPreferenceKey, value: boolean) => {
    setPreferences(current => ({ ...current, [key]: value }))
    setSaving(true)
    setError(null)
    try {
      const patch: AppPreferencesPatch =
        key === 'telemetryEnabled'
          ? { telemetryConsentAsked: true, telemetryEnabled: value }
          : { [key]: value }
      const nextPreferences = await updateAppPreferences(patch)
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

  const savePopoutShortcut = async (shortcut: string | null) => {
    const previousShortcut = preferences.popoutWindowShortcut
    setPreferences(current => ({ ...current, popoutWindowShortcut: shortcut }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ popoutWindowShortcut: shortcut })
      setPreferences(nextPreferences)
      setRecordingPopoutShortcut(false)
    } catch (saveError) {
      console.error('[Wework] Failed to update Popout Window shortcut', saveError)
      setPreferences(current => ({ ...current, popoutWindowShortcut: previousShortcut }))
      setError(t('workbench.general_settings_popout_shortcut_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!recordingPopoutShortcut) return undefined

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecordingPopoutShortcut(false)
        return
      }
      const shortcut = normalizeKeybinding(keybindingFromKeyboardEvent(event))
      if (!shortcut || !shortcut.includes('+')) return
      setRecordingPopoutShortcut(false)
      void savePopoutShortcut(shortcut)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  })

  const renderSwitchRow = ({ preferenceKey, testId, label, description }: SwitchRowProps) => (
    <SettingsRow
      label={label}
      description={description}
      className={GENERAL_ROW_CLASS_NAME}
      labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
      control={
        <SettingsSwitch
          data-testid={testId}
          checked={Boolean(preferences[preferenceKey])}
          disabled={loading || saving}
          onCheckedChange={checked => {
            void handlePreferenceChange(preferenceKey, checked)
          }}
          aria-label={label}
        />
      }
    />
  )

  const displayedCloudQuotaName = cloudConnection.isConnected ? cloudQuotaName : null
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
    {
      preferenceKey: 'trayWegentUsageEnabled',
      testId: 'general-tray-wegent-usage-toggle',
      label: displayedCloudQuotaName ?? t('workbench.general_settings_tray_wegent_usage'),
      description: t('workbench.general_settings_tray_wegent_usage_description'),
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

  const saveFriendlyTaskTitles = async (
    enabled: boolean,
    modelKey = FRIENDLY_TITLE_TASK_MODEL_VALUE
  ) => {
    const useTaskModel = modelKey === FRIENDLY_TITLE_TASK_MODEL_VALUE
    const [modelType, ...nameParts] = modelKey.split(':')
    const modelName = nameParts.join(':')
    const selectedModel = workbench?.projectChat.models.find(
      model => `${model.type}:${model.name}` === `${modelType ?? ''}:${modelName}`
    )
    const execution = selectedModel ? selectedModelExecutionFields(selectedModel, {}) : null
    const patch: AppPreferencesPatch = {
      friendlyTaskTitlesEnabled: enabled && (useTaskModel || Boolean(selectedModel)),
      friendlyTaskTitleModel: useTaskModel
        ? null
        : selectedModel
          ? {
              modelName: selectedModel.name,
              modelType: selectedModel.type,
              executionModelId: execution?.modelId ?? '',
              executionModelType: execution?.modelType ?? null,
              options: execution?.modelOptions,
            }
          : null,
    }
    const previousPreferences = preferences
    setSaving(true)
    setError(null)
    try {
      setPreferences(current => ({ ...current, ...patch }))
      setPreferences(await updateAppPreferences(patch))
    } catch (saveError) {
      console.error('[Wework] Failed to update friendly task title preferences', saveError)
      setPreferences(previousPreferences)
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const friendlyTitleModel = preferences.friendlyTaskTitleModel
  const friendlyTitleModelKey = friendlyTitleModel
    ? `${friendlyTitleModel.modelType ?? ''}:${friendlyTitleModel.modelName}`
    : FRIENDLY_TITLE_TASK_MODEL_VALUE
  const friendlyTitleModels = workbench?.projectChat.models ?? []

  return (
    <SettingsPage data-testid="general-settings-page">
      <SettingsPageHeader
        title={t('workbench.general_settings_title')}
        description={t('workbench.general_settings_subtitle')}
      />

      <section data-testid="general-settings-basic-section">
        <div className="mb-2 px-0.5 text-sm font-semibold text-text-primary">
          {t('workbench.general_settings_title')}
        </div>
        <SettingsGroup className="rounded-xl !bg-background">
          <SettingsRow
            label={t('workbench.general_settings_language_preference')}
            description={t('workbench.general_settings_language_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            control={
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
                      onClick={() => void handleLanguageChange(option.value)}
                      className={[
                        'flex min-w-0 items-center justify-center rounded-[5px] px-2 text-sm font-medium leading-[18px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
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
            }
          />
          {renderSwitchRow({
            preferenceKey: 'showMainWindowOnLaunch',
            testId: 'general-show-main-window-on-launch-toggle',
            label: t('workbench.general_settings_show_main_window_on_launch'),
            description: t('workbench.general_settings_show_main_window_on_launch_description'),
          })}
          {renderSwitchRow({
            preferenceKey: 'experimentalFeaturesEnabled',
            testId: 'general-experimental-features-toggle',
            label: t('workbench.general_settings_experimental_features'),
            description: t('workbench.general_settings_experimental_features_description'),
          })}
          <SettingsRow
            label={t('workbench.external_import_row_title')}
            description={t('workbench.external_import_row_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            control={
              <button
                type="button"
                data-testid="general-external-content-import-button"
                onClick={() => setShowImportDialog(true)}
                className="h-8 rounded-md bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
              >
                {t('workbench.external_import_action')}
              </button>
            }
          />
        </SettingsGroup>
      </section>

      <section data-testid="general-settings-runtime-section" className="mt-12">
        <div className="mb-2 px-0.5 text-sm font-semibold text-text-primary">
          {t('workbench.general_settings_runtime_title')}
        </div>
        <SettingsGroup className="rounded-xl !bg-background">
          {renderSwitchRow({
            preferenceKey: 'closeToTrayEnabled',
            testId: 'general-close-to-tray-toggle',
            label: t('workbench.general_settings_close_to_tray'),
            description: preferences.closeToTrayEnabled
              ? t('workbench.general_settings_background_description')
              : t('workbench.general_settings_background_disabled_description'),
          })}
          {renderSwitchRow({
            preferenceKey: 'preventSleepWhileTasksRunning',
            testId: 'general-prevent-sleep-while-tasks-running-toggle',
            label: t('workbench.general_settings_prevent_sleep_while_tasks_running'),
            description: t(
              'workbench.general_settings_prevent_sleep_while_tasks_running_description'
            ),
          })}
          {renderSwitchRow({
            preferenceKey: 'taskCompletionNotificationsEnabled',
            testId: 'general-task-completion-notifications-toggle',
            label: t('workbench.general_settings_task_completion_notifications'),
            description: t('workbench.general_settings_task_completion_notifications_description'),
          })}
          <SettingsRow
            label={t('workbench.friendly_task_titles_title', '使用友好标题')}
            description={t(
              'workbench.friendly_task_titles_desc',
              '创建任务后，用你选择的模型异步生成简洁标题。'
            )}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            control={
              <SettingsSwitch
                data-testid="friendly-task-titles-toggle"
                checked={preferences.friendlyTaskTitlesEnabled}
                disabled={
                  loading ||
                  saving ||
                  (!friendlyTitleModel?.modelName && !workbench?.projectChat.selectedModel)
                }
                onCheckedChange={checked => {
                  void saveFriendlyTaskTitles(checked, friendlyTitleModelKey)
                }}
                aria-label={t('workbench.friendly_task_titles_title', '使用友好标题')}
              />
            }
          />
          {preferences.friendlyTaskTitlesEnabled && (
            <div data-testid="friendly-task-title-model-row" className="px-4 pb-3">
              <div className="ml-3 flex items-center justify-between gap-4 rounded-lg bg-muted/50 px-3 py-2.5 max-sm:ml-0 max-sm:flex-col max-sm:items-stretch">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-text-primary">
                    {t('workbench.friendly_task_titles_model', '标题模型')}
                  </div>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {t(
                      'workbench.friendly_task_titles_model_desc',
                      '仅用于生成任务标题，不影响当前任务使用的模型。'
                    )}
                  </p>
                </div>
                <select
                  data-testid="friendly-task-title-model-select"
                  value={friendlyTitleModelKey}
                  disabled={loading || saving}
                  onChange={event => {
                    void saveFriendlyTaskTitles(
                      preferences.friendlyTaskTitlesEnabled,
                      event.target.value
                    )
                  }}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary md:w-[220px]"
                >
                  <option value={FRIENDLY_TITLE_TASK_MODEL_VALUE}>
                    {t('workbench.friendly_task_titles_model_task', '与任务相同')}
                  </option>
                  {friendlyTitleModels.map(model => (
                    <option
                      key={`${model.type}:${model.name}`}
                      value={`${model.type}:${model.name}`}
                    >
                      {model.displayName || model.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <SettingsRow
            label={
              <span className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-text-secondary" />
                {t('workbench.general_settings_tray_display_content')}
              </span>
            }
            description={t('workbench.general_settings_tray_display_content_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            control={
              <div className="grid w-[420px] max-w-full shrink-0 grid-cols-2 gap-2">
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
                      onClick={() => void handlePreferenceChange(option.preferenceKey, !selected)}
                      className={`group flex h-9 items-center justify-between gap-2 rounded-md border px-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
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
            }
          />
        </SettingsGroup>
      </section>

      <section data-testid="general-settings-privacy-section" className="mt-12">
        <div className="mb-2 px-0.5 text-sm font-semibold text-text-primary">
          {t('workbench.general_settings_privacy_title')}
        </div>
        <SettingsGroup className="rounded-xl !bg-background">
          {renderSwitchRow({
            preferenceKey: 'telemetryEnabled',
            testId: 'general-telemetry-toggle',
            label: t('workbench.general_settings_telemetry'),
            description: t('workbench.general_settings_telemetry_description'),
          })}
        </SettingsGroup>
      </section>

      <section data-testid="general-settings-popout-section" className="mt-12">
        <div className="mb-2 px-0.5 text-sm font-semibold text-text-primary">
          {t('workbench.general_settings_popout_title')}
        </div>
        <SettingsGroup className="rounded-xl !bg-background">
          <SettingsRow
            label={t('workbench.general_settings_popout_shortcut')}
            description={t('workbench.general_settings_popout_shortcut_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            control={
              <div className="flex min-w-[220px] items-center justify-end gap-1">
                <button
                  type="button"
                  data-testid="general-popout-shortcut-record-button"
                  disabled={loading || saving}
                  onClick={() => setRecordingPopoutShortcut(true)}
                  className="inline-flex min-h-8 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 max-md:min-h-11"
                  aria-label={t('workbench.general_settings_popout_shortcut_edit')}
                >
                  {recordingPopoutShortcut ? (
                    <span className="rounded-full bg-muted px-2.5 py-1">
                      {t('workbench.keyboard_shortcuts_recording')}
                    </span>
                  ) : preferences.popoutWindowShortcut ? (
                    <KeyboardShortcut
                      value={preferences.popoutWindowShortcut.replace(
                        'CommandOrControl',
                        'Command'
                      )}
                      className="bg-muted text-text-secondary"
                    />
                  ) : (
                    <span>{t('workbench.keyboard_shortcuts_unassigned')}</span>
                  )}
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  data-testid="general-popout-shortcut-clear-button"
                  disabled={loading || saving || !preferences.popoutWindowShortcut}
                  onClick={() => void savePopoutShortcut(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 max-md:h-11 max-md:w-11"
                  aria-label={t('workbench.keyboard_shortcuts_clear')}
                  title={t('workbench.keyboard_shortcuts_clear')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            }
          />
          {renderSwitchRow({
            preferenceKey: 'systemDragEnabled',
            testId: 'general-system-drag-toggle',
            label: t('workbench.general_settings_system_drag'),
            description: t('workbench.general_settings_system_drag_description'),
          })}
        </SettingsGroup>
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
      {showImportDialog && (
        <ExternalContentImportDialog onClose={() => setShowImportDialog(false)} />
      )}
    </SettingsPage>
  )
}
