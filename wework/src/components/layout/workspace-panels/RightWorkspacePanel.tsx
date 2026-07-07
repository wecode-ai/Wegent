import {
  File,
  FileDiff,
  Globe2,
  ListChecks,
  MessageCircle,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  FileChangesReviewPanel,
  type FileChangesReviewViewOption,
} from '@/components/chat/FileChangesReviewPanel'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { TitlebarRightPanelPortal } from '@/components/topnav/TitlebarActionsPortal'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { EmbeddedBrowserOpenRequest } from '@/lib/embedded-browser'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { isEditableShortcutTarget } from '@/lib/keybindings'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanel'
import { WorkspacePanelCards } from './WorkspacePanelCards'
import { TemporaryChatPanel } from './TemporaryChatPanel'

const RIGHT_WORKSPACE_SHORTCUTS = {
  review: '⌥⌘R',
  browser: '⌘T',
  chat: '⌥⌘S',
  files: '⌥⌘F',
} as const

export type RightWorkspaceChatTab = `chat:${string}`
export type RightWorkspacePanelTab =
  | 'review'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'plan'
  | RightWorkspaceChatTab
export type RightWorkspacePanelView = 'launcher' | RightWorkspacePanelTab

function isRightWorkspaceChatTab(tab: RightWorkspacePanelView): tab is RightWorkspaceChatTab {
  return tab.startsWith('chat:')
}

function getRightWorkspaceChatTabSuffix(tab: RightWorkspaceChatTab) {
  return tab.slice('chat:'.length)
}

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
  currentRuntimeTask: RuntimeTaskAddress | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal?: boolean
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  workspaceTargetError?: string | null
  review: RightWorkspaceReviewState
  planContent?: string | null
  embeddedBrowserLabel?: string
  embeddedBrowserOpenRequest?: (EmbeddedBrowserOpenRequest & { id: number }) | null
  codeCommentCount?: number
  canOpenReview: boolean
  reviewViewOptions?: FileChangesReviewViewOption[]
  onAddCodeComment: (context: CodeCommentContext) => void
  onSelectReview: () => void
  onSelectTerminal: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onSelectChat: () => void
  onSelectPlan: () => void
  onSelectTab: (tab: RightWorkspacePanelTab) => void
  onCloseTab: (tab: RightWorkspacePanelTab) => void
  onRefreshReview?: () => void
}

