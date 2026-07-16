import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  GitCompareArrows,
  ListCollapse,
  RefreshCw,
  Search,
  WrapText,
} from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { parseUnifiedDiff, type DiffFileSection } from './parseUnifiedDiff'

const LARGE_DIFF_FILE_COUNT_THRESHOLD = 12
const LARGE_DIFF_LINE_COUNT_THRESHOLD = 700
const PIERRE_DIFF_CSS = `
  :host, pre, code {
    font-family: var(--font-code);
    font-size: var(--text-code);
    line-height: 1.8;
  }
  [data-diffs-file-header], [data-diffs-header] {
    min-height: 36px;
    border-bottom: 1px solid rgb(224 224 224);
    background: rgb(255 255 255);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  [data-diffs-line-addition], [data-diffs-line-added] {
    background: rgb(240 253 244);
  }
  [data-diffs-line-deletion], [data-diffs-line-deleted] {
    background: rgb(254 242 242);
  }
`
const PIERRE_FILE_TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-bg-muted-override: rgb(247 247 248);
    --trees-fg-override: rgb(102 102 102);
    --trees-fg-muted-override: rgb(140 140 140);
    --trees-border-color-override: rgb(224 224 224);
    --trees-selected-bg-override: rgb(247 247 248);
    --trees-selected-fg-override: rgb(26 26 26);
    --trees-selected-focused-border-color-override: rgb(20 184 166);
    --trees-focus-ring-color-override: rgb(20 184 166 / 0.35);
    --trees-focus-ring-width-override: 1px;
    --trees-focus-ring-offset-override: 0px;
    --trees-gap-override: 2px;
    --trees-level-gap-override: 6px;
    --trees-item-padding-x-override: 4px;
    --trees-item-margin-x-override: 0px;
    --trees-padding-inline-override: 4px;
    --trees-indent-guide-bg-override: rgb(224 224 224);
    --trees-scrollbar-thumb-override: rgb(224 224 224);
    --trees-search-bg-override: rgb(255 255 255);
    --trees-search-fg-override: rgb(26 26 26);
    --trees-status-added-override: rgb(57 151 75);
    --trees-status-modified-override: rgb(57 151 75);
    --trees-status-renamed-override: rgb(57 151 75);
    --trees-status-untracked-override: rgb(57 151 75);
    --trees-status-deleted-override: rgb(210 57 57);
    --trees-git-added-color-override: rgb(57 151 75);
    --trees-git-modified-color-override: rgb(57 151 75);
    --trees-git-renamed-color-override: rgb(57 151 75);
    --trees-git-untracked-color-override: rgb(57 151 75);
    --trees-git-deleted-color-override: rgb(210 57 57);
    --trees-file-icon-color: rgb(140 140 140);
    --trees-file-icon-color-default: rgb(140 140 140);
    --trees-icon-blue: rgb(140 140 140);
    --trees-icon-cyan: rgb(140 140 140);
    --trees-icon-green: rgb(140 140 140);
    --trees-icon-indigo: rgb(140 140 140);
    --trees-icon-mauve: rgb(140 140 140);
    --trees-icon-orange: rgb(140 140 140);
    --trees-icon-pink: rgb(140 140 140);
    --trees-icon-purple: rgb(140 140 140);
    --trees-icon-red: rgb(140 140 140);
    --trees-icon-teal: rgb(140 140 140);
    --trees-icon-vermilion: rgb(140 140 140);
    --trees-icon-yellow: rgb(140 140 140);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    color: rgb(102 102 102);
    background: transparent !important;
  }
  button[data-type='item'] {
    box-sizing: border-box;
    border-radius: 6px;
    color: rgb(102 102 102);
    background: transparent;
    background-clip: padding-box;
  }
  button[data-type='item']:hover {
    color: rgb(26 26 26);
    background: rgb(247 247 248);
    box-shadow:
      0 0 0 1px rgb(255 255 255),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected] {
    color: rgb(26 26 26);
    background: rgb(247 247 248) !important;
    box-shadow:
      0 0 0 1px rgb(255 255 255),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected='true']:has(+ [data-item-selected='true']),
  button[data-type='item'][data-item-selected='true'] + [data-item-selected='true'] {
    border-radius: 6px !important;
  }
  button[data-type='item'][data-item-focused='true']::before,
  button[data-type='item']:focus-visible::before {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--trees-focus-ring-color);
  }
  button[data-type='item'][data-item-focused='true'][data-item-selected='true']::before,
  button[data-type='item'][data-item-selected='true']:focus-visible::before {
    box-shadow: inset 0 0 0 1px var(--trees-selected-focused-border-color);
  }
  input {
    background: rgb(255 255 255);
    color: rgb(26 26 26);
    border-color: rgb(224 224 224);
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
  viewOptions?: FileChangesReviewViewOption[]
  onRefresh?: () => void
}

