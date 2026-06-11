import {
  ChevronDown,
  Clock,
  ExternalLink,
  LogOut,
  Settings,
  User,
  UserCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createQuotaApi } from '@/api/quota'
import type { QuotaData } from '@/api/quota'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import type { User as UserProfile } from '@/types/api'

const QUOTA_BILLING_URL = 'https://space.intra.weibo.com/develop/model-quota'

function getQuotaUsagePercent(quota: QuotaData): number {
  const rawPercent = quota.usage_rate * 100
  if (!Number.isFinite(rawPercent)) return 0
  return Math.min(100, Math.max(0, rawPercent))
}

interface DesktopSettingsMenuProps {
  user: UserProfile | null
  onOpenSettings: () => void
  onLogout: () => void
}

export function DesktopSettingsMenu({
  user,
  onOpenSettings,
  onLogout,
}: DesktopSettingsMenuProps) {
  const { t } = useTranslation('common')
  const quotaApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createQuotaApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const [isUsageExpanded, setIsUsageExpanded] = useState(false)
  const [quota, setQuota] = useState<QuotaData | null>(null)
  const [isQuotaLoading, setIsQuotaLoading] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const accountLabel =
    user?.email ||
    user?.user_name ||
    t('workbench.account_fallback', '当前账号')
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
      .then((data) => {
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

  return (
    <div
      data-testid="settings-menu"
      className="absolute bottom-[68px] left-4 right-4 z-30 overflow-hidden rounded-xl border border-border bg-background py-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
    >
      <div className="flex min-h-10 items-center gap-3 px-4 text-[13px] leading-[18px] text-text-secondary">
        <UserCircle className="h-4 w-4 shrink-0" />
        <span className="truncate">{accountLabel}</span>
      </div>
      <div className="mx-4 border-t border-border" />
      <button
        type="button"
        data-testid="account-menu-button"
        className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
      >
        <User className="h-4 w-4 shrink-0 text-text-secondary" />
        <span>{t('workbench.personal_account', '个人账户')}</span>
      </button>
      <button
        type="button"
        data-testid="settings-menu-button"
        onClick={onOpenSettings}
        className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
      >
        <Settings className="h-4 w-4 shrink-0 text-text-secondary" />
        <span>{t('workbench.settings', '设置')}</span>
      </button>
      <div className="mx-4 border-t border-border" />
      <button
        type="button"
        data-testid="usage-menu-button"
        aria-expanded={isUsageExpanded}
        aria-controls="remaining-usage-panel"
        onClick={handleUsageClick}
        className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
      >
        <Clock className="h-4 w-4 shrink-0 text-text-secondary" />
        <span className="flex-1">
          {t('workbench.remaining_usage', '剩余用量')}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${
            isUsageExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {isUsageExpanded ? (
        <div
          id="remaining-usage-panel"
          data-testid="usage-detail-panel"
          className="px-4 pb-3 pt-1"
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
              <div className="whitespace-nowrap text-text-secondary">
                {quotaRemainingText}
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={quotaUsagePercentValue}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${quotaUsagePercent}%` }}
                />
              </div>
              <div>
                <a
                  href={QUOTA_BILLING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-6 items-center gap-1 whitespace-nowrap text-text-secondary hover:text-text-primary hover:underline"
                >
                  {t('workbench.quota_billing_link', '额度与计费说明')}
                  <ExternalLink className="h-3 w-3 text-text-muted" />
                </a>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        data-testid="logout-menu-button"
        onClick={onLogout}
        className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
      >
        <LogOut className="h-4 w-4 shrink-0 text-text-secondary" />
        <span>{t('workbench.logout', '退出登录')}</span>
      </button>
    </div>
  )
}
