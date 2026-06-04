import { Edit3, PanelLeft } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface DesktopWindowControlsProps {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onNewChat?: () => void
  className?: string
}

const controlButtonClassName =
  'flex h-8 w-8 items-center justify-center rounded-lg text-[#85858c] transition-colors hover:bg-[#f3f3f4] hover:text-[#101014]'

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
    <div className={`flex items-center gap-3 ${className}`}>
      <button
        type="button"
        data-testid={
          sidebarCollapsed
            ? 'expand-sidebar-button'
            : 'collapse-sidebar-button'
        }
        onClick={onToggleSidebar}
        className={controlButtonClassName}
        aria-label={toggleLabel}
      >
        <PanelLeft className="h-5 w-5" />
      </button>
      {sidebarCollapsed && onNewChat && (
        <button
          type="button"
          data-testid="desktop-controls-new-chat-button"
          onClick={onNewChat}
          className={controlButtonClassName}
          aria-label={t('workbench.new_chat', '新对话')}
        >
          <Edit3 className="h-5 w-5" />
        </button>
      )}
    </div>
  )
}
