import { isTauriRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import { DesktopWindowControls } from './DesktopWindowControls'

interface DesktopCollapsedSidebarToggleProps {
  collapsed: boolean
  onToggle: () => void
  testId?: string
}

export function DesktopCollapsedSidebarToggle({
  collapsed,
  onToggle,
  testId = 'auxiliary-expand-sidebar',
}: DesktopCollapsedSidebarToggleProps) {
  if (!collapsed || !isTauriRuntime() || getPlatform() === 'win') return null

  return (
    <div data-testid={testId} className="absolute left-2 top-0 z-chrome flex h-[38px] items-center">
      <DesktopWindowControls
        sidebarCollapsed
        onToggleSidebar={onToggle}
        className="gap-1"
        toggleTestId={`${testId}-button`}
      />
    </div>
  )
}
