import { File, FileDiff, Globe2, Plus, SquareTerminal, X } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  FileChangesReviewPanel,
  type FileChangesReviewViewOption,
} from '@/components/chat/FileChangesReviewPanel'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'

export type RightWorkspacePanelView = 'launcher' | 'review' | 'terminal' | 'browser' | 'files'
export type RightWorkspacePanelTab = Exclude<RightWorkspacePanelView, 'launcher'>

interface RightWorkspaceReviewState {
  loading: boolean
  diff: string
  error?: string
  reviewTitle?: string
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
  focusFilePath?: string
}

interface RightWorkspacePanelProps {
  visible: boolean
  activeView: RightWorkspacePanelView
  openTabs: RightWorkspacePanelTab[]
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal?: boolean
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  workspaceTargetError?: string | null
  review: RightWorkspaceReviewState
  canOpenReview: boolean
  reviewViewOptions?: FileChangesReviewViewOption[]
  onAddCodeComment: (context: CodeCommentContext) => void
  onSelectReview: () => void
  onSelectTerminal?: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onCloseTab: (tab: RightWorkspacePanelTab) => void
  onRefreshReview?: () => void
}

export function RightWorkspacePanel({
  visible,
  activeView,
  openTabs,
  currentProject,
  devices,
  workspaceTarget,
  preferLocalTerminal = false,
  workspaceFileApi,
  openFileRequest,
  workspaceTargetError,
  review,
  canOpenReview,
  reviewViewOptions,
  onAddCodeComment,
  onSelectReview,
  onSelectTerminal,
  onSelectBrowser,
  onSelectFiles,
  onCloseTab,
  onRefreshReview,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const showTabs = openTabs.length > 0
  const browserOpen = openTabs.includes('browser')
  const [browserFaviconUrl, setBrowserFaviconUrl] = useState<string | null>(null)
  const [browserTitle, setBrowserTitle] = useState<string | null>(null)
  const visibleBrowserFaviconUrl = browserOpen ? browserFaviconUrl : null
  const visibleBrowserTitle = browserOpen ? browserTitle : null

  const openBrowserTab = () => {
    setBrowserFaviconUrl(null)
    setBrowserTitle(null)
    onSelectBrowser()
  }

  const closeTab = (tab: RightWorkspacePanelTab) => {
    if (tab === 'browser') {
      setBrowserFaviconUrl(null)
      setBrowserTitle(null)
    }
    onCloseTab(tab)
  }

  const getNewTabOptions = (): WorkspaceAddMenuItem[] => [
    {
      id: 'review',
      testId: 'right-workspace-review-option',
      icon: FileDiff,
      label: t('workbench.workspace_tab_review', '审查'),
      disabled: !canOpenReview,
      onSelect: onSelectReview,
    },
    ...(onSelectTerminal
      ? [
          {
            id: 'terminal',
            testId: 'right-workspace-terminal-option',
            icon: SquareTerminal,
            label: t('workbench.terminal', '终端'),
            onSelect: onSelectTerminal,
          },
        ]
      : []),
    ...(!browserOpen
      ? [
          {
            id: 'browser' as const,
            testId: 'right-workspace-browser-option',
            icon: Globe2,
            label: t('workbench.browser'),
            onSelect: openBrowserTab,
          },
        ]
      : []),
    {
      id: 'files',
      testId: 'right-workspace-file-option',
      icon: File,
      label: t('workbench.workspace_tab_files', '文件'),
      onSelect: onSelectFiles,
    },
  ]

  return (
    <section
      data-testid="right-workspace-panel"
      className="relative flex h-full w-full min-w-0 flex-1 basis-0 flex-col bg-background opacity-100 transition-[opacity,transform] duration-300 ease-out"
    >
      {showTabs ? (
        <header
          data-testid="right-workspace-tabbar"
          role="tablist"
          className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-background px-3"
        >
          {openTabs.map(tab => (
            <RightWorkspaceTitleTab
              key={tab}
              tab={tab}
              active={activeView === tab}
              label={getRightWorkspaceTabLabel(tab, t, visibleBrowserTitle)}
              icon={getRightWorkspaceTabIcon(tab)}
              iconSrc={tab === 'browser' ? visibleBrowserFaviconUrl : null}
              onSelect={
                tab === 'review'
                  ? onSelectReview
                  : tab === 'terminal'
                    ? onSelectTerminal
                    : tab === 'browser'
                      ? onSelectBrowser
                      : onSelectFiles
              }
              onClose={() => closeTab(tab)}
            />
          ))}
          <div className="relative">
            {visible ? (
              <WorkspaceAddMenu
                ariaLabel={t('workbench.workspace_tab_new', '打开新标签页')}
                buttonTestId="right-workspace-new-tab-button"
                menuTestId="right-workspace-new-tab-menu"
                items={getNewTabOptions()}
                buttonClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
              />
            ) : (
              <button
                type="button"
                data-testid="right-workspace-new-tab-button"
                disabled
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary opacity-50"
                aria-label={t('workbench.workspace_tab_new', '打开新标签页')}
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>
        </header>
      ) : (
        <header className="flex h-10 shrink-0 items-center border-b border-border bg-background px-3" />
      )}
      <div className="flex min-h-0 flex-1">
        {activeView === 'launcher' ? (
          <RightWorkspaceLauncher
            canOpenReview={canOpenReview}
            browserOpen={browserOpen}
            onSelectReview={onSelectReview}
            onSelectBrowser={openBrowserTab}
            onSelectFiles={onSelectFiles}
          />
        ) : activeView === 'review' ? (
          <FileChangesReviewPanel
            loading={review.loading}
            diff={review.diff}
            error={review.error}
            reviewTitle={review.reviewTitle}
            defaultFileTreeVisible={review.defaultFileTreeVisible}
            branchName={review.branchName}
            targetBranchName={review.targetBranchName}
            focusFilePath={review.focusFilePath}
            viewOptions={reviewViewOptions}
            onRefresh={onRefreshReview}
          />
        ) : activeView === 'terminal' ? (
          <WorkspacePanelCards
            currentProject={currentProject}
            devices={devices}
            workspaceTarget={workspaceTarget}
            defaultOpenTool="terminal"
            hideTerminalChrome
            preferLocalTerminal={preferLocalTerminal}
          />
        ) : workspaceTargetError ? (
          <section
            data-testid="workspace-target-error"
            hidden={activeView !== 'files'}
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-red-500"
          >
            {workspaceTargetError}
          </section>
        ) : (
          activeView === 'files' && (
            <FileWorkspacePanel
              key={
                workspaceTarget ? `${workspaceTarget.deviceId}:${workspaceTarget.path}` : 'empty'
              }
              target={workspaceTarget}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={openFileRequest}
              onAddCodeComment={onAddCodeComment}
            />
          )
        )}
        {browserOpen && (
          <WorkspaceBrowserPanel
            active={visible && activeView === 'browser'}
            onFaviconChange={setBrowserFaviconUrl}
            onTitleChange={setBrowserTitle}
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
  iconSrc,
  onSelect,
  onClose,
}: {
  tab: RightWorkspacePanelTab
  active: boolean
  label: string
  icon: typeof File
  iconSrc?: string | null
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
      data-testid={getRightWorkspaceTabTestId(tab)}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        'group flex h-8 min-w-0 max-w-[200px] cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        active
          ? 'bg-muted text-text-primary'
          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <RightWorkspaceTabIcon
        icon={Icon}
        iconSrc={iconSrc}
        testId={getRightWorkspaceTabTestId(tab)}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        data-testid="close-right-workspace-panel-button"
        onClick={event => {
          event.stopPropagation()
          onClose()
        }}
        className="pointer-events-none ml-auto flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-muted text-text-secondary opacity-0 transition-colors hover:border-text-muted hover:bg-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pointer-events-auto group-hover:opacity-100"
        aria-label={t('workbench.close_right_workspace_panel')}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

function RightWorkspaceTabIcon({
  icon: Icon,
  iconSrc,
  testId,
}: {
  icon: typeof File
  iconSrc?: string | null
  testId: string
}) {
  const [failedIconSrc, setFailedIconSrc] = useState<string | null>(null)
  const imageFailed = Boolean(iconSrc && failedIconSrc === iconSrc)

  if (iconSrc && !imageFailed) {
    return (
      <img
        data-testid={`${testId}-favicon`}
        src={iconSrc}
        alt=""
        className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
        onError={() => setFailedIconSrc(iconSrc)}
      />
    )
  }

  return (
    <Icon data-testid={`${testId}-icon`} className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
  )
}

function RightWorkspaceLauncher({
  canOpenReview,
  browserOpen,
  onSelectReview,
  onSelectBrowser,
  onSelectFiles,
}: {
  canOpenReview: boolean
  browserOpen: boolean
  onSelectReview: () => void
  onSelectBrowser: () => void
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
        {!browserOpen && (
          <button
            type="button"
            data-testid="right-workspace-browser-option"
            onClick={onSelectBrowser}
            className="flex h-12 w-full items-center gap-3 rounded-lg bg-surface px-4 text-left text-sm font-medium text-text-primary transition-colors hover:bg-muted"
          >
            <Globe2 className="h-4 w-4 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">{t('workbench.browser')}</span>
          </button>
        )}
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

function getRightWorkspaceTabLabel(
  tab: RightWorkspacePanelTab,
  t: ReturnType<typeof useTranslation>['t'],
  browserTitle?: string | null
) {
  if (tab === 'review') return t('workbench.workspace_tab_review', '审查')
  if (tab === 'terminal') return t('workbench.terminal', '终端')
  if (tab === 'browser') return browserTitle || t('workbench.browser_new_tab', '新选项卡')
  return t('workbench.workspace_tab_files', '文件')
}

function getRightWorkspaceTabTestId(tab: RightWorkspacePanelTab) {
  if (tab === 'terminal') return 'right-workspace-terminal-tab'
  if (tab === 'files') return 'right-workspace-file-tab'
  return `right-workspace-${tab}-tab`
}

function getRightWorkspaceTabIcon(tab: RightWorkspacePanelTab) {
  if (tab === 'review') return FileDiff
  if (tab === 'terminal') return SquareTerminal
  if (tab === 'browser') return Globe2
  return File
}
