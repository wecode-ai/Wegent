import { Bot, Download, ExternalLink, Loader2 } from 'lucide-react'
import type { ComponentType } from 'react'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'

const PROJECT_URL = 'https://github.com/wecode-ai/Wegent'
const LICENSE_URL = `${PROJECT_URL}/blob/main/LICENSE`
const DISCORD_URL = 'https://discord.gg/MVzJzyqEUp'

function formatVersionTemplate(template: string, version: string): string {
  return template.replace('{{version}}', version)
}

function calculateDownloadPercent(
  downloadedBytes: number,
  totalBytes: number | null
): number | null {
  if (!totalBytes || totalBytes <= 0) return null
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
}

function formatUpdateError(message: string | null, t: ReturnType<typeof useTranslation>['t']) {
  if (!message) return null
  if (message.toLowerCase().includes('updater does not have any endpoints set')) {
    return t('workbench.app_update_endpoint_missing', {
      defaultValue: '当前版本暂不支持自动更新检查',
    })
  }
  return message
}

function AboutLink({ label, url }: { label: string; url: string }) {
  return (
    <button
      type="button"
      data-testid={`about-link-${label.toLowerCase().replaceAll(' ', '-')}`}
      onClick={() => {
        void openExternalUrl(url)
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
    >
      <span>{label}</span>
      <ExternalLink className="h-3 w-3" />
    </button>
  )
}

function AboutActionButton({
  testId,
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  testId: string
  icon: ComponentType<{ className?: string }>
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-xs font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  )
}

export function AboutSettingsPage() {
  const { t } = useTranslation('common')
  const appUpdate = useOptionalAppUpdate()
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const updateStatus = appUpdate?.status ?? 'idle'
  const downloadProgress = appUpdate?.downloadProgress ?? null
  const updateError = appUpdate?.error ?? null
  const formattedUpdateError = formatUpdateError(updateError, t)
  const isUpdateBusy = updateStatus === 'checking' || updateStatus === 'installing'
  const downloadPercent = downloadProgress
    ? calculateDownloadPercent(downloadProgress.downloadedBytes, downloadProgress.totalBytes)
    : null
  const updateButtonLabel = availableUpdate
    ? formatVersionTemplate(
        t('workbench.app_update_install', {
          defaultValue: '更新到 {{version}}',
          version: availableUpdate.version,
        }),
        availableUpdate.version
      )
    : t('workbench.app_update_check', { defaultValue: '检查更新' })
  const updateMessage = availableUpdate
    ? formatVersionTemplate(
        t('workbench.app_update_available', {
          defaultValue: '发现新版本 {{version}}',
          version: availableUpdate.version,
        }),
        availableUpdate.version
      )
    : updateStatus === 'upToDate'
      ? t('workbench.app_update_up_to_date', { defaultValue: '已是最新版本' })
      : null

  const handleUpdateClick = async () => {
    if (!appUpdate) return
    if (availableUpdate) {
      await appUpdate.installUpdate()
      return
    }
    await appUpdate.checkNow()
  }

  return (
    <div
      data-testid="about-settings-page"
      className="mx-auto flex w-full max-w-[560px] flex-col items-center px-4 pb-10 pt-8 text-center md:pt-14"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-[18px] border border-border bg-surface shadow-sm">
        <Bot className="h-10 w-10 text-primary" />
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-normal text-text-primary">Wework</h1>
      <div className="mt-2 text-sm font-medium text-text-secondary">v{__WEWORK_APP_VERSION__}</div>
      <p className="mt-4 max-w-[420px] text-sm leading-6 text-text-secondary">
        {t('workbench.about_settings_description', '面向办公和编码场景的 AI 工作台。')}
      </p>

      <div className="mt-7 flex flex-col items-center gap-2">
        <AboutActionButton
          testId="about-check-update-button"
          icon={isUpdateBusy ? Loader2 : Download}
          label={updateButtonLabel}
          onClick={() => {
            void handleUpdateClick()
          }}
          disabled={!appUpdate || isUpdateBusy}
        />
        {updateMessage || formattedUpdateError ? (
          <span
            data-testid="about-update-status"
            className="max-w-[360px] text-xs leading-5 text-text-secondary"
          >
            {formattedUpdateError ?? updateMessage}
          </span>
        ) : null}
        {updateStatus === 'installing' ? (
          <div data-testid="about-update-download-progress" className="w-[240px] space-y-1.5">
            <div
              role="progressbar"
              aria-label={t('workbench.app_update_downloading', {
                defaultValue: '正在下载更新',
              })}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(downloadPercent !== null ? { 'aria-valuenow': downloadPercent } : {})}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={
                  downloadPercent === null
                    ? 'h-full w-1/3 animate-pulse rounded-full bg-primary'
                    : 'h-full rounded-full bg-primary transition-[width] duration-200'
                }
                style={downloadPercent === null ? undefined : { width: `${downloadPercent}%` }}
              />
            </div>
            <span className="block text-xs leading-5 text-text-secondary">
              {downloadPercent === null
                ? t('workbench.app_update_downloading', { defaultValue: '正在下载更新' })
                : t('workbench.app_update_downloading_progress', {
                    defaultValue: '正在下载更新 {{progress}}%',
                    progress: downloadPercent,
                  })}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-1 border-t border-border pt-4">
        <AboutLink label="GitHub" url={PROJECT_URL} />
        <span className="text-text-muted">·</span>
        <AboutLink label="Apache-2.0" url={LICENSE_URL} />
        <span className="text-text-muted">·</span>
        <AboutLink label="Discord" url={DISCORD_URL} />
      </div>
    </div>
  )
}
