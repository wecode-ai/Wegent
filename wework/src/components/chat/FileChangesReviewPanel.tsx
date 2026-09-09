import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  GitCompareArrows,
  ListCollapse,
  RefreshCw,
  Rows3,
  WrapText,
} from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import type { DiffLineEventBaseProps } from '@pierre/diffs'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { GitPatchAction } from '@/api/environment'
import { parseUnifiedDiff, type DiffFileSection } from './parseUnifiedDiff'
import { DiffCommentComposer, ReviewPatchActionButton } from './fileChangesReviewInteractions'
import {
  ensureTrailingNewline,
  fileNameFromPath,
  getDiffSelection,
  getFirstChangedLine,
  getHunkPatches,
  getReviewActions,
  type DiffCommentSelection,
  type FileChangesReviewMode,
} from './fileChangesReviewUtils'
import { ReviewFileTree } from './FileChangesReviewTree'

const LARGE_DIFF_FILE_COUNT_THRESHOLD = 12
const LARGE_DIFF_LINE_COUNT_THRESHOLD = 700
const PIERRE_DIFF_CSS = `
  :host {
    --diffs-light-bg: rgb(var(--color-bg-base));
    --diffs-light: rgb(var(--color-text-primary));
    --diffs-dark-bg: rgb(var(--color-bg-base));
    --diffs-dark: rgb(var(--color-text-primary));
    --diffs-fg-number-override: rgb(var(--color-text-muted));
    --diffs-bg-context-override: rgb(var(--color-bg-base));
    --diffs-bg-context-gutter-override: rgb(var(--color-bg-surface));
    --diffs-bg-hover-override: rgb(var(--color-muted));
    background: rgb(var(--color-bg-base)) !important;
  }
  :host, pre, code {
    font-family: var(--font-code);
    font-size: var(--text-code);
    line-height: 1.8;
  }
  [data-diffs-file-header], [data-diffs-header] {
    min-height: 36px;
    border-bottom: 1px solid rgb(var(--color-border));
    background: rgb(var(--color-bg-base));
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  [data-diffs-line-addition], [data-diffs-line-added] {
    background: rgb(34 197 94 / 0.12);
  }
  [data-diffs-line-deletion], [data-diffs-line-deleted] {
    background: rgb(239 68 68 / 0.12);
  }
`
interface FileChangesReviewPanelProps {
  loading: boolean
  diff: string
  error?: string
  className?: string
  reviewTitle?: string
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
  focusFilePath?: string
  reviewMode?: 'branch' | 'unstaged' | 'staged' | 'commit' | 'previous-turn'
  viewOptions?: FileChangesReviewViewOption[]
  onRefresh?: () => void
  onOpenSourceFile?: (path: string, lineStart?: number, lineEnd?: number) => void
  onApplyPatch?: (action: GitPatchAction, patch: string) => Promise<void>
  onAddCodeComment?: (context: CodeCommentContext) => void
}

export interface FileChangesReviewViewOption {
  id: string
  label: string
  active: boolean
  disabled?: boolean
  onSelect: () => void
}

type ReviewMode = FileChangesReviewMode

