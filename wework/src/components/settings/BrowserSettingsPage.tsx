import { FolderOpen, History, Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { stripAppBasePath } from '@/config/runtime'
import { canUseEmbeddedBrowser, clearEmbeddedBrowserData } from '@/lib/embedded-browser'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'
import { navigateTo } from '@/lib/navigation'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
  type AppPreferencesPatch,
  type BrowserLinkTarget,
} from '@/desktop/appPreferences'
import { BrowserHistoryPage } from './BrowserHistoryPage'
import { ClearBrowserDataDialog } from './ClearBrowserDataDialog'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

export const BROWSER_HISTORY_SETTINGS_PATH = '/settings/browser/history'

function isBrowserHistoryPath() {
  return stripAppBasePath(window.location.pathname) === BROWSER_HISTORY_SETTINGS_PATH
}

function LinkTargetSelect({
  testId,
  value,
  disabled,
  onChange,
}: {
  testId: string
  value: BrowserLinkTarget
  disabled: boolean
  onChange: (value: BrowserLinkTarget) => void
}) {
  const { t } = useTranslation('common')

  return (
    <select
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value as BrowserLinkTarget)}
      className="h-8 min-w-[156px] rounded-md border border-border bg-background px-2.5 text-sm text-text-primary outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
    >
      <option value="system">{t('workbench.browser_settings_target_system')}</option>
      <option value="wework">{t('workbench.browser_settings_target_wework')}</option>
    </select>
  )
}

