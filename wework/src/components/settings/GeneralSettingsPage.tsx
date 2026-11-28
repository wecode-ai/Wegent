import { harnessAppsApi } from '@/api/local/harnessApps'
import { getWegentUsageDisplay } from '@/api/wegentUsage'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppLanguagePreference,
  type AppPreferences,
  type AppPreferencesPatch,
  type FixedWorkspaceTabPreference,
  type WorkbenchMode,
} from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { DshSettingsSectionSurface } from '@/features/dsh-runtime/DshSettingsSectionSurface'
import { changeWorkbenchMode } from '@/features/workbench-mode/workbenchMode'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import {
  fixedWorkspaceTabsPatch,
  saveFixedWorkspaceTabs as persistFixedWorkspaceTabs,
} from '@/features/workspace-tabs/fixedWorkspaceTabs'
import { useTranslation } from '@/hooks/useTranslation'
import { applyLanguagePreference, languagePreferenceOptions } from '@/i18n/languagePreference'
import { keybindingFromKeyboardEvent, normalizeKeybinding } from '@/lib/keybindings'
import { getPlatform } from '@/lib/platform'
import { TelemetryCollectionNotice } from '@/telemetry/TelemetryCollectionNotice'
import { saveTelemetryConsent, useSessionTelemetryConsent } from '@/telemetry/sessionConsent'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  Activity,
  Bell,
  Check,
  CircleDot,
  Gauge,
  Loader2,
  Pencil,
  type LucideIcon,
} from 'lucide-react'
import { useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { DefaultRunnerSetting } from './DefaultRunnerSetting'
import { ExternalContentImportDialog } from './ExternalContentImportDialog'
import { GeneralFixedWorkspaceTabs } from './GeneralFixedWorkspaceTabs'
import { ReplyPredictionSettings } from './ReplyPredictionSettings'
import { RuntimeConcurrencySettings } from './RuntimeConcurrencySettings'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitch,
} from './settings-ui'

