import { ChevronDown, Clock, Download, Loader2, LogIn, LogOut, Settings } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  emptyCodexUsageDisplay,
  formatCodexUsageResetTime,
  getLocalCodexUsageDisplay,
  type CodexUsageDisplay,
  type CodexUsageWindowDisplay,
} from '@/api/local/codexUsage'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import type { User as UserProfile } from '@/types/api'

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

function UpdateDownloadProgressIcon({ progress }: { progress: number }) {
  return (
    <span
      data-testid="app-update-download-icon-progress"
      aria-label={`${progress}%`}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(rgb(var(--color-primary)) ${progress}%, rgb(var(--color-border)) 0)`,
      }}
    >
      <span className="h-2 w-2 rounded-full bg-popover" />
    </span>
  )
}

interface DesktopSettingsMenuProps {
  user: UserProfile | null
  onOpenSettings: () => void
  onLogout: () => void
  onLogin?: () => void
  showLogout?: boolean
}

export function DesktopSettingsMenu({
  onOpenSettings,
  onLogout,
  onLogin,
  showLogout,
}: DesktopSettingsMenuProps) {
  const { t } = useTranslation('common')
  const shouldShowLogout = showLogout ?? !isLocalFirstAppRuntime()
  const [isUsageExpanded, setIsUsageExpanded] = useState(false)
  const [codexUsage, setCodexUsage] = useState<CodexUsageDisplay>(() => emptyCodexUsageDisplay())
  const [isQuotaLoading, setIsQuotaLoading] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const appUpdate = useOptionalAppUpdate()
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const updateStatus = appUpdate?.status ?? 'idle'
  const downloadProgress = appUpdate?.downloadProgress ?? null
  const updateError = appUpdate?.error ?? null
  const checkNow = appUpdate?.checkNow
  const installUpdate = appUpdate?.installUpdate

  const loadCodexUsage = () => {
    if (isQuotaLoading) {
      return
    }

    setIsQuotaLoading(true)
    setQuotaError(null)
    getLocalCodexUsageDisplay()
      .then(data => {
        setCodexUsage(data)
      })
      .catch(() => {
        setQuotaError(t('workbench.quota_load_failed', '额度信息获取失败'))
      })
      .finally(() => {
        setIsQuotaLoading(false)
      })
  }

  const handleUsageClick = () => {
    const shouldExpand = !isUsageExpanded
    setIsUsageExpanded(shouldExpand)

    if (shouldExpand) {
      loadCodexUsage()
    }
  }

  const handleUpdateClick = async () => {
    if (availableUpdate && installUpdate) {
      await installUpdate()
      return
    }

    await checkNow?.()
  }

  const updateButtonLabel = availableUpdate
    ? formatVersionTemplate(
        t('workbench.app_update_install', {
          defaultValue: '更新到 {{version}}',
          version: availableUpdate.version,
        }),
        availableUpdate.version
      )
    : t('workbench.app_update_check', { defaultValue: '检查更新' })
  const isUpdateBusy = updateStatus === 'checking' || updateStatus === 'installing'
  const downloadPercent = downloadProgress
    ? calculateDownloadPercent(downloadProgress.downloadedBytes, downloadProgress.totalBytes)
    : null
  const updateMessage =
    updateStatus === 'installing'
      ? null
      : availableUpdate
        ? formatVersionTemplate(
            t('workbench.app_update_available', {
              defaultValue: '发现新版本 {{version}}',
              version: availableUpdate.version,
            }),
            availableUpdate.version
          )
        : updateStatus === 'upToDate'
          ? t('workbench.app_update_up_to_date', {
              defaultValue: '已是最新版本',
            })
          : null
  const downloadMessage =
    updateStatus === 'installing'
      ? downloadPercent === null
        ? t('workbench.app_update_downloading', { defaultValue: '正在下载更新' })
        : t('workbench.app_update_downloading_progress', {
            defaultValue: '正在下载更新 {{progress}}%',
            progress: downloadPercent,
          }).replace('{{progress}}', String(downloadPercent))
      : null

  return (
    <div
      data-testid="settings-menu"
      className="absolute bottom-[72px] left-1.5 right-1.5 z-30 overflow-hidden rounded-[20px] border border-border/70 bg-popover/95 py-2.5 text-text-primary shadow-[0_24px_60px_rgba(0,0,0,0.36)] ring-1 ring-border/40 backdrop-blur-xl"
    >
      {onLogin ? (
        <>
          <SettingsMenuItem
            testId="login-menu-button"
            icon={<LogIn className="h-4 w-4 shrink-0 text-primary" />}
            label={t('workbench.account_cloud_login', '登录 Wegent')}
            description={t('workbench.account_cloud_login_description', '连接云端模型、设备和同步')}
            onClick={onLogin}
          />
          <div className="mx-4 my-1.5 border-t border-border/70" />
        </>
      ) : null}
      <SettingsMenuItem
        testId="settings-menu-button"
        icon={<Settings className="h-4 w-4 shrink-0 text-text-secondary" />}
        label={t('workbench.settings', '设置')}
        shortcut="Command+,"
        onClick={onOpenSettings}
      />
      <SettingsMenuItem
        testId="check-app-update-button"
        icon={
          updateStatus === 'installing' && downloadPercent !== null ? (
            <UpdateDownloadProgressIcon progress={downloadPercent} />
          ) : isUpdateBusy ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-secondary" />
          ) : (
            <Download className="h-4 w-4 shrink-0 text-text-secondary" />
          )
        }
        label={updateButtonLabel}
        onClick={handleUpdateClick}
        disabled={isUpdateBusy}
        active={Boolean(updateError)}
      />
      {downloadMessage ? (
        <div
          data-testid="app-update-download-progress"
          className="space-y-1.5 px-4 pb-2 pl-[44px] pr-5 text-xs font-medium leading-[18px] text-text-secondary"
        >
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={
                downloadPercent === null
                  ? 'h-full w-1/3 animate-pulse rounded-full bg-primary'
                  : 'h-full rounded-full bg-primary transition-[width] duration-200'
              }
              style={downloadPercent === null ? undefined : { width: `${downloadPercent}%` }}
            />
          </div>
          <span>{downloadMessage}</span>
        </div>
      ) : null}
      {updateMessage || updateError ? (
        <div
          data-testid="app-update-status"
          className="px-4 pb-2 pl-[44px] pr-5 text-xs font-medium leading-[18px] text-text-secondary"
        >
          <span className={updateError ? 'text-red-400' : undefined}>
            {updateError ?? updateMessage}
          </span>
        </div>
      ) : null}
      <div className="mx-4 my-1.5 border-t border-border/70" />
      <SettingsMenuItem
        testId="usage-menu-button"
        icon={<Clock className="h-4 w-4 shrink-0 text-text-secondary" />}
        label={t('workbench.remaining_usage', '剩余用量')}
        onClick={handleUsageClick}
        ariaExpanded={isUsageExpanded}
        ariaControls="remaining-usage-panel"
        trailing={
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-text-secondary transition-transform ${
              isUsageExpanded ? 'rotate-180' : ''
            }`}
          />
        }
      />
      {isUsageExpanded ? (
        <div
          id="remaining-usage-panel"
          data-testid="usage-detail-panel"
          className="px-4 pb-3 pl-[44px] pt-1"
        >
          {isQuotaLoading ? (
            <div className="py-1 text-sm leading-[18px] text-text-secondary">
              {t('common.loading', '加载中...')}
            </div>
          ) : null}
          {quotaError ? (
            <div className="py-1 text-sm leading-[18px] text-text-secondary">{quotaError}</div>
          ) : null}
          {!quotaError ? (
            <div className="space-y-2 text-xs leading-5 text-text-secondary">
              <UsageWindowRow window={codexUsage.fiveHour} />
              <UsageWindowRow window={codexUsage.sevenDay} />
            </div>
          ) : null}
        </div>
      ) : null}
      {shouldShowLogout ? (
        <SettingsMenuItem
          testId="logout-menu-button"
          icon={<LogOut className="h-4 w-4 shrink-0 text-text-secondary" />}
          label={t('workbench.logout', '退出登录')}
          onClick={onLogout}
        />
      ) : null}
    </div>
  )
}

