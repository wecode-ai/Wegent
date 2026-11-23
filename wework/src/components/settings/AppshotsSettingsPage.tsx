import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Loader2, Pencil, ScanLine, Trash2 } from 'lucide-react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
} from '@/desktop/appPreferences'
import {
  getAppshotsStatus,
  openAppshotsPermissionSettings,
  type AppshotPermission,
} from '@/desktop/appshots'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { IconButton } from '@wegent/collaboration/controls/IconButton'
import { keybindingFromKeyboardEvent, normalizeKeybinding } from '@/lib/keybindings'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

export function AppshotsSettingsPage() {
  const { t } = useTranslation('common')
  const [statusResource] = useState(() =>
    createAsyncResource('appshots-status', getAppshotsStatus, {
      failure: cause => console.error('[Wework] Failed to load Appshots status:', cause),
    })
  )
  const [preferencesResource] = useState(() =>
    createAsyncResource('appshots-preferences', getAppPreferences, {
      failure: cause => console.error('[Wework] Failed to load Appshots preferences:', cause),
    })
  )
  const statusState = useSyncExternalStore(
    statusResource.subscribe,
    statusResource.getSnapshot,
    statusResource.getSnapshot
  )
  const preferencesState = useSyncExternalStore(
    preferencesResource.subscribe,
    preferencesResource.getSnapshot,
    preferencesResource.getSnapshot
  )
  const status = statusState.data
  const playSound =
    preferencesState.data?.appshotsPlaySound ?? defaultAppPreferences.appshotsPlaySound
  const loading = statusState.status === 'idle' || statusState.status === 'loading'
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<'save' | 'permission' | 'shortcut' | null>(null)
  const loadFailedText = t('workbench.appshots_load_failed', '应用快照设置加载失败')
  const error =
    failure === 'shortcut'
      ? t(
          'workbench.appshots_shortcut_unavailable',
          '快捷键已被其他应用占用，请退出冲突的应用后重启 Wework。'
        )
      : failure === 'save'
        ? t('workbench.appshots_save_failed', '应用快照设置保存失败')
        : failure === 'permission'
          ? t('workbench.appshots_open_settings_failed', '无法打开系统设置')
          : statusState.status === 'error' || preferencesState.status === 'error'
            ? loadFailedText
            : null
  const [savingShortcut, setSavingShortcut] = useState(false)
  const [recordingShortcut, setRecordingShortcut] = useState(false)

  useWindowEvent('focus', () => {
    void statusResource.reload()
  })

  const updatePlaySound = async (value: boolean) => {
    setSaving(true)
    setFailure(null)
    try {
      const preferences = await updateAppPreferences({ appshotsPlaySound: value })
      preferencesResource.update(() => preferences)
    } catch (saveError) {
      console.error('[Wework] Failed to save Appshots settings:', saveError)
      setFailure('save')
    } finally {
      setSaving(false)
    }
  }

  const saveShortcut = useCallback(
    async (shortcut: string | null) => {
      setSavingShortcut(true)
      setFailure(null)
      try {
        await updateAppPreferences({ appshotsShortcut: shortcut })
        const nextStatus = await getAppshotsStatus()
        statusResource.update(() => nextStatus)
        setRecordingShortcut(false)
      } catch (saveError) {
        console.error('[Wework] Failed to save Appshots shortcut:', saveError)
        const unavailable =
          saveError instanceof Error && saveError.message.includes('Global shortcut is unavailable')
        setFailure(unavailable ? 'shortcut' : 'save')
      } finally {
        setSavingShortcut(false)
      }
    },
    [statusResource]
  )

  useWindowEvent(
    'keydown',
    event => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecordingShortcut(false)
        return
      }
      const shortcut = normalizeKeybinding(keybindingFromKeyboardEvent(event, true))
      if (!shortcut || !shortcut.includes('+')) return
      void saveShortcut(shortcut)
    },
    { enabled: recordingShortcut, capture: true }
  )

  const shortcutReady = status?.supported && status.shortcutRegistered
  const shortcutDescription = loading
    ? t('common.loading', '加载中...')
    : recordingShortcut
      ? t('workbench.keyboard_shortcuts_recording', '按下快捷键')
      : !status?.supported
        ? t('workbench.appshots_macos_only', '应用快照目前仅支持 macOS。')
        : !status.shortcut
          ? t(
              'workbench.appshots_shortcut_unassigned_description',
              '录制一个快捷键，在任意应用中截取最前面的窗口。'
            )
          : shortcutReady
            ? t('workbench.appshots_shortcut_description', '在任意应用中截取最前面的窗口')
            : t(
                'workbench.appshots_shortcut_unavailable',
                '快捷键已被其他应用占用，请退出冲突的应用后重启 Wework。'
              )

  const openPermissionSettings = (permission: AppshotPermission) => {
    setFailure(null)
    void openAppshotsPermissionSettings(permission).catch(openError => {
      console.error('[Wework] Failed to open Appshots permission settings:', openError)
      setFailure('permission')
    })
  }

  const permissionControl = (
    permission: AppshotPermission,
    granted: boolean | undefined,
    testId: string
  ) =>
    granted ? (
      <span className="text-xs font-medium text-primary">
        {t('workbench.appshots_permission_granted', '已允许')}
      </span>
    ) : (
      <ControlButton
        variant="outline"
        size="sm"
        type="button"
        data-testid={testId}
        onClick={() => openPermissionSettings(permission)}
      >
        {t('workbench.appshots_open_permission_settings', '打开系统设置')}
      </ControlButton>
    )

  return (
    <SettingsPage width="narrow" data-testid="appshots-settings-page">
      <SettingsPageHeader
        title={t('workbench.appshots_title', '应用快照')}
        description={t(
          'workbench.appshots_subtitle',
          '捕捉最前面的应用窗口，并直接添加到 Wework 输入框'
        )}
      />

      <div className="mb-4 flex items-start gap-3 rounded-2xl border border-border bg-surface/70 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ScanLine className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">
            {t('workbench.appshots_callout_title', '快速分享当前应用')}
          </div>
          <div className="mt-0.5 text-xs leading-4 text-text-secondary">
            {t(
              'workbench.appshots_callout_description',
              '按下快捷键后，Wework 会截取最前面的窗口、回到工作台并附加图片。'
            )}
          </div>
        </div>
      </div>

      {error ? (
        <div
          data-testid="appshots-settings-error"
          className="mb-4 text-sm text-destructive wework:text-red-500"
        >
          {error}
        </div>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          label={t('workbench.appshots_shortcut', '快捷键')}
          description={shortcutDescription}
          children={
            loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : statusState.status === 'error' ? (
              <span className="text-xs text-text-secondary">{loadFailedText}</span>
            ) : (
              <div className="flex min-w-[200px] items-center justify-end gap-1">
                <ControlButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  data-testid="appshots-shortcut-record-button"
                  disabled={savingShortcut || !status?.supported}
                  onClick={() => setRecordingShortcut(true)}
                  className="gap-2"
                  aria-label={t('workbench.appshots_shortcut_edit', '录制快捷键')}
                >
                  {recordingShortcut ? (
                    <span className="rounded-full bg-muted px-2.5 py-1">
                      {t('workbench.keyboard_shortcuts_recording', '按下快捷键')}
                    </span>
                  ) : status?.shortcut ? (
                    <KeyboardShortcut
                      value={status.shortcut.replace('CommandOrControl', 'Command')}
                      className="bg-muted text-text-secondary"
                    />
                  ) : (
                    <span>{t('workbench.keyboard_shortcuts_unassigned', '未设置')}</span>
                  )}
                  <Pencil className="h-4 w-4" />
                </ControlButton>
                <IconButton
                  type="button"
                  data-testid="appshots-shortcut-clear-button"
                  disabled={savingShortcut || !status?.supported || !status.shortcut}
                  onClick={() => void saveShortcut(null)}
                  aria-label={t('workbench.keyboard_shortcuts_clear', '清除')}
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </IconButton>
              </div>
            )
          }
        />
        <SettingsRow
          label={t('workbench.appshots_screen_capture_permission', '屏幕录制权限')}
          description={t(
            'workbench.appshots_screen_capture_permission_description',
            '用于截取最前面的应用窗口'
          )}
          children={permissionControl(
            'screenCapture',
            status?.screenCapturePermissionGranted,
            'appshots-open-screen-capture-settings-button'
          )}
        />
        <SettingsRow
          label={t('workbench.appshots_accessibility_permission', '辅助功能权限')}
          description={t(
            'workbench.appshots_accessibility_permission_description_short',
            '用于读取窗口可用文本，包括滚动区域外文本'
          )}
          children={permissionControl(
            'accessibility',
            status?.accessibilityPermissionGranted,
            'appshots-open-accessibility-settings-button'
          )}
        />
        <SettingsRow
          label={t('workbench.appshots_target', 'Appshot 目标位置')}
          description={t(
            'workbench.appshots_target_description',
            '快照会自动添加到当前 Wework 输入框'
          )}
          children={
            <span className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-text-secondary">
              {t('workbench.appshots_target_auto', '自动')}
            </span>
          }
        />
        <SettingsRow
          label={t('workbench.appshots_play_sound', '播放声音')}
          description={t('workbench.appshots_play_sound_description', '成功截取窗口时播放系统声音')}
          children={
            <SettingsSwitch
              data-testid="appshots-play-sound-toggle"
              checked={playSound}
              disabled={preferencesState.status !== 'ready' || saving || !status?.supported}
              onCheckedChange={value => void updatePlaySound(value)}
            />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