export function RightWorkspacePanel({
  visible,
  activeView,
  openTabs,
  currentProject,
  currentRuntimeTask,
  devices,
  workspaceTarget,
  preferLocalTerminal = false,
  workspaceFileApi,
  openFileRequest,
  workspaceTargetError,
  review,
  planContent,
  embeddedBrowserLabel = 'workspace-browser',
  embeddedBrowserOpenRequest,
  codeCommentCount = 0,
  canOpenReview,
  reviewViewOptions,
  onAddCodeComment,
  onSelectReview,
  onSelectTerminal,
  onSelectBrowser,
  onSelectFiles,
  onSelectChat,
  onSelectTab,
  onCloseTab,
  onRefreshReview,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const showTabs = openTabs.length > 0
  const renderTabsInTitlebar = isTauriRuntime() && visible && showTabs
  const browserOpen = openTabs.includes('browser')
  const [browserFaviconUrl, setBrowserFaviconUrl] = useState<string | null>(null)
  const [browserTitle, setBrowserTitle] = useState<string | null>(null)
  const visibleBrowserFaviconUrl = browserOpen ? browserFaviconUrl : null
  const visibleBrowserTitle = browserOpen ? browserTitle : null

  const openBrowserTab = useCallback(() => {
    setBrowserFaviconUrl(null)
    setBrowserTitle(null)
    onSelectBrowser()
  }, [onSelectBrowser])

  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return

      const key = event.key.toLowerCase()
      const primaryPressed = event.metaKey && !event.ctrlKey && !event.shiftKey

      if (primaryPressed && !event.altKey && key === 't' && !browserOpen) {
        event.preventDefault()
        openBrowserTab()
        return
      }

      if (!primaryPressed || !event.altKey) return

      if (key === 'r' && canOpenReview) {
        event.preventDefault()
        onSelectReview()
      } else if (key === 's') {
        event.preventDefault()
        onSelectChat()
      } else if (key === 'f') {
        event.preventDefault()
        onSelectFiles()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    browserOpen,
    canOpenReview,
    onSelectChat,
    onSelectFiles,
    onSelectReview,
    openBrowserTab,
    visible,
  ])

  const closeTab = (tab: RightWorkspacePanelTab) => {
    if (tab === 'browser') {
      setBrowserFaviconUrl(null)
      setBrowserTitle(null)
    }
    onCloseTab(tab)
  }

  const getTabSelectHandler =
    (tab: RightWorkspacePanelTab): (() => void) =>
    () =>
      onSelectTab(tab)

  const getNewTabOptions = (): WorkspaceAddMenuItem[] => [
    {
      id: 'review',
      testId: 'right-workspace-review-option',
      icon: FileDiff,
      label: t('workbench.workspace_tab_review', '审查'),
      shortcut: RIGHT_WORKSPACE_SHORTCUTS.review,
      disabled: !canOpenReview,
      onSelect: onSelectReview,
    },
    {
      id: 'terminal',
      testId: 'right-workspace-terminal-option',
      icon: SquareTerminal,
      label: t('workbench.terminal', '终端'),
      onSelect: onSelectTerminal,
    },
    ...(!browserOpen
      ? [
          {
            id: 'browser' as const,
            testId: 'right-workspace-browser-option',
            icon: Globe2,
            label: t('workbench.browser'),
            shortcut: RIGHT_WORKSPACE_SHORTCUTS.browser,
            onSelect: openBrowserTab,
          },
        ]
      : []),
    {
      id: 'chat',
      testId: 'right-workspace-chat-option',
      icon: MessageCircle,
      label: t('workbench.workspace_tab_chat', '临时聊天'),
      shortcut: RIGHT_WORKSPACE_SHORTCUTS.chat,
      onSelect: onSelectChat,
    },
    {
      id: 'files',
      testId: 'right-workspace-file-option',
      icon: File,
      label: t('workbench.workspace_tab_files', '文件'),
      shortcut: RIGHT_WORKSPACE_SHORTCUTS.files,
      onSelect: onSelectFiles,
    },
  ]

  const tabBar = showTabs ? (
    <header
      data-testid="right-workspace-tabbar"
      role="tablist"
      className={cn(
        'relative z-chrome flex shrink-0 items-center gap-1.5 pointer-events-auto',
        renderTabsInTitlebar
          ? 'h-[38px] w-full bg-transparent pl-4 pr-2'
          : 'h-10 border-b border-border bg-background px-3'
      )}
    >
      {openTabs.map(tab => (
        <RightWorkspaceTitleTab
          key={tab}
          tab={tab}
          active={activeView === tab}
          label={getRightWorkspaceTabLabel(tab, t, visibleBrowserTitle)}
          icon={getRightWorkspaceTabIcon(tab)}
          iconSrc={tab === 'browser' ? visibleBrowserFaviconUrl : null}
          onSelect={getTabSelectHandler(tab)}
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
            buttonClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary pointer-events-auto"
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
      {renderTabsInTitlebar ? (
        <div
          data-testid="right-workspace-titlebar-drag-region"
          className="min-w-0 flex-1 self-stretch"
        >
          <MacOSTitleBarDragRegion className="h-full w-full" />
        </div>
      ) : null}
    </header>
  ) : null
  const chatTabs = openTabs.filter(isRightWorkspaceChatTab)

  return (
    <section
      data-testid="right-workspace-panel"
      className="relative flex h-full w-full min-w-0 flex-1 basis-0 flex-col bg-background opacity-100 transition-[opacity,transform] duration-300 ease-out"
    >
      {renderTabsInTitlebar ? <TitlebarRightPanelPortal>{tabBar}</TitlebarRightPanelPortal> : null}
      {renderTabsInTitlebar ? null : tabBar}
      <div className="flex min-h-0 flex-1">
        {!isRightWorkspaceChatTab(activeView) && activeView === 'launcher' ? (
          <RightWorkspaceLauncher
            canOpenReview={canOpenReview}
            browserOpen={browserOpen}
            onSelectReview={onSelectReview}
            onSelectBrowser={openBrowserTab}
            onSelectFiles={onSelectFiles}
            onSelectChat={onSelectChat}
          />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'review' ? (
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
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'terminal' ? (
          <WorkspacePanelCards
            currentProject={currentProject}
            devices={devices}
            workspaceTarget={workspaceTarget}
            defaultOpenTool="terminal"
            hideTerminalChrome
            preferLocalTerminal={preferLocalTerminal}
          />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'plan' ? (
          <PlanWorkspacePanel content={planContent ?? ''} />
        ) : !isRightWorkspaceChatTab(activeView) && workspaceTargetError ? (
          <section
            data-testid="workspace-target-error"
            hidden={activeView !== 'files'}
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-red-500"
          >
            {workspaceTargetError}
          </section>
        ) : (
          !isRightWorkspaceChatTab(activeView) &&
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
        {chatTabs.map(tab => (
          <div
            key={tab}
            className={cn('min-h-0 flex-1 flex-col', activeView === tab ? 'flex' : 'hidden')}
          >
            <TemporaryChatPanel
              currentProject={currentProject}
              source={currentRuntimeTask}
              instanceId={tab}
              testId={
                activeView === tab
                  ? 'right-workspace-chat-panel'
                  : `right-workspace-chat-panel-${getRightWorkspaceChatTabSuffix(tab)}`
              }
            />
          </div>
        ))}
        {browserOpen && (
          <WorkspaceBrowserPanel
            active={visible && activeView === 'browser'}
            label={embeddedBrowserLabel}
            openRequest={embeddedBrowserOpenRequest}
            codeCommentCount={codeCommentCount}
            onAddCodeComment={onAddCodeComment}
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
  icon: LucideIcon
  iconSrc?: string | null
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
        'group/tab relative flex h-8 min-w-0 max-w-[200px] cursor-pointer items-stretch rounded-md text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 pointer-events-auto',
        active
          ? 'bg-muted text-text-primary'
          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          onSelect()
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-2 pr-7 text-left"
      >
        <RightWorkspaceTabIcon
          icon={Icon}
          iconSrc={iconSrc}
          testId={getRightWorkspaceTabTestId(tab)}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      <span className="pointer-events-none absolute right-1 top-1/2 z-critical flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <button
          type="button"
          data-testid={`${getRightWorkspaceTabTestId(tab)}-close-button`}
          onClick={event => {
            event.stopPropagation()
            onClose()
          }}
          className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label={t('workbench.close_right_workspace_panel')}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
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

function PlanWorkspacePanel({ content }: { content: string }) {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="workspace-plan-panel"
      className="min-h-0 flex-1 overflow-y-auto bg-background px-8 py-6"
    >
      <div className="mx-auto max-w-4xl text-[15px] leading-7 text-text-primary">
        {content.trim() ? (
          <AssistantMarkdown content={content} />
        ) : (
          <div className="text-sm text-text-muted">
            {t('workbench.workspace_plan_empty', '暂无计划内容')}
          </div>
        )}
      </div>
    </section>
  )
}

function RightWorkspaceLauncher({
  canOpenReview,
  browserOpen,
  onSelectReview,
  onSelectBrowser,
  onSelectFiles,
  onSelectChat,
}: {
  canOpenReview: boolean
  browserOpen: boolean
  onSelectReview: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onSelectChat: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="right-workspace-launcher"
      className="flex min-h-0 flex-1 items-center justify-center px-8"
    >
      <div className="flex w-full max-w-xl flex-col gap-1.5">
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-review-option"
          icon={FileDiff}
          label={t('workbench.workspace_tab_review', '审查')}
          shortcut={RIGHT_WORKSPACE_SHORTCUTS.review}
          onClick={onSelectReview}
          disabled={!canOpenReview}
        />
        {!browserOpen && (
          <RightWorkspaceLauncherItem
            data-testid="right-workspace-browser-option"
            icon={Globe2}
            label={t('workbench.browser')}
            shortcut={RIGHT_WORKSPACE_SHORTCUTS.browser}
            onClick={onSelectBrowser}
          />
        )}
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-chat-option"
          icon={MessageCircle}
          label={t('workbench.workspace_tab_chat', '临时聊天')}
          shortcut={RIGHT_WORKSPACE_SHORTCUTS.chat}
          onClick={onSelectChat}
        />
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-file-option"
          icon={File}
          label={t('workbench.workspace_tab_files', '文件')}
          shortcut={RIGHT_WORKSPACE_SHORTCUTS.files}
          onClick={onSelectFiles}
        />
      </div>
    </div>
  )
}

function RightWorkspaceLauncherItem({
  icon: Icon,
  label,
  shortcut,
  disabled,
  onClick,
  'data-testid': testId,
}: {
  icon: typeof File
  label: string
  shortcut: string
  disabled?: boolean
  onClick: () => void
  'data-testid': string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 w-full items-center gap-2 rounded-xl bg-surface px-3 text-left text-[13px] font-light leading-[18px] text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 rounded-lg bg-background/80 px-1.5 py-0.5 text-[11px] font-light leading-4 text-text-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]">
        {shortcut}
      </span>
    </button>
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
  if (isRightWorkspaceChatTab(tab)) return t('workbench.workspace_tab_chat', '临时聊天')
  if (tab === 'plan') return t('workbench.workspace_tab_plan', '计划')
  return t('workbench.workspace_tab_files', '文件')
}

function getRightWorkspaceTabTestId(tab: RightWorkspacePanelTab) {
  if (tab === 'terminal') return 'right-workspace-terminal-tab'
  if (tab === 'files') return 'right-workspace-file-tab'
  if (isRightWorkspaceChatTab(tab)) {
    return `right-workspace-chat-tab-${getRightWorkspaceChatTabSuffix(tab)}`
  }
  return `right-workspace-${tab}-tab`
}

function getRightWorkspaceTabIcon(tab: RightWorkspacePanelTab) {
  if (tab === 'review') return FileDiff
  if (tab === 'terminal') return SquareTerminal
  if (tab === 'browser') return Globe2
  if (isRightWorkspaceChatTab(tab)) return MessageCircle
  if (tab === 'plan') return ListChecks
  return File
}
