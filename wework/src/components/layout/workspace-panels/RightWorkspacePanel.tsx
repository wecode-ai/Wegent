import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { CodeCommentContext, WorkspaceTarget } from '@/types/workspace-files'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { useResizableRightPanel } from './useResizableWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface RightWorkspacePanelProps {
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError?: string | null
  onAddCodeComment: (context: CodeCommentContext) => void
  onRequestClose: () => void
}

export function RightWorkspacePanel({
  currentProject,
  devices,
  workspaceTarget,
  workspaceTargetError,
  onAddCodeComment,
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
        {workspaceTarget ? (
          <FileWorkspacePanel
            key={`${workspaceTarget.deviceId}:${workspaceTarget.path}`}
            target={workspaceTarget}
            onAddCodeComment={onAddCodeComment}
          />
        ) : workspaceTargetError ? (
          <section
            data-testid="workspace-target-error"
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-red-500"
          >
            {workspaceTargetError}
          </section>
        ) : (
          <WorkspacePanelCards
            currentProject={currentProject}
            devices={devices}
            onRequestClose={onRequestClose}
          />
        )}
      </div>
    </section>
  )
}
