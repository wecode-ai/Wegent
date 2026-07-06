import { ChevronDown, Clock, Download, Loader2, LogOut, Settings, User } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createHttpClient } from '@/api/http'
import { createQuotaApi } from '@/api/quota'
import type { QuotaData } from '@/api/quota'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { getRuntimeConfig } from '@/config/runtime'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import type { User as UserProfile } from '@/types/api'

function getQuotaUsagePercent(quota: QuotaData): number {
  const rawPercent = quota.usage_rate * 100
  if (!Number.isFinite(rawPercent)) return 0
  return Math.min(100, Math.max(0, rawPercent))
}

function formatVersionTemplate(template: string, version: string): string {
  return template.replace('{{version}}', version)
}

interface DesktopSettingsMenuProps {
  user: UserProfile | null
  onOpenSettings: () => void
  onLogout: () => void
}

function getAccountInitials(label: string): string {
  const normalizedLabel = label.trim()
  if (!normalizedLabel) return 'U'
  const [namePart] = normalizedLabel.split('@')
  const words = namePart.split(/[._\-\s]+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return namePart.slice(0, 2).toUpperCase()
}

export function DesktopSettingsMenu({ user, onOpenSettings, onLogout }: DesktopSettingsMenuProps) {
  const { t } = useTranslation('common')
  const quotaApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createQuotaApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const [isUsageExpanded, setIsUsageExpanded] = useState(false)
  const [quota, setQuota] = useState<QuotaData | null>(null)
  const [isQuotaLoading, setIsQuotaLoading] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const appUpdate = useOptionalAppUpdate()
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const updateStatus = appUpdate?.status ?? 'idle'
  const updateError = appUpdate?.error ?? null
  const checkNow = appUpdate?.checkNow
  const installUpdate = appUpdate?.installUpdate
  const accountLabel = user?.email || user?.user_name || t('workbench.account_fallback', '当前账号')
  const quotaUsageText = quota
    ? `${quota.usage.toFixed(2)} / ${quota.quota.toLocaleString()} ${t('workbench.quota_unit_yuan', '元')}`
    : ''
  const quotaRemainingText = quota
    ? `${t('workbench.quota_remaining_label', '剩余')} ${quota.remaining.toFixed(2)} ${t('workbench.quota_unit_yuan', '元')}`
    : ''
  const quotaUsagePercent = quota ? getQuotaUsagePercent(quota) : 0
  const quotaUsagePercentValue = Math.round(quotaUsagePercent)

  const handleUsageClick = () => {
    const shouldExpand = !isUsageExpanded
    setIsUsageExpanded(shouldExpand)

    if (!shouldExpand || quota || isQuotaLoading) {
      return
    }

    setIsQuotaLoading(true)
    setQuotaError(null)
    quotaApi
      .fetchQuota()
      .then(data => {
        if (data) {
          setQuota(data)
        } else {
          setQuotaError(t('workbench.quota_load_failed', '额度信息获取失败'))
        }
      })
      .catch(() => {
        setQuotaError(t('workbench.quota_load_failed', '额度信息获取失败'))
      })
      .finally(() => {
        setIsQuotaLoading(false)
      })
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
  const updateMessage = availableUpdate
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

  return (
    <div
      data-testid="settings-menu"
      className="absolute bottom-[72px] left-1.5 right-1.5 z-30 overflow-hidden rounded-[20px] border border-border/70 bg-popover/95 py-2.5 text-text-primary shadow-[0_24px_60px_rgba(0,0,0,0.36)] ring-1 ring-border/40 backdrop-blur-xl"
    >
      <div data-testid="settings-account-group" className="px-4 pb-1">
        <div className="flex h-9 items-center gap-3 text-[13px] font-medium leading-[18px] text-text-secondary">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 text-[10px] font-medium text-text-secondary">
            {getAccountInitials(accountLabel)}
          </div>
          <span className="min-w-0 flex-1 truncate">{accountLabel}</span>
        </div>
        <div
          data-testid="account-menu-button"
          className="flex h-9 cursor-default items-center gap-3 text-[13px] font-medium leading-[18px] text-text-secondary"
        >
          <User className="h-4 w-4 shrink-0 text-text-secondary" />
          <span>{t('workbench.personal_account', '个人账户')}</span>
        </div>
      </div>
      <div className="mx-4 my-1.5 border-t border-border/70" />
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
          isUpdateBusy ? (
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
            <div className="py-1 text-[13px] leading-[18px] text-text-secondary">
              {t('common.loading', '加载中...')}
            </div>
          ) : null}
          {quotaError ? (
            <div className="py-1 text-[13px] leading-[18px] text-text-secondary">{quotaError}</div>
          ) : null}
          {quota ? (
            <div className="space-y-1.5 text-xs leading-5 text-text-secondary">
              <div className="whitespace-nowrap font-semibold text-text-primary">
                {quotaUsageText}
              </div>
              <div className="whitespace-nowrap">{quotaRemainingText}</div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={quotaUsagePercentValue}
                className="h-1.5 overflow-hidden rounded-full bg-white/10"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${quotaUsagePercent}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <SettingsMenuItem
        testId="logout-menu-button"
        icon={<LogOut className="h-4 w-4 shrink-0 text-text-secondary" />}
        label={t('workbench.logout', '退出登录')}
        onClick={onLogout}
      />
    </div>
  )
}

interface SettingsMenuItemProps {
  testId: string
  icon: ReactNode
  label: string
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
      className={`flex h-9 w-full items-center gap-3 px-4 text-left text-[13px] font-semibold leading-[18px] text-text-primary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? 'bg-hover' : ''
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <KeyboardShortcut
          value={shortcut}
          className="h-6 bg-muted px-2 text-[13px] text-text-secondary"
        />
      ) : null}
      {trailing}
    </button>
  )
}
