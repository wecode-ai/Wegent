import { Check, Copy, ExternalLink, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  getGitHostingCliStatus,
  type GitHostingCliProvider,
  type GitHostingCliStatus,
} from '@/api/gitHostingCli'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { updateAppPreferences } from '@/tauri/appPreferences'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

const PROVIDERS: GitHostingCliProvider[] = ['github', 'gitlab']
const PROVIDER_CONFIG = {
  github: {
    tool: 'gh',
    installUrl: 'https://cli.github.com/',
    loginCommand: 'gh auth login',
  },
  gitlab: {
    tool: 'glab',
    installUrl: 'https://docs.gitlab.com/cli/',
    loginCommand: 'glab auth login',
  },
} as const

function statusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: GitHostingCliStatus | undefined,
  loading: boolean
) {
  if (loading) return t('workbench.git_hosting_cli_detecting', '检测中…')
  if (!status) return t('workbench.git_hosting_cli_detection_failed', '检测失败')
  if (status.detectionError) {
    return t('workbench.git_hosting_cli_detection_failed', '检测失败')
  }
  if (!status.installed) return t('workbench.git_hosting_cli_not_installed', '未安装')
  if (!status.authenticated) return t('workbench.git_hosting_cli_not_authenticated', '未登录')
  return t('workbench.git_hosting_cli_ready', '已就绪')
}

export function GitHostingSettingsPage() {
  const { t } = useTranslation('common')
  const preferencesState = useAppPreferencesState()
  const enabled = preferencesState?.preferences.changeRequestStatusEnabled ?? true
  const [statuses, setStatuses] = useState<
    Partial<Record<GitHostingCliProvider, GitHostingCliStatus>>
  >({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedProvider, setCopiedProvider] = useState<GitHostingCliProvider | null>(null)

  const detect = useCallback(async () => {
    setLoading(true)
    setError(null)
    const results = await Promise.allSettled(PROVIDERS.map(getGitHostingCliStatus))
    const nextStatuses: Partial<Record<GitHostingCliProvider, GitHostingCliStatus>> = {}
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        nextStatuses[PROVIDERS[index]] = result.value
      }
    })
    setStatuses(nextStatuses)
    if (results.some(result => result.status === 'rejected')) {
      setError(t('workbench.git_hosting_cli_detection_failed', 'CLI 状态检测失败'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    const timeout = window.setTimeout(() => void detect(), 0)
    return () => window.clearTimeout(timeout)
  }, [detect])

  const updateEnabled = async (nextEnabled: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await updateAppPreferences({ changeRequestStatusEnabled: nextEnabled })
    } catch (updateError) {
      console.error('Failed to save change request status preference:', updateError)
      setError(t('workbench.git_hosting_settings_save_failed', '代码托管设置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const copyLoginCommand = async (provider: GitHostingCliProvider) => {
    await copyTextToClipboard(PROVIDER_CONFIG[provider].loginCommand)
    setCopiedProvider(provider)
    window.setTimeout(
      () => setCopiedProvider(current => (current === provider ? null : current)),
      1500
    )
  }

  return (
    <SettingsPage data-testid="git-hosting-settings-page">
      <SettingsPageHeader
        title={t('workbench.git_hosting_settings_title', '代码托管')}
        description={t(
          'workbench.git_hosting_settings_description',
          '使用本机 GitHub CLI 或 GitLab CLI 查询当前分支的拉取请求或合并请求状态。Wework 不保存访问令牌。'
        )}
        actions={
          <button
            type="button"
            data-testid="git-hosting-cli-refresh"
            onClick={() => void detect()}
            disabled={loading}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('workbench.git_hosting_cli_refresh', '重新检测')}
          </button>
        }
      />

      <SettingsGroup>
        <SettingsRow
          data-testid="change-request-status-setting"
          label={t('workbench.git_hosting_status_switch', '显示 PR / MR 状态')}
          description={t(
            'workbench.git_hosting_status_switch_description',
            '开启后，Wework 会通过当前设备上的 gh 或 glab 查询当前分支状态。关闭后不会执行这些查询。'
          )}
          control={
            <SettingsSwitch
              data-testid="change-request-status-switch"
              checked={enabled}
              disabled={saving}
              onCheckedChange={nextEnabled => void updateEnabled(nextEnabled)}
            />
          }
        />
      </SettingsGroup>

      <div className="mt-6 space-y-3">
        {PROVIDERS.map(provider => {
          const config = PROVIDER_CONFIG[provider]
          const status = statuses[provider]
          const ready = !status?.detectionError && status?.installed && status.authenticated
          return (
            <section
              key={provider}
              data-testid={`git-hosting-cli-${provider}`}
              className="rounded-2xl border border-border bg-surface/70 px-4 py-4"
            >
              <div className="flex items-start gap-3">
                <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-medium text-text-primary">
                      {provider === 'github' ? 'GitHub CLI' : 'GitLab CLI'}
                    </h2>
                    <span
                      data-testid={`git-hosting-cli-${provider}-status`}
                      className={`text-xs ${ready ? 'text-green-500' : 'text-text-muted'}`}
                    >
                      {statusLabel(t, status, loading)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-4 text-text-secondary">
                    {status?.version ||
                      t('workbench.git_hosting_cli_tool_hint', {
                        tool: config.tool,
                        defaultValue: `命令：${config.tool}`,
                      })}
                  </p>
                  {status?.executablePath ? (
                    <p className="mt-1 truncate text-code text-text-muted">
                      {status.executablePath}
                    </p>
                  ) : null}
                </div>
              </div>

              {!loading && status && !status.detectionError && !ready ? (
                <div className="mt-4 flex flex-wrap gap-2 pl-8">
                  {!status.installed ? (
                    <button
                      type="button"
                      data-testid={`git-hosting-cli-${provider}-install`}
                      onClick={() => void openExternalUrl(config.installUrl)}
                      className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {t('workbench.git_hosting_cli_install', '安装指引')}
                    </button>
                  ) : null}
                  {status.installed && !status.authenticated ? (
                    <button
                      type="button"
                      data-testid={`git-hosting-cli-${provider}-copy-login`}
                      onClick={() => void copyLoginCommand(provider)}
                      className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover"
                    >
                      {copiedProvider === provider ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                      {copiedProvider === provider
                        ? t('workbench.git_hosting_cli_login_copied', '已复制')
                        : t('workbench.git_hosting_cli_copy_login', {
                            command: config.loginCommand,
                            defaultValue: `复制 ${config.loginCommand}`,
                          })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>

      {error ? (
        <p data-testid="git-hosting-settings-error" className="mt-4 text-xs text-red-500">
          {error}
        </p>
      ) : null}
    </SettingsPage>
  )
}
