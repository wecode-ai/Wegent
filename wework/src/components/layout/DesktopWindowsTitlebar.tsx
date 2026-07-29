import { DesktopAppSwitcher, type DesktopAppKey } from '@/components/layout/DesktopAppSwitcher'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { WindowFrameControls } from '@/components/layout/WindowFrameControls'
import { useWindowFocus } from '@/hooks/useWindowFocus'
import { cn } from '@/lib/utils'
import { getPlatform } from '@/lib/platform'
import { isTauriRuntime } from '@/lib/runtime-environment'

interface DesktopWindowsTitlebarProps {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  activeApp: DesktopAppKey
  onNavigate: (app: DesktopAppKey) => void
  className?: string
}

export function DesktopWindowsTitlebar({
  sidebarCollapsed,
  onToggleSidebar,
  activeApp,
  onNavigate,
  className,
}: DesktopWindowsTitlebarProps) {
  const windowFocused = useWindowFocus()
  const platform = getPlatform()
  const isTauri = isTauriRuntime()

  if (!isTauri || platform !== 'win') return null

  return (
    <div
      data-testid="desktop-windows-titlebar"
      data-window-focused={windowFocused}
      data-tauri-drag-region
      className={cn(
        'relative z-chrome h-[38px] w-full shrink-0 bg-[rgb(var(--color-sidebar))] backdrop-blur-xl backdrop-saturate-150',
        !windowFocused && 'bg-[rgb(var(--color-sidebar-unfocused))]',
        className
      )}
    >
      <div
        className="pointer-events-auto absolute left-0 top-0 z-chrome flex h-full items-center gap-1 px-1"
        data-tauri-drag-region={false}
      >
        <DesktopWindowControls
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          className="gap-1"
        />
        <DesktopAppSwitcher activeApp={activeApp} onNavigate={onNavigate} />
      </div>
      <div
        className="pointer-events-auto absolute right-0 top-0 z-chrome h-full w-[138px]"
        data-tauri-drag-region={false}
      >
        <WindowFrameControls className="h-full justify-end" />
      </div>
    </div>
  )
}
