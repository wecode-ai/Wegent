import { File, FileDiff, Plus, X } from 'lucide-react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { FileChangesReviewPanel } from '@/components/chat/FileChangesReviewPanel'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import { cn } from '@/lib/utils'
import { FileWorkspacePanel } from './FileWorkspacePanel'

export type RightWorkspacePanelView = 'launcher' | 'review' | 'files'
export type RightWorkspacePanelTab = Exclude<RightWorkspacePanelView, 'launcher'>

interface RightWorkspaceReviewState {
  loading: boolean
  diff: string
  error?: string
}

interface RightWorkspacePanelProps {
  activeView: RightWorkspacePanelView
  openTabs: RightWorkspacePanelTab[]
  workspaceTarget: WorkspaceTarget | null
  openFileRequest?: WorkspaceFileOpenRequest | null
  workspaceTargetError?: string | null
  review: RightWorkspaceReviewState
  canOpenReview: boolean
  onAddCodeComment: (context: CodeCommentContext) => void
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  onSelectReview: () => void
  onSelectFiles: () => void
  onSelectLauncher: () => void
  onCloseTab: (tab: RightWorkspacePanelTab) => void
  onRefreshReview?: () => void
}

export function RightWorkspacePanel({
  activeView,
  openTabs,
  workspaceTarget,
  openFileRequest,
  workspaceTargetError,
  review,
  canOpenReview,
  onAddCodeComment,
  onResizeStart,
  onSelectReview,
  onSelectFiles,
  onSelectLauncher,
  onCloseTab,
  onRefreshReview,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const showTabs = openTabs.length > 0

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
      {showTabs ? (
        <header
          data-testid="right-workspace-tabbar"
          role="tablist"
          className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-background px-4"
        >
          {openTabs.map(tab => (
            <RightWorkspaceTitleTab
              key={tab}
              tab={tab}
              active={activeView === tab}
              label={
                tab === 'review'
                  ? t('workbench.workspace_tab_review', '审查')
                  : t('workbench.workspace_tab_files', '文件')
              }
              icon={tab === 'review' ? FileDiff : File}
              onSelect={tab === 'review' ? onSelectReview : onSelectFiles}
              onClose={() => onCloseTab(tab)}
            />
          ))}
          <button
            type="button"
            data-testid="right-workspace-new-tab-button"
            onClick={onSelectLauncher}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.workspace_tab_new', '打开新标签页')}
          >
            <Plus className="h-4 w-4" />
          </button>
        </header>
      ) : (
        <header className="flex h-[52px] shrink-0 items-center border-b border-border bg-background px-4" />
      )}
      <div className="flex min-h-0 flex-1">
        {activeView === 'launcher' ? (
          <RightWorkspaceLauncher
            canOpenReview={canOpenReview}
            onSelectReview={onSelectReview}
            onSelectFiles={onSelectFiles}
          />
        ) : activeView === 'review' ? (
          <FileChangesReviewPanel
            loading={review.loading}
            diff={review.diff}
            error={review.error}
            onRefresh={onRefreshReview}
          />
        ) : workspaceTargetError ? (
          <section
            data-testid="workspace-target-error"
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-red-500"
          >
            {workspaceTargetError}
          </section>
        ) : (
          <FileWorkspacePanel
            key={workspaceTarget ? `${workspaceTarget.deviceId}:${workspaceTarget.path}` : 'empty'}
            target={workspaceTarget}
            openFileRequest={openFileRequest}
            onAddCodeComment={onAddCodeComment}
          />
        )}
      </div>
    </section>
  )
}

function RightWorkspaceTitleTab({
  tab,
  active,
  label,
  icon: Icon,
  onSelect,
  onClose,
}: {
  tab: RightWorkspacePanelTab
  active: boolean
  label: string
  icon: typeof File
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onSelect()
  }

  return (
    <div
      data-testid={tab === 'review' ? 'right-workspace-review-tab' : 'right-workspace-file-tab'}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        'group flex h-10 min-w-0 max-w-[240px] cursor-pointer items-center gap-2 rounded-xl py-1 pl-2 pr-4 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        active
          ? 'bg-muted text-text-primary'
          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <span className="relative h-5 w-5 shrink-0">
        <Icon
          data-testid={`${tab === 'review' ? 'right-workspace-review' : 'right-workspace-file'}-tab-icon`}
          className="absolute inset-0 m-auto h-4 w-4 text-text-secondary opacity-100 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
        />
        <button
          type="button"
          data-testid="close-right-workspace-panel-button"
          onClick={event => {
            event.stopPropagation()
            onClose()
          }}
          className="pointer-events-none absolute inset-0 m-auto flex h-5 w-5 items-center justify-center rounded-full border border-border bg-muted text-text-secondary opacity-0 transition-colors hover:border-text-muted hover:bg-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pointer-events-auto group-hover:opacity-100"
          aria-label={t('workbench.close_right_workspace_panel')}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
      <span className="truncate">{label}</span>
    </div>
  )
}

function RightWorkspaceLauncher({
  canOpenReview,
  onSelectReview,
  onSelectFiles,
}: {
  canOpenReview: boolean
  onSelectReview: () => void
  onSelectFiles: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="right-workspace-launcher"
      className="flex min-h-0 flex-1 items-center justify-center px-8"
    >
      <div className="flex w-full max-w-xl flex-col gap-3">
        <button
          type="button"
          data-testid="right-workspace-review-option"
          onClick={onSelectReview}
          disabled={!canOpenReview}
          className="flex h-12 w-full items-center gap-3 rounded-lg bg-surface px-4 text-left text-sm font-medium text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileDiff className="h-4 w-4 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.workspace_tab_review', '审查')}
          </span>
        </button>
        <button
          type="button"
          data-testid="right-workspace-file-option"
          onClick={onSelectFiles}
          className="flex h-12 w-full items-center gap-3 rounded-lg bg-surface px-4 text-left text-sm font-medium text-text-primary transition-colors hover:bg-muted"
        >
          <File className="h-4 w-4 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.workspace_tab_files', '文件')}
          </span>
        </button>
      </div>
    </div>
  )
}
