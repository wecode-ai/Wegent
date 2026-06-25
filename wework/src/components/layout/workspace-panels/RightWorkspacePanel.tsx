import { File, FileDiff, Globe2, Plus, X } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import {
  FileChangesReviewPanel,
  type FileChangesReviewViewOption,
} from '@/components/chat/FileChangesReviewPanel'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanel'

const NEW_TAB_MENU_WIDTH = 256
const NEW_TAB_MENU_OFFSET = 6
const NATIVE_MENU_LABEL_MIN_LENGTH = 8

export type RightWorkspacePanelView = 'launcher' | 'review' | 'browser' | 'files'
export type RightWorkspacePanelTab = Exclude<RightWorkspacePanelView, 'launcher'>
type RightWorkspaceNewTabOptionId = 'review' | 'browser' | 'files'

interface RightWorkspaceNewTabOption {
  enabled?: boolean
  icon: typeof File
  id: RightWorkspaceNewTabOptionId
  label: string
  onSelect: () => void
  testId: string
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
  workspaceTarget: WorkspaceTarget | null
  openFileRequest?: WorkspaceFileOpenRequest | null
  workspaceTargetError?: string | null
  review: RightWorkspaceReviewState
  canOpenReview: boolean
  reviewViewOptions?: FileChangesReviewViewOption[]
  onAddCodeComment: (context: CodeCommentContext) => void
  onSelectReview: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onCloseTab: (tab: RightWorkspacePanelTab) => void
  onRefreshReview?: () => void
}