export interface FileChangesReviewViewOption {
  id: string
  label: string
  active: boolean
  disabled?: boolean
  onSelect: () => void
}

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
  viewOptions,
  onRefresh,
}: FileChangesReviewPanelProps) {
  const { t } = useTranslation('chat')
  const [selection, setSelection] = useState<{
    diff: string
    focusFilePath?: string
    index: number
  }>({ diff: '', index: 0 })
  const [wrapLines, setWrapLines] = useState(false)
  const [hunksCollapsed, setHunksCollapsed] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  const sections = useMemo(() => parseUnifiedDiff(diff), [diff])
  const focusSectionIndex = useMemo(
    () => (focusFilePath ? findSectionIndexForPath(sections, focusFilePath) : -1),
    [focusFilePath, sections]
  )
  const defaultSelectedIndex = focusSectionIndex >= 0 ? focusSectionIndex : 0
  const selectedIndex =
    selection.diff === diff &&
    selection.focusFilePath === focusFilePath &&
    selection.index < sections.length
      ? selection.index
      : defaultSelectedIndex
  const selectedSection = sections[selectedIndex] ?? sections[0]
  const diffStats = useMemo(() => getSectionsDiffStats(sections), [sections])
  const isLargeDiff = useMemo(() => isLargeReviewDiff(sections), [sections])
  const displayedSections = isLargeDiff && selectedSection ? [selectedSection] : sections
  const fileTreeVisible = defaultFileTreeVisible

  const selectSection = (index: number) => {
    setSelection({ diff, focusFilePath, index })
    setHunksCollapsed(false)
  }

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
            canRefresh={Boolean(onRefresh)}
            onRefresh={onRefresh}
            onToggleWrap={() => setWrapLines(value => !value)}
            onToggleHunks={() => setHunksCollapsed(value => !value)}
            onCopyGitApplyCommand={copyGitApplyCommand}
          />
          {isLargeDiff ? (
            <p className="shrink-0 border-b border-border bg-background px-6 py-2 text-sm text-text-muted">
              {t('file_changes.large_diff_single_file_notice')}
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
                hunksCollapsed={hunksCollapsed}
                collapsedSections={collapsedSections}
                expandFileLabel={t('file_changes.actions.expand_file_diff')}
                collapseFileLabel={t('file_changes.actions.collapse_file_diff')}
                onToggleSectionCollapsed={toggleSectionCollapsed}
              />
            )}
            {sections.length > 0 && fileTreeVisible && (
              <ReviewFileTree
                selectedSection={selectedSection}
                sections={sections}
                onSelectSection={selectSection}
              />
            )}
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
  canRefresh,
  onRefresh,
  onToggleWrap,
  onToggleHunks,
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
  canRefresh: boolean
  onRefresh?: () => void
  onToggleWrap: () => void
  onToggleHunks: () => void
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

function ReviewFileTree({
  selectedSection,
  sections,
  onSelectSection,
}: {
  selectedSection?: DiffFileSection
  sections: DiffFileSection[]
  onSelectSection: (index: number) => void
}) {
  const { t } = useTranslation('chat')
  const [query, setQuery] = useState('')
  const paths = useMemo(() => sections.map(section => section.path), [sections])
  const statusByPath = useMemo(
    () =>
      sections.map(section => ({
        path: section.path,
        status: getPierreGitStatus(section),
      })),
    [sections]
  )

  return (
    <aside
      data-testid="file-changes-review-file-tree"
      className="flex h-full min-h-0 w-[34%] min-w-[240px] max-w-[380px] shrink-0 flex-col border-l border-border bg-background"
      aria-label={t('file_changes.file_list_label')}
    >
      <div className="px-3 pb-1.5 pt-2">
        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            data-testid="file-changes-review-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('file_changes.file_search_placeholder')}
            aria-label={t('file_changes.file_search_placeholder')}
            className="min-w-0 flex-1 bg-transparent text-xs leading-4 outline-none placeholder:text-text-muted"
          />
        </div>
      </div>
      <div className="scrollbar-soft min-h-0 flex-1 overflow-hidden pl-1 pr-2 pb-3">
        <PierreReviewFileTree
          key={paths.join('\n')}
          paths={paths}
          query={query}
          gitStatus={statusByPath}
          selectedPath={selectedSection?.path}
          onSelectPath={path => {
            const index = sections.findIndex(section => section.path === path)
            if (index >= 0) {
              onSelectSection(index)
            }
          }}
        />
      </div>
    </aside>
  )
}

function PierreReviewFileTree({
  paths,
  query,
  gitStatus,
  selectedPath,
  onSelectPath,
}: {
  paths: string[]
  query: string
  gitStatus: { path: string; status: 'added' | 'deleted' | 'modified' | 'renamed' }[]
  selectedPath?: string
  onSelectPath: (path: string) => void
}) {
  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: true,
    gitStatus,
    icons: { set: 'complete', colored: false },
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 28,
    onSelectionChange: selectedPaths => {
      const nextPath = selectedPaths[0]
      if (nextPath) {
        onSelectPath(nextPath)
      }
    },
    paths,
    search: false,
    unsafeCSS: PIERRE_FILE_TREE_CSS,
  })

  useEffect(() => {
    model.setSearch(query.trim() || null)
  }, [model, query])

  useEffect(() => {
    if (!selectedPath) return
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' })
  }, [model, selectedPath])

  return (
    <FileTree
      data-testid="pierre-file-tree"
      model={model}
      className="block h-full min-h-0 w-full"
      style={
        {
          '--trees-border-color-override': 'rgb(var(--color-border))',
          '--trees-fg-override': 'rgb(var(--color-text-secondary))',
          '--trees-selected-bg-override': 'rgb(var(--color-bg-surface))',
        } as CSSProperties
      }
    />
  )
}

