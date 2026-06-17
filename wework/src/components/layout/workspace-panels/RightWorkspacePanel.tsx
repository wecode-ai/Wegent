import { File, Plus, X } from 'lucide-react'
import type { PointerEvent } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { CodeCommentContext, WorkspaceTarget } from '@/types/workspace-files'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

interface RightWorkspacePanelProps {
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError?: string | null
  onAddCodeComment: (context: CodeCommentContext) => void
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  onRequestClose: () => void
}

export function RightWorkspacePanel({
  currentProject,
  devices,
  workspaceTarget,
  workspaceTargetError,
  onAddCodeComment,
  onResizeStart,
  onRequestClose,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="right-workspace-panel"
      className="relative flex h-full w-full min-w-0 flex-1 basis-0 flex-col bg-background opacity-100 transition-[opacity,transform] duration-300 ease-out"
    >
      <div
        data-testid="right-workspace-resize-handle"
        className="absolute left-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
        onPointerDown={onResizeStart}
        aria-label={t('workbench.resize_right_workspace_panel')}
      />
      <header
        data-testid="right-workspace-tabbar"
        role="tablist"
        className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-background px-4"
      >
        <div
          data-testid="right-workspace-file-tab"
          role="tab"
          aria-selected="true"
          className="group flex h-10 min-w-0 max-w-[240px] items-center gap-2 rounded-xl bg-muted py-1 pl-2 pr-4 text-left text-sm font-medium text-text-primary"
        >
          <span className="relative h-6 w-6 shrink-0">
            <File
              data-testid="right-workspace-file-tab-icon"
              className="absolute inset-0 m-auto h-4 w-4 text-text-secondary opacity-100 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            />
            <button
              type="button"
              data-testid="close-right-workspace-panel-button"
              onClick={onRequestClose}
              className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-text-muted text-background opacity-0 transition-colors hover:bg-text-secondary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pointer-events-auto group-hover:opacity-100"
              aria-label={t('workbench.close_right_workspace_panel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
          <span className="truncate">{t('workbench.workspace_tab_open_file', '打开文件')}</span>
        </div>
        <button
          type="button"
          data-testid="right-workspace-new-tab-button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
          aria-label={t('workbench.workspace_tab_new', '打开新标签页')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        {workspaceTarget ? (
          <FileWorkspacePanel
            key={`${workspaceTarget.deviceId}:${workspaceTarget.path}:${workspaceTarget.taskId ?? ''}`}
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
