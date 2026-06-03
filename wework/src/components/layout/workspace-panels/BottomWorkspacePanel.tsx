import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectWithTasks } from '@/types/api'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface BottomWorkspacePanelProps {
  currentProject: ProjectWithTasks | null
  onRequestClose: () => void
}

export function BottomWorkspacePanel({ currentProject, onRequestClose }: BottomWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const { height, handleResizeStart } = useResizableBottomPanel()

  return (
    <section
      data-testid="bottom-workspace-panel"
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
      style={{ height }}
    >
      <div
        data-testid="bottom-workspace-resize-handle"
        className="absolute left-0 top-[-4px] z-20 h-3 w-full cursor-row-resize bg-transparent"
        onPointerDown={handleResizeStart}
        aria-label={t('workbench.resize_bottom_workspace_panel', '调整底部栏高度')}
      />
      <button
        type="button"
        data-testid="close-bottom-workspace-panel-button"
        onClick={onRequestClose}
        className="absolute right-2 top-1 z-30 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
        aria-label={t('workbench.close_bottom_workspace_panel', '关闭底部栏')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex min-h-0 flex-1">
        <WorkspacePanelCards currentProject={currentProject} onRequestClose={onRequestClose} />
      </div>
    </section>
  )
}
