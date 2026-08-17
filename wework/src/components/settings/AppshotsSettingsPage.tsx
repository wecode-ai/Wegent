import { Loader2, ScanLine } from 'lucide-react'
import { useEffect, useState } from 'react'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
} from '@/tauri/appPreferences'
import {
  getAppshotsStatus,
  openAppshotsPermissionSettings,
  type AppshotPermission,
  type AppshotsStatus,
} from '@/tauri/appshots'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

export function AppshotsSettingsPage() {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<AppshotsStatus | null>(null)
  const [playSound, setPlaySound] = useState(defaultAppPreferences.appshotsPlaySound)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([getAppshotsStatus(), getAppPreferences()])
      .then(([nextStatus, preferences]) => {
        if (!active) return
        setStatus(nextStatus)
        setPlaySound(preferences.appshotsPlaySound)
      })
      .catch(loadError => {
        console.error('[Wework] Failed to load Appshots settings:', loadError)
        if (active) setError(t('workbench.appshots_load_failed', '应用快照设置加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [t])

  const updatePlaySound = async (value: boolean) => {
    setSaving(true)
    setError(null)
    try {
      const preferences = await updateAppPreferences({ appshotsPlaySound: value })
      setPlaySound(preferences.appshotsPlaySound)
    } catch (saveError) {
      console.error('[Wework] Failed to save Appshots settings:', saveError)
      setError(t('workbench.appshots_save_failed', '应用快照设置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const shortcutReady = status?.supported && status.shortcutRegistered
  const openPermissionSettings = (permission: AppshotPermission) => {
    void openAppshotsPermissionSettings(permission).catch(openError => {
      console.error('[Wework] Failed to open Appshots permission settings:', openError)
      setError(t('workbench.appshots_open_settings_failed', '无法打开系统设置'))
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
      <button
        type="button"
        data-testid={testId}
        onClick={() => openPermissionSettings(permission)}
        className="h-8 rounded-md border border-border px-2.5 text-xs font-medium text-text-primary hover:bg-muted"
      >
        {t('workbench.appshots_open_permission_settings', '打开系统设置')}
      </button>
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
        <div data-testid="appshots-settings-error" className="mb-4 text-sm text-red-500">
          {error}
        </div>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          label={t('workbench.appshots_shortcut', '快捷键')}
          description={
            loading
              ? t('common.loading', '加载中...')
              : shortcutReady
                ? t('workbench.appshots_shortcut_description', '在任意应用中截取最前面的窗口')
                : status?.supported
                  ? t(
                      'workbench.appshots_shortcut_unavailable',
                      '快捷键已被其他应用占用，请退出冲突的应用后重启 Wework。'
                    )
                  : t('workbench.appshots_macos_only', '应用快照目前仅支持 macOS。')
          }
          control={
            loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : (
              <KeyboardShortcut
                value={(status?.shortcut ?? 'CommandOrControl+Shift+2').replace(
                  'CommandOrControl',
                  'Command'
                )}
                className="bg-muted text-text-secondary"
              />
            )
          }
        />
        <SettingsRow
          label={t('workbench.appshots_screen_capture_permission', '屏幕录制权限')}
          description={t(
            'workbench.appshots_screen_capture_permission_description',
            '用于截取最前面的应用窗口'
          )}
          control={permissionControl(
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
          control={permissionControl(
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
          control={
            <span className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-text-secondary">
              {t('workbench.appshots_target_auto', '自动')}
            </span>
          }
        />
        <SettingsRow
          label={t('workbench.appshots_play_sound', '播放声音')}
          description={t('workbench.appshots_play_sound_description', '成功截取窗口时播放系统声音')}
          control={
            <SettingsSwitch
              data-testid="appshots-play-sound-toggle"
              checked={playSound}
              disabled={loading || saving || !status?.supported}
              onCheckedChange={value => void updatePlaySound(value)}
            />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
