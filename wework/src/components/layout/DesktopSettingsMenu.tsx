import { ChevronDown, Clock, Download, Loader2, LogOut, Settings } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  emptyCodexUsageDisplay,
  getLocalCodexUsageDisplay,
  type CodexUsageDisplay,
} from '@/api/local/codexUsage'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import type { User as UserProfile } from '@/types/api'

function formatVersionTemplate(template: string, version: string): string {
  return template.replace('{{version}}', version)
}

interface DesktopSettingsMenuProps {
  user: UserProfile | null
  onOpenSettings: () => void
  onLogout: () => void
}

export function DesktopSettingsMenu({ onOpenSettings, onLogout }: DesktopSettingsMenuProps) {
  const { t } = useTranslation('common')
  const [isUsageExpanded, setIsUsageExpanded] = useState(false)
  const [codexUsage, setCodexUsage] = useState<CodexUsageDisplay>(() => emptyCodexUsageDisplay())
  const [isQuotaLoading, setIsQuotaLoading] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const appUpdate = useOptionalAppUpdate()
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const updateStatus = appUpdate?.status ?? 'idle'
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
          {!quotaError ? (
            <div className="space-y-1.5 text-xs leading-5 text-text-secondary">
              <div className="flex items-center justify-between gap-3 whitespace-nowrap">
                <span>{codexUsage.fiveHour.title}</span>
                <span className="font-semibold text-text-primary">{codexUsage.fiveHour.value}</span>
              </div>
              <div className="flex items-center justify-between gap-3 whitespace-nowrap">
                <span>{codexUsage.sevenDay.title}</span>
                <span className="font-semibold text-text-primary">{codexUsage.sevenDay.value}</span>
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
