import { Edit3, PanelLeft } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'

interface DesktopWindowControlsProps {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onNewChat?: () => void
  className?: string
}

export function DesktopWindowControls({
  sidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  className = '',
}: DesktopWindowControlsProps) {
  const { t } = useTranslation('common')
  const toggleLabel = sidebarCollapsed
    ? t('workbench.expand_sidebar', '展开侧边栏')
    : t('workbench.collapse_sidebar', '收起侧边栏')

  return (
    <div
      data-testid="desktop-window-controls"
      className={cn('flex items-center gap-3', className)}
    >
      <button
        type="button"
        data-testid={
          sidebarCollapsed
            ? 'expand-sidebar-button'
            : 'collapse-sidebar-button'
        }
        onClick={onToggleSidebar}
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={toggleLabel}
      >
        <PanelLeft />
      </button>
      {sidebarCollapsed && onNewChat && (
        <button
          type="button"
          data-testid="desktop-controls-new-chat-button"
          onClick={onNewChat}
          className={DESKTOP_TOP_BAR_BUTTON_CLASS}
          aria-label={t('workbench.new_chat', '新对话')}
        >
          <Edit3 />
        </button>
      )}
    </div>
  )
}
