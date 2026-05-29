import { useTranslation } from 'react-i18next'
import type { ProjectWithTasks } from '@/types/api'
import { useResizableRightPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface RightWorkspacePanelProps {
  currentProject: ProjectWithTasks | null
}

export function RightWorkspacePanel({ currentProject }: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const { width, handleResizeStart } = useResizableRightPanel()

  return (
    <section
      data-testid="right-workspace-panel"
      className="relative flex shrink-0 flex-col border-l border-border bg-base"
      style={{ width }}
    >
      <div
        data-testid="right-workspace-resize-handle"
        className="absolute left-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
        onPointerDown={handleResizeStart}
        aria-label={t('workbench.resize_right_workspace_panel', '调整右侧栏宽度')}
      />
      <div className="flex min-h-0 flex-1 px-8 py-6">
        <WorkspacePanelCards currentProject={currentProject} />
      </div>
    </section>
  )
}
