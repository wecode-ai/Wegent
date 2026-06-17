import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface BottomWorkspacePanelProps {
  open: boolean
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  onRequestClose: () => void
}

export function BottomWorkspacePanel({
  open,
  currentProject,
  devices,
  onRequestClose,
}: BottomWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const { height, handleResizeStart } = useResizableBottomPanel()

  return (
    <section
      data-testid="bottom-workspace-panel"
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden bg-background transition-[height,opacity,transform] duration-300 ease-out',
        open
          ? 'pointer-events-auto translate-y-0 border-t border-border opacity-100'
          : 'pointer-events-none translate-y-3 border-t border-transparent opacity-0'
      )}
      style={{ height: open ? height : 0 }}
      aria-hidden={!open}
    >
      {open && (
        <>
          <div
            data-testid="bottom-workspace-resize-handle"
            className="absolute left-0 top-[-4px] z-20 h-3 w-full cursor-row-resize bg-transparent"
            onPointerDown={handleResizeStart}
            aria-label={t('workbench.resize_bottom_workspace_panel')}
          />
          <button
            type="button"
            data-testid="close-bottom-workspace-panel-button"
            onClick={onRequestClose}
            className="absolute right-2 top-1 z-30 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.close_bottom_workspace_panel')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex min-h-0 flex-1">
            <WorkspacePanelCards
              currentProject={currentProject}
              devices={devices}
              onRequestClose={onRequestClose}
            />
          </div>
        </>
      )}
    </section>
  )
}
