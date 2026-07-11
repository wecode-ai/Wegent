import { AlertCircle, Loader2, Package } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createLocalCodexPluginApi, type LocalCodexLocalConfig } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsPage, SettingsPageHeader, SettingsSwitch } from './settings-ui'

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function PluginSettingsPage() {
  const { t } = useTranslation('common')
  const [codexConfig, setCodexConfig] = useState<LocalCodexLocalConfig | null>(null)
  const [codexConfigLoading, setCodexConfigLoading] = useState(true)
  const [codexConfigSaving, setCodexConfigSaving] = useState(false)
  const [codexConfigError, setCodexConfigError] = useState<string | null>(null)
  const localCodexApi = useMemo(() => createLocalCodexPluginApi(), [])

  const loadCodexConfig = useCallback(async () => {
    setCodexConfigLoading(true)
    setCodexConfigError(null)
    try {
      setCodexConfig(await localCodexApi.readCodexLocalConfig())
    } catch (readError) {
      setCodexConfigError(
        getErrorMessage(readError, t('workbench.codex_plugin_config_load_failed'))
      )
    } finally {
      setCodexConfigLoading(false)
    }
  }, [localCodexApi, t])

  useEffect(() => {
    void Promise.resolve().then(() => loadCodexConfig())
  }, [loadCodexConfig])

  const updateRemoteAppsEnabled = async (enabled: boolean) => {
    if (codexConfigSaving) return

    setCodexConfigSaving(true)
    setCodexConfigError(null)
    try {
      setCodexConfig(await localCodexApi.updateCodexLocalConfig({ remoteAppsEnabled: enabled }))
    } catch (saveError) {
      setCodexConfigError(
        getErrorMessage(saveError, t('workbench.codex_plugin_config_save_failed'))
      )
    } finally {
      setCodexConfigSaving(false)
    }
  }

  return (
    <SettingsPage data-testid="plugin-settings-page">
      <SettingsPageHeader
        title={t('workbench.plugin_settings_title', '插件')}
        description={t('workbench.plugin_settings_subtitle', '管理 Codex 插件运行配置')}
      />

      <section className="rounded-lg border border-border bg-background p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.codex_plugin_config_title')}
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {t('workbench.codex_plugin_config_description')}
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-border bg-background p-3">
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-primary">
                {t('workbench.codex_plugin_remote_apps_title')}
              </span>
              <span className="mt-1 block text-xs leading-5 text-text-secondary">
                {t('workbench.codex_plugin_remote_apps_description')}
              </span>
              {codexConfig?.configPath && (
                <span className="mt-2 block truncate text-xs text-text-muted">
                  {codexConfig.configPath}
                </span>
              )}
            </span>
            <SettingsSwitch
              data-testid="codex-plugin-remote-apps-toggle"
              checked={codexConfig?.remoteAppsEnabled ?? false}
              onCheckedChange={checked => void updateRemoteAppsEnabled(checked)}
              disabled={codexConfigLoading || codexConfigSaving}
              aria-label={t('workbench.codex_plugin_remote_apps_title')}
            />
          </label>
          {(codexConfigLoading || codexConfigSaving) && (
            <div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {codexConfigSaving ? t('workbench.codex_plugin_config_saving') : t('common.loading')}
            </div>
          )}
          {codexConfigError && (
            <div
              data-testid="codex-plugin-config-error"
              className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{codexConfigError}</span>
            </div>
          )}
        </div>
      </section>
    </SettingsPage>
  )
}
