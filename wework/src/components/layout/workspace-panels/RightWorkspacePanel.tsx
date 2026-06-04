import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import { useResizableRightPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface RightWorkspacePanelProps {
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  onRequestClose: () => void
}

export function RightWorkspacePanel({
  currentProject,
  devices,
  onRequestClose,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const { width, handleResizeStart } = useResizableRightPanel()

  return (
    <section
      data-testid="right-workspace-panel"
      className="relative flex shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      <div
        data-testid="right-workspace-resize-handle"
        className="absolute left-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
        onPointerDown={handleResizeStart}
        aria-label={t('workbench.resize_right_workspace_panel')}
      />
      <button
        type="button"
        data-testid="close-right-workspace-panel-button"
        onClick={onRequestClose}
        className="absolute left-2 top-2 z-30 flex h-9 w-9 items-center justify-center rounded-md bg-background text-text-secondary hover:bg-muted hover:text-text-primary"
        aria-label={t('workbench.close_right_workspace_panel')}
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex min-h-0 flex-1 pt-14">
        <WorkspacePanelCards
          currentProject={currentProject}
          devices={devices}
          onRequestClose={onRequestClose}
        />
      </div>
    </section>
  )
}
