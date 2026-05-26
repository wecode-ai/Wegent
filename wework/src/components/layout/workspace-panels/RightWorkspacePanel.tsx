import { Maximize2, Minus, PanelRight, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useResizableRightPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface RightWorkspacePanelProps {
  onClose: () => void
}

export function RightWorkspacePanel({ onClose }: RightWorkspacePanelProps) {
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
      <div className="flex h-14 items-center justify-between px-5">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
          aria-label={t('workbench.add_workspace_item', '添加工作项')}
        >
          <Plus className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.expand_workspace_panel', '放大工作栏')}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.close_right_workspace_panel', '关闭右侧栏')}
          >
            <Minus className="h-5 w-5" />
          </button>
          <PanelRight className="h-5 w-5 text-text-primary" />
        </div>
      </div>
      <div className="flex flex-1 items-center px-8">
        <WorkspacePanelCards />
      </div>
    </section>
  )
}
