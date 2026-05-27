import { useTranslation } from 'react-i18next'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

export function BottomWorkspacePanel() {
  const { t } = useTranslation('common')
  const { height, handleResizeStart } = useResizableBottomPanel()

  return (
    <section
      data-testid="bottom-workspace-panel"
      className="relative flex shrink-0 flex-col border-t border-border bg-base"
      style={{ height }}
    >
      <div
        data-testid="bottom-workspace-resize-handle"
        className="absolute left-0 top-[-4px] z-20 h-3 w-full cursor-row-resize bg-transparent"
        onPointerDown={handleResizeStart}
        aria-label={t('workbench.resize_bottom_workspace_panel', '调整底部栏高度')}
      />
      <div className="flex flex-1 items-center px-8">
        <WorkspacePanelCards />
      </div>
    </section>
  )
}