import { detailedTelemetryPreference, getTelemetryConfig } from '@/telemetry/config'

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
  const sessionTelemetryConsent = useSessionTelemetryConsent()
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const appPreferences = useAppPreferencesState()
  const workbench = useContext(WorkbenchContext)
  const [preferenceResource] = useState(() =>
    createAsyncResource('settings/general-preferences', () => getAppPreferences(), {
      refreshOnSubscribe: true,
      failure(error) {
        console.error('[Wework] Failed to load app preferences', error)
      },
    })
  )
  const preferenceSnapshot = useSyncExternalStore(
    appPreferences ? subscribeIdleResource : preferenceResource.subscribe,
    preferenceResource.getSnapshot
  )
  const sourcePreferences = appPreferences
    ? appPreferences.loaded
      ? appPreferences.preferences
      : undefined
    : preferenceSnapshot.data
  const [preferences, setPreferences] = useState<AppPreferences>(
    sourcePreferences ?? defaultAppPreferences
  )
  const [preferenceSource, setPreferenceSource] = useState(sourcePreferences)
  if (sourcePreferences && sourcePreferences !== preferenceSource) {
    setPreferenceSource(sourcePreferences)
    setPreferences(sourcePreferences)
  }
  const loading = appPreferences ? !appPreferences.loaded : !preferenceSnapshot.settled
  const [saving, setSaving] = useState(false)
  const [actionError, setError] = useState<string | null>(null)
  const error =
    actionError ??
    (!appPreferences && preferenceSnapshot.status === 'error'
      ? t('workbench.general_settings_load_failed')
      : null)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [pendingWorkbenchMode, setPendingWorkbenchMode] = useState<WorkbenchMode | null>(null)
  const [recordingPopoutShortcut, setRecordingPopoutShortcut] = useState(false)
  const [pendingSendKey, setPendingSendKey] = useState<'enter' | 'cmd_enter' | null>(null)
  const [pendingFollowUpBehavior, setPendingFollowUpBehavior] = useState<'queue' | 'guide' | null>(
    null
  )
  const persistedSendKey = workbench?.state?.user?.preferences?.send_key ?? 'enter'
  const sendKey = pendingSendKey ?? persistedSendKey
  const persistedFollowUpBehavior =
    workbench?.state?.user?.preferences?.follow_up_behavior ?? 'queue'
  const followUpBehavior = pendingFollowUpBehavior ?? persistedFollowUpBehavior

  const [smartAppsResource] = useState(() =>
    createAsyncResource('settings/fixed-smart-apps', () => harnessAppsApi.list(), {
      refreshOnSubscribe: true,
      failure(error) {
        console.warn('[Wework] Failed to load installed Smart apps for fixed tabs', error)
      },
    })
  )
  const smartAppsSnapshot = useSyncExternalStore(
    preferences.experimentalFeaturesEnabled ? smartAppsResource.subscribe : subscribeIdleResource,
    smartAppsResource.getSnapshot
  )
  const installedSmartApps = preferences.experimentalFeaturesEnabled
    ? (smartAppsSnapshot.data ?? [])
    : []
  const { isConnected, apiBaseUrl, token, serviceKey } = cloudConnection
  const userId = cloudConnection.user?.id
  const quotaConnection = useMemo(
    () => ({ isConnected, apiBaseUrl, token, serviceKey, userId }),
    [isConnected, apiBaseUrl, token, serviceKey, userId]
  )
  const quotaResource = useMemo(
    () =>
      createAsyncResource('settings/cloud-quota-name', () =>
        getWegentUsageDisplay(quotaConnection)
      ),
    [quotaConnection]
  )
  const quotaSnapshot = useSyncExternalStore(
    isConnected ? quotaResource.subscribe : subscribeIdleResource,
    quotaResource.getSnapshot
  )
  const cloudQuotaName =
    quotaSnapshot.data?.status === 'available' ? quotaSnapshot.data.sourceText : null

  const handlePreferenceChange = async (key: BooleanPreferenceKey, value: boolean) => {
    setPreferences(current => ({ ...current, [key]: value }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences =
        key === 'detailedTelemetryEnabled'
          ? await updateAppPreferences(
              detailedTelemetryPreference(value),
              preferences.telemetryConsentRevision
            )
          : key === 'telemetryEnabled'
            ? await saveTelemetryConsent(value, preferences.telemetryConsentRevision)
            : await updateAppPreferences({ [key]: value })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[Wework] Failed to update app preferences', saveError)
      setPreferences(current => ({
        ...current,
        [key]: key === 'telemetryEnabled' && !value ? false : !value,
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

  useWindowEvent(
    'keydown',
    event => {
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
    },
    { enabled: recordingPopoutShortcut, capture: true }
  )

  const renderSwitchRow = ({ preferenceKey, testId, label, description }: SwitchRowProps) => (
    <SettingsRow
      label={label}
      description={description}
      className={GENERAL_ROW_CLASS_NAME}
      labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
      children={
        <SettingsSwitch
          data-testid={testId}
          checked={
            preferenceKey === 'telemetryEnabled' && sessionTelemetryConsent === false
              ? false
              : Boolean(preferences[preferenceKey])
          }
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
    // The Codex quota is meaningless while the local Codex subscription is off:
    // the tray has no rate limits to read, so the toggle is hidden entirely.
    ...(preferences.localCodexSubscriptionEnabled
      ? [
          {
            preferenceKey: 'trayUsageEnabled',
            testId: 'general-tray-usage-toggle',
            label: t('workbench.general_settings_tray_usage'),
            description: t('workbench.general_settings_tray_usage_description'),
            icon: Gauge,
          } satisfies TrayDisplayOption,
        ]
      : []),
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

  const handleSendKeyChange = async (nextSendKey: 'enter' | 'cmd_enter') => {
    if (nextSendKey === sendKey || !workbench?.updateUserPreferences) return

    setPendingSendKey(nextSendKey)
    setSaving(true)
    setError(null)
    try {
      await workbench.updateUserPreferences({ send_key: nextSendKey })
    } catch (saveError) {
      console.error('[Wework] Failed to update message send shortcut', saveError)
      setError(t('workbench.general_settings_send_key_save_failed'))
    } finally {
      setPendingSendKey(null)
      setSaving(false)
    }
  }

  const handleFollowUpBehaviorChange = async (nextFollowUpBehavior: 'queue' | 'guide') => {
    if (nextFollowUpBehavior === followUpBehavior || !workbench?.updateUserPreferences) {
      return
    }

    setPendingFollowUpBehavior(nextFollowUpBehavior)
    setSaving(true)
    setError(null)
    try {
      await workbench.updateUserPreferences({
        follow_up_behavior: nextFollowUpBehavior,
      })
    } catch (saveError) {
      console.error('[Wework] Failed to update follow-up behavior', saveError)
      setError(t('workbench.general_settings_follow_up_behavior_save_failed'))
    } finally {
      setPendingFollowUpBehavior(null)
      setSaving(false)
    }
  }

  const confirmWorkbenchModeChange = async () => {
    if (!pendingWorkbenchMode) return
    if (pendingWorkbenchMode === preferences.workbenchMode) {
      setPendingWorkbenchMode(null)
      return
    }

    const nextMode = pendingWorkbenchMode
    setPreferences(current => ({ ...current, workbenchMode: nextMode }))
    setSaving(true)
    setError(null)
    try {
      setPreferences(await changeWorkbenchMode(nextMode))
    } catch (saveError) {
      console.error('[Wework] Failed to update workbench mode', saveError)
      try {
        setPreferences(await getAppPreferences())
      } catch (refreshError) {
        console.error(
          '[Wework] Failed to refresh workbench mode after update failure',
          refreshError
        )
      }
      setError(t('workbench.general_settings_mode_save_failed'))
    } finally {
      setPendingWorkbenchMode(null)
      setSaving(false)
    }
  }

  const saveFixedWorkspaceTabs = async (
    fixedWorkspaceTabs: FixedWorkspaceTabPreference[],
    startupWorkspaceTabId = preferences.startupWorkspaceTabId ??
      defaultAppPreferences.startupWorkspaceTabId
  ) => {
    const patch = fixedWorkspaceTabsPatch(fixedWorkspaceTabs, startupWorkspaceTabId)
    const previousPreferences = preferences
    setPreferences(current => ({
      ...current,
      ...patch,
    }))
    setSaving(true)
    setError(null)
    try {
      setPreferences(await persistFixedWorkspaceTabs(fixedWorkspaceTabs, startupWorkspaceTabId))
    } catch (saveError) {
      console.error('[Wework] Failed to update fixed workspace tabs', saveError)
      setPreferences(previousPreferences)
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
    const selectedModel = workbench?.projectChat?.models.find(
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
  const fixedWorkspaceTabs =
    preferences.fixedWorkspaceTabs ?? defaultAppPreferences.fixedWorkspaceTabs
  const startupWorkspaceTabId =
    preferences.startupWorkspaceTabId ?? defaultAppPreferences.startupWorkspaceTabId
  const friendlyTitleModels = workbench?.projectChat?.models ?? []
  const friendlyTitleModelKey = friendlyTitleModel
    ? `${friendlyTitleModel.modelType ?? ''}:${friendlyTitleModel.modelName}`
    : FRIENDLY_TITLE_TASK_MODEL_VALUE

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
          <DefaultRunnerSetting />
          <SettingsRow
            label={t('workbench.general_settings_mode')}
            description={t('workbench.general_settings_mode_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            children={
              <SettingsSegmentedControl
                label={t('workbench.general_settings_mode')}
                value={preferences.workbenchMode}
                disabled={loading || saving}
                onChange={mode => {
                  if (mode !== preferences.workbenchMode) setPendingWorkbenchMode(mode)
                }}
                options={(['focus', 'developer'] as const).map(mode => ({
                  value: mode,
                  label: t(`workbench.general_settings_mode_${mode}`),
                  title: t(`workbench.general_settings_mode_${mode}_description`),
                  testId: `general-workbench-mode-${mode}-button`,
                }))}
              />
            }
          />
          <SettingsRow
            label={t('workbench.general_settings_language_preference')}
            description={t('workbench.general_settings_language_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            children={
              <SettingsSegmentedControl
                label={t('workbench.general_settings_language_preference')}
                value={preferences.language}
                disabled={loading || saving}
                onChange={value => void handleLanguageChange(value)}
                options={languagePreferenceOptions.map(option => ({
                  value: option.value,
                  label: t(`workbench.${option.shortLabelKey}`),
                  title: t(`workbench.${option.descriptionKey}`),
                  testId: `general-language-${option.value}-button`,
                }))}
              />
            }
          />
          <SettingsRow
            label={t('workbench.general_settings_send_key')}
            description={t('workbench.general_settings_send_key_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            children={
              <SettingsSegmentedControl
                label={t('workbench.general_settings_send_key')}
                value={sendKey}
                disabled={loading || saving || !workbench?.updateUserPreferences}
                onChange={value => void handleSendKeyChange(value)}
                options={(['enter', 'cmd_enter'] as const).map(option => ({
                  value: option,
                  label:
                    option === 'enter'
                      ? t('workbench.general_settings_send_key_enter')
                      : t(
                          'workbench.general_settings_send_key_command_enter',
                          '{{modifier}} Enter 发送',
                          { modifier: getPlatform() === 'mac' ? '⌘' : 'Ctrl' }
                        ),
                  testId: `general-send-key-${option}-button`,
                }))}
              />
            }
          />
          <SettingsRow
            label={t('workbench.general_settings_follow_up_behavior')}
            description={t('workbench.general_settings_follow_up_behavior_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            children={
              <SettingsSegmentedControl
                label={t('workbench.general_settings_follow_up_behavior')}
                value={followUpBehavior}
                disabled={loading || saving || !workbench?.updateUserPreferences}
                onChange={value => void handleFollowUpBehaviorChange(value)}
                options={(['queue', 'guide'] as const).map(option => ({
                  value: option,
                  label: t(`workbench.general_settings_follow_up_behavior_${option}`),
                  testId: `general-follow-up-${option}-button`,
                }))}
              />
            }
          />
          <GeneralFixedWorkspaceTabs
            fixedWorkspaceTabs={fixedWorkspaceTabs}
            startupWorkspaceTabId={startupWorkspaceTabId}
            collaborationExperienceEnabled={preferences.collaborationExperienceEnabled}
            experimentalFeaturesEnabled={preferences.experimentalFeaturesEnabled}
            installedSmartApps={installedSmartApps}
            disabled={loading || saving}
            onSave={saveFixedWorkspaceTabs}
          />
          {preferences.experimentalFeaturesEnabled && smartAppsSnapshot.status === 'error' && (
            <div
              data-testid="general-smart-apps-error"
              className="px-4 py-3 text-sm text-destructive"
            >
              <span>{t('workbench.smart_apps_load_failed')}</span>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="general-smart-apps-retry"
                onClick={() => void smartAppsResource.reload()}
                className="ml-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
              >
                {t('common.retry')}
              </ControlButton>
            </div>
          )}
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
          {preferences.experimentalFeaturesEnabled || preferences.collaborationExperienceEnabled
            ? renderSwitchRow({
                preferenceKey: 'collaborationExperienceEnabled',
                testId: 'general-collaboration-experience-toggle',
                label: t('workbench.general_settings_collaboration_experience'),
                description: t('workbench.general_settings_collaboration_experience_description'),
              })
            : null}
          <SettingsRow
            label={t('workbench.external_import_row_title')}
            description={t('workbench.external_import_row_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            children={
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="general-external-content-import-button"
                onClick={() => setShowImportDialog(true)}
                className="h-11 rounded-md bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted md:h-8"
              >
                {t('workbench.external_import_action')}
              </ControlButton>
            }
          />
        </SettingsGroup>
      </section>

      <div className="mt-12 space-y-12 empty:hidden">
        <DshSettingsSectionSurface page="general" />
      </div>

      <section data-testid="general-settings-runtime-section" className="mt-12">
        <div className="mb-2 px-0.5 text-sm font-semibold text-text-primary">
          {t('workbench.general_settings_runtime_title')}
        </div>
        <SettingsGroup className="rounded-xl !bg-background">
          <RuntimeConcurrencySettings />
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
            preferenceKey: 'performanceRecordingEnabled',
            testId: 'general-performance-recording-toggle',
            label: t('workbench.general_settings_performance_recording'),
            description: t('workbench.general_settings_performance_recording_description'),
          })}
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
            children={
              <div className="grid w-[420px] max-w-full shrink-0 grid-cols-2 gap-2">
                {trayDisplayOptions.map(option => {
                  const Icon = option.icon
                  const selected = Boolean(preferences[option.preferenceKey])
                  return (
                    <ControlButton
                      variant="unstyled"
                      key={option.preferenceKey}
                      data-testid={option.testId}
                      type="button"
                      aria-pressed={selected}
                      title={option.description}
                      disabled={loading || saving}
                      onClick={() => void handlePreferenceChange(option.preferenceKey, !selected)}
                      className={`group flex h-11 items-center justify-between gap-2 rounded-md border px-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 md:h-9 ${
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
                    </ControlButton>
                  )
                })}
              </div>
            }
          />
        </SettingsGroup>
      </section>

      <section data-testid="general-settings-ai-section" className="mt-12">
        <div className="mb-2 px-0.5 text-sm font-semibold text-text-primary">
          {t('workbench.general_settings_ai_title')}
        </div>
        <SettingsGroup className="rounded-xl !bg-background">
          <SettingsRow
            label={t('workbench.friendly_task_titles_title', '使用友好标题')}
            description={t(
              'workbench.friendly_task_titles_desc',
              '创建任务后，用你选择的模型异步生成简洁标题。'
            )}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            children={
              <SettingsSwitch
                data-testid="friendly-task-titles-toggle"
                checked={preferences.friendlyTaskTitlesEnabled}
                disabled={
                  loading ||
                  saving ||
                  (!friendlyTitleModel?.modelName && !workbench?.projectChat?.selectedModel)
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
              <div className="ml-3 flex items-center justify-between gap-4 rounded-lg bg-muted/50 px-3 py-2.5 max-md:ml-0 max-md:flex-col max-md:items-stretch">
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
                <SelectRoot
                  value={normalizeSelectValue(friendlyTitleModelKey)}
                  disabled={loading || saving}
                  onValueChange={selectedValue => {
                    if (selectedValue === null) return
                    void saveFriendlyTaskTitles(
                      preferences.friendlyTaskTitlesEnabled,
                      selectedValue
                    )
                  }}
                >
                  <SelectTrigger
                    aria-label={t('workbench.friendly_task_titles_model')}
                    data-testid="friendly-task-title-model-select"
                    className="w-full md:w-[220px]"
                  />
                  <SelectContent>
                    <SelectItem value={String(FRIENDLY_TITLE_TASK_MODEL_VALUE)}>
                      {t('workbench.friendly_task_titles_model_task', '与任务相同')}
                    </SelectItem>
                    {friendlyTitleModel &&
                      !friendlyTitleModels.some(
                        model =>
                          model.name === friendlyTitleModel.modelName &&
                          model.type === friendlyTitleModel.modelType
                      ) && (
                        <SelectItem value={String(friendlyTitleModelKey)}>
                          {t(
                            'workbench.friendly_task_titles_model_unavailable',
                            `${friendlyTitleModel.modelName}（不可用）`,
                            { modelName: friendlyTitleModel.modelName }
                          )}
                        </SelectItem>
                      )}
                    {friendlyTitleModels.map(model => (
                      <SelectItem
                        key={`${model.type}:${model.name}`}
                        value={String(`${model.type}:${model.name}`)}
                      >
                        {model.displayName || model.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </div>
            </div>
          )}
          <ReplyPredictionSettings />
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
          {preferences.telemetryEnabled &&
            sessionTelemetryConsent !== false &&
            getTelemetryConfig().posthogKey &&
            renderSwitchRow({
              preferenceKey: 'detailedTelemetryEnabled',
              testId: 'general-detailed-telemetry-toggle',
              label: t('workbench.detailed_telemetry_enabled'),
              description: t('workbench.detailed_telemetry_description', {
                host: getTelemetryConfig().posthogHost,
              }),
            })}
        </SettingsGroup>
        <TelemetryCollectionNotice />
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
            children={
              <div className="flex min-w-[220px] items-center justify-end gap-1">
                <ControlButton
                  variant="unstyled"
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
                </ControlButton>
                <DeleteIconButton
                  type="button"
                  data-testid="general-popout-shortcut-clear-button"
                  disabled={loading || saving || !preferences.popoutWindowShortcut}
                  onClick={() => void savePopoutShortcut(null)}
                  aria-label={t('workbench.keyboard_shortcuts_clear')}
                  title={t('workbench.keyboard_shortcuts_clear')}
                />
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
      {!appPreferences && preferenceSnapshot.status === 'error' && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="general-settings-retry"
          onClick={() => void preferenceResource.reload()}
          className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
        >
          {t('common.retry')}
        </ControlButton>
      )}
      {showImportDialog && (
        <ExternalContentImportDialog onClose={() => setShowImportDialog(false)} />
      )}
      <ConfirmDialog
        open={pendingWorkbenchMode !== null}
        title={
          pendingWorkbenchMode
            ? t(`workbench.general_settings_mode_${pendingWorkbenchMode}_confirm_title`)
            : ''
        }
        description={
          pendingWorkbenchMode
            ? t(`workbench.general_settings_mode_${pendingWorkbenchMode}_confirm_description`)
            : ''
        }
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.general_settings_mode_confirm_action')}
        confirmTestId="general-workbench-mode-confirm-button"
        focusCancel
        pending={saving}
        onClose={() => setPendingWorkbenchMode(null)}
        onConfirm={() => void confirmWorkbenchModeChange()}
      />
    </SettingsPage>
  )
}