export function FileChangesReviewPanel({
  loading,
  diff,
  error,
  className,
  reviewTitle,
  defaultFileTreeVisible = true,
  branchName,
  targetBranchName,
  focusFilePath,
  reviewMode,
  viewOptions,
  onRefresh,
  onOpenSourceFile,
  onApplyPatch,
  onAddCodeComment,
}: FileChangesReviewPanelProps) {
  const { t } = useTranslation('chat')
  const appearance = useOptionalAppearance()
  const themeType =
    appearance?.resolvedMode ??
    (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
      ? 'dark'
      : 'light')
  const [selection, setSelection] = useState<{
    focusFilePath?: string
    path?: string
  }>({})
  const [wrapLines, setWrapLines] = useState(false)
  const [hunksCollapsed, setHunksCollapsed] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [fileTreeVisible, setFileTreeVisible] = useState(defaultFileTreeVisible)
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified')
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [commentSelection, setCommentSelection] = useState<DiffCommentSelection | null>(null)
  const [comment, setComment] = useState('')
  const diffLinesRef = useRef<HTMLDivElement>(null)

  const sections = useMemo(() => parseUnifiedDiff(diff), [diff])
  const focusSectionIndex = useMemo(
    () => (focusFilePath ? findSectionIndexForPath(sections, focusFilePath) : -1),
    [focusFilePath, sections]
  )
  const defaultSelectedIndex = focusSectionIndex >= 0 ? focusSectionIndex : 0
  const selectedPathIndex =
    selection.focusFilePath === focusFilePath && selection.path
      ? findSectionIndexForPath(sections, selection.path)
      : -1
  const selectedIndex = selectedPathIndex >= 0 ? selectedPathIndex : defaultSelectedIndex
  const selectedSection = sections[selectedIndex] ?? sections[0]
  const diffStats = useMemo(() => getSectionsDiffStats(sections), [sections])
  const isLargeDiff = useMemo(() => isLargeReviewDiff(sections), [sections])
  const displayedSections = isLargeDiff && selectedSection ? [selectedSection] : sections

  const scrollToSection = useCallback((section: DiffFileSection, behavior: ScrollBehavior) => {
    const container = diffLinesRef.current
    const target = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-review-path]') ?? []
    ).find(element => element.dataset.reviewPath === section.path)
    target?.scrollIntoView({ behavior, block: 'start' })
  }, [])

  const selectSection = useCallback(
    (index: number) => {
      const section = sections[index]
      if (!section) return
      setSelection({ focusFilePath, path: section.path })
      setHunksCollapsed(false)
      requestAnimationFrame(() => scrollToSection(section, 'smooth'))
    },
    [focusFilePath, scrollToSection, sections]
  )

  useEffect(() => {
    if (focusSectionIndex < 0) return
    const section = sections[focusSectionIndex]
    requestAnimationFrame(() => scrollToSection(section, 'instant'))
  }, [focusFilePath, focusSectionIndex, scrollToSection, sections])

  const applyPatch = useCallback(
    async (action: GitPatchAction, patch: string, operationKey: string) => {
      if (!onApplyPatch || pendingAction) return
      if (
        action === 'revert' &&
        !window.confirm(t('file_changes.confirm_partial_revert_description'))
      ) {
        return
      }
      setPendingAction(operationKey)
      setActionError(null)
      try {
        await onApplyPatch(action, ensureTrailingNewline(patch))
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      } finally {
        setPendingAction(null)
      }
    },
    [onApplyPatch, pendingAction, t]
  )

  const toggleSectionCollapsed = (section: DiffFileSection, index: number) => {
    const key = getDiffSectionKey(section, index)
    setCollapsedSections(current => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const copyGitApplyCommand = () => {
    const patch = diff.trimEnd()
    void navigator.clipboard?.writeText(`git apply <<'PATCH'\n${patch}\nPATCH`)
  }

  return (
    <div
      data-testid="file-changes-review-panel"
      data-theme={themeType}
      className={cn('min-h-0 flex-1 overflow-hidden bg-background', className)}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-text-muted">{t('file_changes.loading_diff')}</p>
      ) : error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <ReviewToolbar
            title={reviewTitle}
            branchName={branchName}
            targetBranchName={targetBranchName}
            viewOptions={viewOptions}
            additions={diffStats.additions}
            deletions={diffStats.deletions}
            wrapLines={wrapLines}
            hunksCollapsed={hunksCollapsed}
            fileTreeVisible={fileTreeVisible}
            diffStyle={diffStyle}
            canRefresh={Boolean(onRefresh)}
            onRefresh={onRefresh}
            onToggleWrap={() => setWrapLines(value => !value)}
            onToggleHunks={() => setHunksCollapsed(value => !value)}
            onToggleFileTree={() => setFileTreeVisible(value => !value)}
            onToggleDiffStyle={() =>
              setDiffStyle(current => (current === 'unified' ? 'split' : 'unified'))
            }
            onCopyGitApplyCommand={copyGitApplyCommand}
          />
          {isLargeDiff ? (
            <p className="shrink-0 border-b border-border bg-background px-6 py-2 text-sm text-text-muted">
              {t('file_changes.large_diff_single_file_notice')}
            </p>
          ) : null}
          {actionError ? (
            <p
              data-testid="file-changes-review-action-error"
              className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              {actionError}
            </p>
          ) : null}
          <div
            data-testid="file-changes-review-content"
            className="flex min-h-0 flex-1 overflow-hidden"
          >
            {sections.length === 0 ? (
              <div
                data-testid="file-changes-review-empty"
                className="flex min-w-0 flex-1 items-center justify-center px-4 py-8 text-center text-sm text-text-muted"
              >
                {t('file_changes.empty_diff')}
              </div>
            ) : (
              <AllDiffSections
                sections={displayedSections}
                ariaLabel={t('file_changes.all_files_diff_label')}
                wrapLines={wrapLines}
                diffLinesRef={diffLinesRef}
                diffStyle={diffStyle}
                hunksCollapsed={hunksCollapsed}
                collapsedSections={collapsedSections}
                expandFileLabel={t('file_changes.actions.expand_file_diff')}
                collapseFileLabel={t('file_changes.actions.collapse_file_diff')}
                onToggleSectionCollapsed={toggleSectionCollapsed}
                reviewMode={reviewMode}
                pendingAction={pendingAction}
                onApplyPatch={applyPatch}
                onOpenSourceFile={onOpenSourceFile}
                canComment={Boolean(onAddCodeComment)}
                commentSelection={commentSelection}
                onCommentSelectionChange={selection => {
                  setCommentSelection(selection)
                  setComment('')
                }}
                themeType={themeType}
              />
            )}
            {sections.length > 0 && (
              <ReviewFileTree
                visible={fileTreeVisible}
                selectedSection={selectedSection}
                sections={sections}
                onSelectSection={selectSection}
              />
            )}
            {commentSelection ? (
              <DiffCommentComposer
                selection={commentSelection}
                comment={comment}
                onCommentChange={setComment}
                onCancel={() => {
                  setCommentSelection(null)
                  setComment('')
                }}
                onSubmit={() => {
                  if (!onAddCodeComment || !comment.trim()) return
                  onAddCodeComment({
                    id: `code-comment-${Date.now()}`,
                    source: 'code_selection',
                    filePath: commentSelection.path,
                    fileName: fileNameFromPath(commentSelection.path),
                    startLine: commentSelection.startLine,
                    endLine: commentSelection.endLine,
                    selectedText: commentSelection.selectedText,
                    comment: comment.trim(),
                    createdAt: new Date().toISOString(),
                  })
                  setCommentSelection(null)
                  setComment('')
                }}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewToolbar({
  title,
  branchName,
  targetBranchName,
  viewOptions,
  additions,
  deletions,
  wrapLines,
  hunksCollapsed,
  fileTreeVisible,
  diffStyle,
  canRefresh,
  onRefresh,
  onToggleWrap,
  onToggleHunks,
  onToggleFileTree,
  onToggleDiffStyle,
  onCopyGitApplyCommand,
}: {
  title?: string
  branchName?: string
  targetBranchName?: string
  viewOptions?: FileChangesReviewViewOption[]
  additions: number
  deletions: number
  wrapLines: boolean
  hunksCollapsed: boolean
  fileTreeVisible: boolean
  diffStyle: 'unified' | 'split'
  canRefresh: boolean
  onRefresh?: () => void
  onToggleWrap: () => void
  onToggleHunks: () => void
  onToggleFileTree: () => void
  onToggleDiffStyle: () => void
  onCopyGitApplyCommand: () => void
}) {
  const { t } = useTranslation('chat')
  const [menuOpen, setMenuOpen] = useState(false)
  const sourceBranchLabel = branchName?.trim() || t('file_changes.branch_unknown')
  const targetBranchLabel = targetBranchName?.trim()
  const hasBranchContext = Boolean(branchName?.trim() || targetBranchName?.trim())
  const toolbarTitle =
    title?.trim() ||
    (hasBranchContext ? t('file_changes.branch_label') : t('file_changes.changes_label'))
  const canSwitchView = Boolean(viewOptions?.length)

  return (
    <div
      data-testid="file-changes-review-toolbar"
      className="flex min-h-11 shrink-0 flex-col justify-center gap-0.5 border-b border-border bg-background px-3 py-1"
    >
      <div className="flex min-h-8 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-text-primary">
          <div className="relative shrink-0">
            {canSwitchView ? (
              <>
                <button
                  type="button"
                  data-testid="review-view-switcher-button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(open => !open)}
                  className="flex h-8 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium text-text-primary transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span>{toolbarTitle}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                {menuOpen ? (
                  <div
                    data-testid="review-view-switcher-menu"
                    role="menu"
                    className="absolute left-0 top-full z-popover mt-1 w-40 overflow-hidden rounded-lg border border-border bg-background py-1 text-xs shadow-lg"
                  >
                    {viewOptions?.map(option => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option.active}
                        disabled={option.disabled}
                        data-testid="review-view-switcher-option"
                        onClick={() => {
                          setMenuOpen(false)
                          option.onSelect()
                        }}
                        className="flex h-8 w-full items-center gap-2 px-2.5 text-left font-medium text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {option.active ? <Check className="h-4 w-4 shrink-0" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <span className="shrink-0">{toolbarTitle}</span>
            )}
          </div>
          <span className="shrink-0 font-normal text-green-600">+{additions.toLocaleString()}</span>
          <span className="shrink-0 font-normal text-red-600">-{deletions.toLocaleString()}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarButton
            testId="refresh-review-diff-button"
            label={t('file_changes.actions.refresh')}
            onClick={onRefresh}
            disabled={!canRefresh}
            icon={RefreshCw}
          />
          <ToolbarButton
            testId="toggle-file-tree-button"
            label={
              fileTreeVisible
                ? t('file_changes.actions.hide_files')
                : t('file_changes.actions.show_files')
            }
            onClick={onToggleFileTree}
            pressed={fileTreeVisible}
            icon={fileTreeVisible ? EyeOff : Eye}
          />
          <ToolbarButton
            testId="toggle-diff-style-button"
            label={
              diffStyle === 'unified'
                ? t('file_changes.actions.show_split')
                : t('file_changes.actions.show_unified')
            }
            onClick={onToggleDiffStyle}
            pressed={diffStyle === 'split'}
            icon={diffStyle === 'unified' ? Columns2 : Rows3}
          />
          <ToolbarButton
            testId="toggle-line-wrap-button"
            label={t('file_changes.actions.toggle_wrap')}
            onClick={onToggleWrap}
            pressed={wrapLines}
            icon={WrapText}
          />
          <ToolbarButton
            testId="collapse-all-diff-hunks-button"
            label={
              hunksCollapsed
                ? t('file_changes.actions.expand_all_hunks')
                : t('file_changes.actions.collapse_all_hunks')
            }
            onClick={onToggleHunks}
            pressed={hunksCollapsed}
            icon={ListCollapse}
          />
          <ToolbarButton
            testId="copy-git-apply-command-button"
            label={t('file_changes.actions.copy_git_apply')}
            onClick={onCopyGitApplyCommand}
            icon={Copy}
          />
        </div>
      </div>
      {hasBranchContext ? (
        <div className="flex min-h-4 min-w-0 items-center gap-2.5 text-xs text-text-muted">
          <GitBranch className="hidden h-4 w-4 shrink-0 text-text-muted sm:block" />
          <span className="min-w-0 truncate">{sourceBranchLabel}</span>
          {targetBranchLabel ? (
            <>
              <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0 truncate">{targetBranchLabel}</span>
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-4 min-w-0 items-center gap-2 text-xs text-text-muted">
          <GitCompareArrows className="hidden h-4 w-4 shrink-0 text-text-muted sm:block" />
          <span className="min-w-0 truncate">{t('file_changes.all_files_diff_label')}</span>
        </div>
      )}
    </div>
  )
}

function ToolbarButton({
  testId,
  label,
  onClick,
  disabled,
  pressed,
  icon: Icon,
}: {
  testId: string
  label: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
  icon: typeof FileText
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40',
        pressed && 'border-border bg-muted text-text-primary'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

function AllDiffSections({
  sections,
  ariaLabel,
  wrapLines,
  diffLinesRef,
  diffStyle,
  hunksCollapsed,
  collapsedSections,
  expandFileLabel,
  collapseFileLabel,
  onToggleSectionCollapsed,
  reviewMode,
  pendingAction,
  onApplyPatch,
  onOpenSourceFile,
  canComment,
  commentSelection,
  onCommentSelectionChange,
  themeType,
}: {
  sections: DiffFileSection[]
  ariaLabel: string
  wrapLines: boolean
  diffLinesRef: RefObject<HTMLDivElement | null>
  diffStyle: 'unified' | 'split'
  hunksCollapsed: boolean
  collapsedSections: Set<string>
  expandFileLabel: string
  collapseFileLabel: string
  onToggleSectionCollapsed: (section: DiffFileSection, index: number) => void
  reviewMode?: ReviewMode
  pendingAction: string | null
  onApplyPatch: (action: GitPatchAction, patch: string, operationKey: string) => Promise<void>
  onOpenSourceFile?: (path: string, lineStart?: number, lineEnd?: number) => void
  canComment: boolean
  commentSelection: DiffCommentSelection | null
  onCommentSelectionChange: (selection: DiffCommentSelection | null) => void
  themeType: 'light' | 'dark'
}) {
  return (
    <section
      id="file-changes-review-diff"
      data-testid="file-changes-review-diff"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label={ariaLabel}
    >
      <div
        ref={diffLinesRef}
        data-testid="file-changes-review-diff-lines"
        data-wrap={wrapLines ? 'true' : 'false'}
        data-diff-style={diffStyle}
        className="scrollbar-soft pierre-diff-view min-h-0 flex-1 overflow-auto bg-background text-xs"
      >
        {sections.map((section, index) => {
          const sectionKey = getDiffSectionKey(section, index)
          const collapsed = collapsedSections.has(sectionKey)

          return (
            <FileDiffSection
              key={sectionKey}
              section={section}
              index={index}
              collapsed={collapsed}
              wrapLines={wrapLines}
              diffStyle={diffStyle}
              hunksCollapsed={hunksCollapsed}
              expandFileLabel={expandFileLabel}
              collapseFileLabel={collapseFileLabel}
              onToggle={() => onToggleSectionCollapsed(section, index)}
              reviewMode={reviewMode}
              pendingAction={pendingAction}
              onApplyPatch={onApplyPatch}
              onOpenSourceFile={onOpenSourceFile}
              canComment={canComment}
              commentSelection={commentSelection}
              onCommentSelectionChange={onCommentSelectionChange}
              themeType={themeType}
            />
          )
        })}
      </div>
    </section>
  )
}

function FileDiffSection({
  section,
  index,
  collapsed,
  wrapLines,
  diffStyle,
  hunksCollapsed,
  expandFileLabel,
  collapseFileLabel,
  onToggle,
  reviewMode,
  pendingAction,
  onApplyPatch,
  onOpenSourceFile,
  canComment,
  commentSelection,
  onCommentSelectionChange,
  themeType,
}: {
  section: DiffFileSection
  index: number
  collapsed: boolean
  wrapLines: boolean
  diffStyle: 'unified' | 'split'
  hunksCollapsed: boolean
  expandFileLabel: string
  collapseFileLabel: string
  onToggle: () => void
  reviewMode?: ReviewMode
  pendingAction: string | null
  onApplyPatch: (action: GitPatchAction, patch: string, operationKey: string) => Promise<void>
  onOpenSourceFile?: (path: string, lineStart?: number, lineEnd?: number) => void
  canComment: boolean
  commentSelection: DiffCommentSelection | null
  onCommentSelectionChange: (selection: DiffCommentSelection | null) => void
  themeType: 'light' | 'dark'
}) {
  const stats = useMemo(() => getDiffStats(section.lines), [section.lines])
  const patchChunks = useMemo(() => getPierrePatchChunks([section]), [section])
  const actionLabel = collapsed ? expandFileLabel : collapseFileLabel
  const filePatch = useMemo(() => ensureTrailingNewline(section.lines.join('\n')), [section.lines])
  const firstChangedLine = useMemo(() => getFirstChangedLine(section.lines), [section.lines])
  const fileActions = getReviewActions(reviewMode)

  return (
    <article
      data-testid="file-changes-review-file-diff-section"
      data-review-path={section.path}
      className="border-b border-border bg-background last:border-b-0"
    >
      <div className="sticky top-0 z-10 flex h-8 items-center gap-1 border-b border-border bg-background px-2 text-xs font-medium text-text-primary">
        <button
          type="button"
          data-testid="file-changes-review-file-diff-toggle"
          aria-expanded={!collapsed}
          aria-controls={getDiffSectionDomId(index)}
          title={actionLabel}
          onClick={onToggle}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
          )}
        </button>
        <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <button
          type="button"
          data-testid="file-changes-review-open-source-button"
          title={section.path}
          onClick={() => onOpenSourceFile?.(section.path, firstChangedLine, firstChangedLine)}
          className="min-w-0 flex-1 truncate rounded px-1 text-left hover:bg-muted hover:underline"
        >
          {section.path}
        </button>
        <span className="shrink-0 font-normal text-green-600">+{stats.additions}</span>
        <span className="shrink-0 font-normal text-red-600">-{stats.deletions}</span>
        {fileActions.map(action => (
          <ReviewPatchActionButton
            key={action}
            action={action}
            scope="file"
            disabled={Boolean(pendingAction)}
            pending={pendingAction === `file:${index}:${action}`}
            onClick={() => onApplyPatch(action, filePatch, `file:${index}:${action}`)}
          />
        ))}
      </div>
      {!collapsed ? (
        <div
          id={getDiffSectionDomId(index)}
          data-testid="file-changes-review-file-diff-body"
          data-theme={themeType}
        >
          {patchChunks.flatMap((patch, patchIndex) =>
            getHunkPatches(patch).map((hunkPatch, hunkIndex) => {
              const selectionKey = `${index}:${patchIndex}:${hunkIndex}`
              return (
                <div
                  key={`${wrapLines}:${diffStyle}:${hunksCollapsed}:${selectionKey}:${hunkPatch}`}
                >
                  {fileActions.length > 0 ? (
                    <div
                      data-testid="file-changes-review-hunk-actions"
                      className="flex min-h-8 items-center justify-end gap-1 border-b border-border bg-muted/40 px-2"
                    >
                      {fileActions.map(action => (
                        <ReviewPatchActionButton
                          key={action}
                          action={action}
                          scope="hunk"
                          disabled={Boolean(pendingAction)}
                          pending={pendingAction === `hunk:${selectionKey}:${action}`}
                          onClick={() =>
                            onApplyPatch(action, hunkPatch, `hunk:${selectionKey}:${action}`)
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  <PatchDiff
                    patch={hunkPatch}
                    disableWorkerPool
                    selectedLines={
                      commentSelection?.key === selectionKey ? commentSelection.range : null
                    }
                    options={{
                      collapsed: hunksCollapsed,
                      controlledSelection: true,
                      diffStyle,
                      disableFileHeader: true,
                      enableLineSelection: canComment,
                      lineHoverHighlight: 'both',
                      onLineNumberClick: (line: DiffLineEventBaseProps) =>
                        onOpenSourceFile?.(section.path, line.lineNumber, line.lineNumber),
                      onLineSelectionEnd: range => {
                        if (!range) {
                          onCommentSelectionChange(null)
                          return
                        }
                        const selected = getDiffSelection(hunkPatch, range)
                        if (!selected) return
                        onCommentSelectionChange({
                          key: selectionKey,
                          path: section.path,
                          range,
                          ...selected,
                        })
                      },
                      overflow: wrapLines ? 'wrap' : 'scroll',
                      stickyHeader: false,
                      themeType,
                      tokenizeMaxLength: 250_000,
                      tokenizeMaxLineLength: 2_000,
                      unsafeCSS: PIERRE_DIFF_CSS,
                    }}
                    metrics={{
                      diffHeaderHeight: 0,
                      hunkLineCount: 120,
                      lineHeight: 20,
                      paddingBottom: 0,
                      paddingTop: 0,
                      spacing: 0,
                    }}
                  />
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </article>
  )
}

function findSectionIndexForPath(sections: DiffFileSection[], path: string) {
  const exact = sections.findIndex(section => section.path === path)
  if (exact >= 0) return exact
  // Diff section paths and card file paths can differ by a leading directory
  // segment (e.g. workspace-relative vs repo-relative), so fall back to a
  // suffix match before giving up.
  return sections.findIndex(section => section.path.endsWith(path) || path.endsWith(section.path))
}

function getDiffSectionKey(section: DiffFileSection, index: number) {
  return `${index}:${section.oldPath ?? section.path}:${section.path}`
}

function getDiffSectionDomId(index: number) {
  return `file-changes-review-file-diff-${index}`
}

function getPierrePatchChunks(sections: DiffFileSection[]) {
  return sections.flatMap(section => {
    const chunks: string[][] = []

    section.lines.forEach(line => {
      if (line.startsWith('diff --git')) {
        chunks.push([line])
        return
      }
      chunks[chunks.length - 1]?.push(line)
    })

    return chunks.map(chunk => chunk.join('\n')).filter(Boolean)
  })
}

function getDiffStats(lines: string[]) {
  return lines.reduce(
    (stats, line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        stats.additions += 1
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        stats.deletions += 1
      }
      return stats
    },
    { additions: 0, deletions: 0 }
  )
}

function getSectionsDiffStats(sections: DiffFileSection[]) {
  return sections.reduce(
    (total, section) => {
      const stats = getDiffStats(section.lines)
      total.additions += stats.additions
      total.deletions += stats.deletions
      return total
    },
    { additions: 0, deletions: 0 }
  )
}

function isLargeReviewDiff(sections: DiffFileSection[]) {
  if (sections.length > LARGE_DIFF_FILE_COUNT_THRESHOLD) {
    return true
  }

  const lineCount = sections.reduce((total, section) => total + section.lines.length, 0)
  return lineCount > LARGE_DIFF_LINE_COUNT_THRESHOLD
}
