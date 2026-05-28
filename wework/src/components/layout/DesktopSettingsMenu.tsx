import { ChevronRight, Clock, LogOut, Settings, User, UserCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { User as UserProfile } from '@/types/api'

interface DesktopSettingsMenuProps {
  user: UserProfile | null
  onOpenSettings: () => void
  onLogout: () => void
}

export function DesktopSettingsMenu({ user, onOpenSettings, onLogout }: DesktopSettingsMenuProps) {
  const { t } = useTranslation('common')
  const accountLabel =
    user?.email || user?.user_name || t('workbench.account_fallback', '当前账号')

  return (
    <div
      data-testid="settings-menu"
      className="absolute bottom-[68px] left-4 right-4 z-30 overflow-hidden rounded-xl border border-border bg-base py-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
    >
      <div className="flex min-h-11 items-center gap-3 px-4 text-sm text-text-secondary">
        <UserCircle className="h-5 w-5 shrink-0" />
        <span className="truncate">{accountLabel}</span>
      </div>
      <div className="mx-4 border-t border-border" />
      <button
        type="button"
        data-testid="account-menu-button"
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-sm font-medium text-[#333] hover:bg-muted"
      >
        <User className="h-5 w-5 shrink-0 text-[#555]" />
        <span>{t('workbench.personal_account', '个人账户')}</span>
      </button>
      <button
        type="button"
        data-testid="settings-menu-button"
        onClick={onOpenSettings}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-sm font-medium text-[#333] hover:bg-muted"
      >
        <Settings className="h-5 w-5 shrink-0 text-[#555]" />
        <span>{t('workbench.settings', '设置')}</span>
      </button>
      <div className="mx-4 border-t border-border" />
      <button
        type="button"
        data-testid="usage-menu-button"
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-sm font-medium text-[#333] hover:bg-muted"
      >
        <Clock className="h-5 w-5 shrink-0 text-[#555]" />
        <span className="flex-1">{t('workbench.remaining_usage', '剩余用量')}</span>
        <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
      </button>
      <button
        type="button"
        data-testid="logout-menu-button"
        onClick={onLogout}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-sm font-medium text-[#333] hover:bg-muted"
      >
        <LogOut className="h-5 w-5 shrink-0 text-[#555]" />
        <span>{t('workbench.logout', '退出登录')}</span>
      </button>
    </div>
  )
}