function UsageWindowRow({ window }: { window: CodexUsageWindowDisplay }) {
  const resetTime = formatCodexUsageResetTime(window.resetsAt)
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="whitespace-nowrap">{window.title}</div>
        {resetTime ? (
          <div className="mt-0.5 whitespace-nowrap text-xs leading-4 text-text-muted">
            {resetTime} 重置
          </div>
        ) : null}
      </div>
      <span className="shrink-0 whitespace-nowrap font-semibold text-text-primary">
        {window.value}
      </span>
    </div>
  )
}

interface SettingsMenuItemProps {
  testId: string
  icon: ReactNode
  label: string
  description?: string
  shortcut?: string
  trailing?: ReactNode
  active?: boolean
  disabled?: boolean
  ariaExpanded?: boolean
  ariaControls?: string
  onClick?: () => void | Promise<void>
}

function SettingsMenuItem({
  testId,
  icon,
  label,
  description,
  shortcut,
  trailing,
  active = false,
  disabled = false,
  ariaExpanded,
  ariaControls,
  onClick,
}: SettingsMenuItemProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      className={`flex w-full items-center gap-3 px-4 text-left text-sm font-semibold leading-[18px] text-text-primary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 ${
        description ? 'min-h-12 py-2' : 'h-9'
      } ${active ? 'bg-hover' : ''}`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description ? (
          <span className="block truncate text-xs font-medium leading-4 text-text-secondary">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <KeyboardShortcut
          value={shortcut}
          className="h-6 bg-muted px-2 text-sm text-text-secondary"
        />
      ) : null}
      {trailing}
    </button>
  )
}