function AllDiffSections({
  sections,
  ariaLabel,
  wrapLines,
  hunksCollapsed,
  collapsedSections,
  expandFileLabel,
  collapseFileLabel,
  onToggleSectionCollapsed,
}: {
  sections: DiffFileSection[]
  ariaLabel: string
  wrapLines: boolean
  hunksCollapsed: boolean
  collapsedSections: Set<string>
  expandFileLabel: string
  collapseFileLabel: string
  onToggleSectionCollapsed: (section: DiffFileSection, index: number) => void
}) {
  return (
    <section
      id="file-changes-review-diff"
      data-testid="file-changes-review-diff"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label={ariaLabel}
    >
      <div
        data-testid="file-changes-review-diff-lines"
        data-wrap={wrapLines ? 'true' : 'false'}
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
              hunksCollapsed={hunksCollapsed}
              expandFileLabel={expandFileLabel}
              collapseFileLabel={collapseFileLabel}
              onToggle={() => onToggleSectionCollapsed(section, index)}
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
  hunksCollapsed,
  expandFileLabel,
  collapseFileLabel,
  onToggle,
}: {
  section: DiffFileSection
  index: number
  collapsed: boolean
  wrapLines: boolean
  hunksCollapsed: boolean
  expandFileLabel: string
  collapseFileLabel: string
  onToggle: () => void
}) {
  const stats = useMemo(() => getDiffStats(section.lines), [section.lines])
  const patchChunks = useMemo(() => getPierrePatchChunks([section]), [section])
  const actionLabel = collapsed ? expandFileLabel : collapseFileLabel

  return (
    <article
      data-testid="file-changes-review-file-diff-section"
      className="border-b border-border bg-background last:border-b-0"
    >
      <button
        type="button"
        data-testid="file-changes-review-file-diff-toggle"
        aria-expanded={!collapsed}
        aria-controls={getDiffSectionDomId(index)}
        title={actionLabel}
        onClick={onToggle}
        className="sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-b border-border bg-background px-3 text-left text-xs font-medium text-text-primary hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
        <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate">{section.path}</span>
        <span className="shrink-0 font-normal text-green-600">+{stats.additions}</span>
        <span className="shrink-0 font-normal text-red-600">-{stats.deletions}</span>
      </button>
      {!collapsed ? (
        <div id={getDiffSectionDomId(index)} data-testid="file-changes-review-file-diff-body">
          {patchChunks.map((patch, patchIndex) => (
            <PatchDiff
              key={`${wrapLines}:${hunksCollapsed}:${patchIndex}:${patch}`}
              patch={patch}
              disableWorkerPool
              options={{
                collapsed: hunksCollapsed,
                diffStyle: 'unified',
                disableFileHeader: true,
                overflow: wrapLines ? 'wrap' : 'scroll',
                stickyHeader: false,
                themeType: 'light',
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
          ))}
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

function getPierreGitStatus(section: DiffFileSection) {
  if (section.lines.some(line => line.startsWith('new file mode'))) {
    return 'added' as const
  }
  if (section.lines.some(line => line.startsWith('deleted file mode'))) {
    return 'deleted' as const
  }
  if (section.oldPath && section.oldPath !== section.path) {
    return 'renamed' as const
  }
  return 'modified' as const
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
