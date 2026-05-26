import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface BottomWorkspacePanelProps {
  onClose: () => void
}

export function BottomWorkspacePanel({ onClose }: BottomWorkspacePanelProps) {
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
      <div className="flex h-14 items-center justify-between px-6">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
          aria-label={t('workbench.add_workspace_item', '添加工作项')}
        >
          <Plus className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
          aria-label={t('workbench.close_bottom_workspace_panel', '关闭底部栏')}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex flex-1 items-center px-8 pb-8">
        <WorkspacePanelCards />
      </div>
    </section>
  )
}