export function RightWorkspacePanel({
  visible,
  activeView,
  openTabs,
  workspaceTarget,
  openFileRequest,
  workspaceTargetError,
  review,
  canOpenReview,
  reviewViewOptions,
  onAddCodeComment,
  onSelectReview,
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
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const [newTabMenuPosition, setNewTabMenuPosition] = useState<CSSProperties | undefined>()
  const panelRef = useRef<HTMLElement | null>(null)
  const newTabButtonRef = useRef<HTMLButtonElement | null>(null)
  const newTabMenuRef = useRef<HTMLDivElement | null>(null)
  const visibleNewTabMenuOpen = visible && newTabMenuOpen
  const visibleBrowserFaviconUrl = browserOpen ? browserFaviconUrl : null
  const visibleBrowserTitle = browserOpen ? browserTitle : null

  useEffect(() => {
    if (visible) return

    const resetMenuTimer = window.setTimeout(() => setNewTabMenuOpen(false), 0)
    return () => window.clearTimeout(resetMenuTimer)
  }, [visible])

  useEffect(() => {
    if (!visibleNewTabMenuOpen) return

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (newTabMenuRef.current?.contains(target) || newTabButtonRef.current?.contains(target)) {
        return
      }
      setNewTabMenuOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNewTabMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [visibleNewTabMenuOpen])

  const closeNewTabMenu = () => {
    setNewTabMenuOpen(false)
  }

  const selectNewTabOption = (handler: () => void) => {
    handler()
    closeNewTabMenu()
  }

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

  const getNewTabOptions = (): RightWorkspaceNewTabOption[] => [
    {
      id: 'review',
      testId: 'right-workspace-review-option',
      icon: FileDiff,
      label: t('workbench.workspace_tab_review', '审查'),
      enabled: canOpenReview,
      onSelect: onSelectReview,
    },
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

  const openNativeNewTabMenu = async () => {
    const buttonRect = newTabButtonRef.current?.getBoundingClientRect()
    if (!buttonRect) return false

    const [{ Menu }, { LogicalPosition }, { getCurrentWindow }] = await Promise.all([
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/dpi'),
      import('@tauri-apps/api/window'),
    ])
    const menu = await Menu.new({
      id: 'right-workspace-new-tab-native-menu',
      items: getNewTabOptions().map(option => ({
        id: `right-workspace-new-tab-${option.id}`,
        text: formatNativeMenuLabel(option.label),
        enabled: option.enabled ?? true,
        action: () => option.onSelect(),
      })),
    })

    await menu.popup(
      new LogicalPosition(
        Math.round(buttonRect.left),
        Math.round(buttonRect.bottom + NEW_TAB_MENU_OFFSET)
      ),
      getCurrentWindow()
    )
    return true
  }

  const updateNewTabMenuPosition = () => {
    const panelRect = panelRef.current?.getBoundingClientRect()
    const buttonRect = newTabButtonRef.current?.getBoundingClientRect()
    if (!panelRect || !buttonRect) {
      setNewTabMenuPosition(undefined)
      return
    }

    const maxLeft = Math.max(8, panelRect.width - NEW_TAB_MENU_WIDTH - 8)
    const left = Math.min(Math.max(8, buttonRect.left - panelRect.left), maxLeft)
    const top = Math.max(8, buttonRect.bottom - panelRect.top + NEW_TAB_MENU_OFFSET)

    setNewTabMenuPosition({
      left,
      top,
    })
  }

  const toggleNewTabMenu = () => {
    if (visibleNewTabMenuOpen) {
      closeNewTabMenu()
      return
    }

    if (isTauriRuntime()) {
      void openNativeNewTabMenu().catch(error => {
        console.error('Failed to open native workspace tab menu:', error)
        updateNewTabMenuPosition()
        setNewTabMenuOpen(true)
      })
      return
    }

    updateNewTabMenuPosition()
    setNewTabMenuOpen(true)
  }

  return (
    <section
      ref={panelRef}
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
                  : tab === 'browser'
                    ? onSelectBrowser
                    : onSelectFiles
              }
              onClose={() => closeTab(tab)}
            />
          ))}
          <div className="relative">
            <button
              ref={newTabButtonRef}
              type="button"
              data-testid="right-workspace-new-tab-button"
              onClick={toggleNewTabMenu}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.workspace_tab_new', '打开新标签页')}
              aria-expanded={visibleNewTabMenuOpen}
              aria-haspopup="menu"
            >
              <Plus className="h-4 w-4" />
            </button>
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
      {visibleNewTabMenuOpen && (
        <RightWorkspaceNewTabMenu
          ref={newTabMenuRef}
          style={newTabMenuPosition}
          options={getNewTabOptions().map(option => ({
            ...option,
            onSelect: () => selectNewTabOption(option.onSelect),
          }))}
        />
      )}
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

interface RightWorkspaceNewTabMenuProps {
  options: RightWorkspaceNewTabOption[]
  style?: CSSProperties
}

const RightWorkspaceNewTabMenu = forwardRef<HTMLDivElement, RightWorkspaceNewTabMenuProps>(
  function RightWorkspaceNewTabMenu({ options, style }, ref) {
    return (
      <div
        ref={ref}
        data-testid="right-workspace-new-tab-menu"
        role="menu"
        style={style}
        className="absolute z-system-popover w-64 rounded-lg border border-border bg-popover p-1.5 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      >
        {options.map(option => (
          <RightWorkspaceNewTabMenuItem
            key={option.id}
            testId={option.testId}
            icon={option.icon}
            label={option.label}
            disabled={option.enabled === false}
            onSelect={option.onSelect}
          />
        ))}
      </div>
    )
  }
)

function RightWorkspaceNewTabMenuItem({
  disabled,
  icon: Icon,
  label,
  onSelect,
  testId,
}: {
  disabled?: boolean
  icon: typeof File
  label: string
  onSelect: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
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
  if (tab === 'browser') return browserTitle || t('workbench.browser_new_tab', '新选项卡')
  return t('workbench.workspace_tab_files', '文件')
}

function getRightWorkspaceTabTestId(tab: RightWorkspacePanelTab) {
  if (tab === 'files') return 'right-workspace-file-tab'
  return `right-workspace-${tab}-tab`
}

function getRightWorkspaceTabIcon(tab: RightWorkspacePanelTab) {
  if (tab === 'review') return FileDiff
  if (tab === 'browser') return Globe2
  return File
}

function formatNativeMenuLabel(label: string) {
  const paddingLength = Math.max(0, NATIVE_MENU_LABEL_MIN_LENGTH - Array.from(label).length)
  return paddingLength === 0 ? label : `${label}${'\u00a0'.repeat(paddingLength)}`
}
