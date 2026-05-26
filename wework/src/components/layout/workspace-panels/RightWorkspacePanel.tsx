import { useTranslation } from 'react-i18next'
import { useResizableRightPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

export function RightWorkspacePanel() {
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
      <div className="flex flex-1 items-center px-8">
        <WorkspacePanelCards />
      </div>
    </section>
  )
}