export function BrowserSettingsPage() {
  const { t } = useTranslation('common')
  const browserAvailable = canUseEmbeddedBrowser()
  const [historyView, setHistoryView] = useState(() => isBrowserHistoryPath())
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAppPreferences()
      .then(nextPreferences => {
        if (!cancelled) setPreferences(nextPreferences)
      })
      .catch(loadError => {
        console.error('[Wework] Failed to load browser preferences', loadError)
        if (!cancelled) setError(t('workbench.browser_settings_load_failed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t])

  const savePreferences = async (patch: AppPreferencesPatch) => {
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      setPreferences(await updateAppPreferences(patch))
    } catch (saveError) {
      console.error('[Wework] Failed to update browser preferences', saveError)
      setError(t('workbench.browser_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const chooseDownloadDirectory = async () => {
    try {
      const selected = await openNativeDirectoryPicker(
        preferences.browserDownloadDirectory ?? undefined
      )
      if (selected) await savePreferences({ browserDownloadDirectory: selected })
    } catch (pickerError) {
      console.error('[Wework] Failed to select browser download directory', pickerError)
      setError(t('workbench.browser_settings_download_picker_failed'))
    }
  }

  const clearBrowserData = async () => {
    setClearing(true)
    setError(null)
    setStatus(null)
    try {
      await clearEmbeddedBrowserData()
      setClearDialogOpen(false)
      setStatus(t('workbench.browser_settings_clear_success'))
    } catch (clearError) {
      console.error('[Wework] Failed to clear embedded browser data', clearError)
      setError(t('workbench.browser_settings_clear_failed'))
    } finally {
      setClearing(false)
    }
  }

  const controlsDisabled = loading || saving || !browserAvailable

  useEffect(() => {
    const syncHistoryView = () => setHistoryView(isBrowserHistoryPath())
    window.addEventListener('popstate', syncHistoryView)
    return () => window.removeEventListener('popstate', syncHistoryView)
  }, [])

  if (historyView) {
    return <BrowserHistoryPage />
  }
  const downloadLocation =
    preferences.browserDownloadDirectory ?? t('workbench.browser_settings_downloads_system')

  return (
    <SettingsPage data-testid="browser-settings-page">
      <SettingsPageHeader
        title={t('workbench.browser_settings_title')}
        description={t('workbench.browser_settings_subtitle')}
      />

      <section>
        <h2 className="mb-2 text-sm font-semibold text-text-primary">
          {t('workbench.browser_settings_general')}
        </h2>
        <SettingsGroup>
          <SettingsRow
            label={t('workbench.browser_settings_external_links')}
            description={t('workbench.browser_settings_external_links_description')}
            control={
              <LinkTargetSelect
                testId="browser-external-link-target"
                value={preferences.browserExternalLinkTarget}
                disabled={controlsDisabled}
                onChange={value => void savePreferences({ browserExternalLinkTarget: value })}
              />
            }
          />
          <SettingsRow
            label={t('workbench.browser_settings_local_links')}
            description={t('workbench.browser_settings_local_links_description')}
            control={
              <LinkTargetSelect
                testId="browser-local-link-target"
                value={preferences.browserLocalLinkTarget}
                disabled={controlsDisabled}
                onChange={value => void savePreferences({ browserLocalLinkTarget: value })}
              />
            }
          />
          <SettingsRow
            label={t('workbench.browser_settings_history')}
            description={t('workbench.browser_settings_history_description')}
            control={
              <button
                type="button"
                data-testid="browser-history-manage-button"
                disabled={controlsDisabled}
                onClick={() => navigateTo(BROWSER_HISTORY_SETTINGS_PATH)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <History className="h-4 w-4" />
                {t('workbench.browser_settings_history_manage')}
              </button>
            }
          />
          <SettingsRow
            label={t('workbench.browser_settings_clear_data')}
            description={t('workbench.browser_settings_clear_data_description')}
            control={
              <button
                type="button"
                data-testid="browser-clear-data-button"
                disabled={controlsDisabled || clearing}
                onClick={() => setClearDialogOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                {t('workbench.browser_settings_clear_action')}
              </button>
            }
          />
        </SettingsGroup>
      </section>

      <section className="mt-7">
        <h2 className="mb-2 text-sm font-semibold text-text-primary">
          {t('workbench.browser_settings_downloads')}
        </h2>
        <SettingsGroup>
          <SettingsRow
            label={t('workbench.browser_settings_download_location')}
            description={
              <span className="block max-w-[480px] truncate" title={downloadLocation}>
                {downloadLocation}
              </span>
            }
            control={
              <div className="flex items-center gap-1.5">
                {preferences.browserDownloadDirectory ? (
                  <button
                    type="button"
                    data-testid="browser-download-location-reset"
                    disabled={controlsDisabled}
                    onClick={() => void savePreferences({ browserDownloadDirectory: null })}
                    className="h-8 rounded-md px-2.5 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                  >
                    {t('workbench.browser_settings_download_reset')}
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid="browser-download-location-change"
                  disabled={controlsDisabled}
                  onClick={() => void chooseDownloadDirectory()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderOpen className="h-4 w-4" />
                  {t('workbench.browser_settings_download_change')}
                </button>
              </div>
            }
          />
          <SettingsRow
            label={t('workbench.browser_settings_ask_download')}
            description={t('workbench.browser_settings_ask_download_description')}
            control={
              <SettingsSwitch
                data-testid="browser-ask-before-download-toggle"
                checked={preferences.browserAskBeforeDownload}
                disabled={controlsDisabled}
                onCheckedChange={checked =>
                  void savePreferences({ browserAskBeforeDownload: checked })
                }
                aria-label={t('workbench.browser_settings_ask_download')}
              />
            }
          />
        </SettingsGroup>
      </section>

      {(loading || saving || status || error) && (
        <div
          data-testid="browser-settings-status"
          className={`mt-4 flex items-center gap-2 text-xs ${
            error ? 'text-red-500' : 'text-text-secondary'
          }`}
        >
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            {error ??
              status ??
              (loading ? t('common.loading', '加载中...') : t('workbench.browser_settings_saving'))}
          </span>
        </div>
      )}

      {clearDialogOpen ? (
        <ClearBrowserDataDialog
          loading={clearing}
          onCancel={() => setClearDialogOpen(false)}
          onConfirm={() => void clearBrowserData()}
        />
      ) : null}
    </SettingsPage>
  )
}
