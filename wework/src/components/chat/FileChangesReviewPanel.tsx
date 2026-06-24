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
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  WrapText,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { parseUnifiedDiff, type DiffFileSection } from './parseUnifiedDiff'

const LARGE_DIFF_FILE_COUNT_THRESHOLD = 12
const LARGE_DIFF_LINE_COUNT_THRESHOLD = 700

interface FileChangesReviewPanelProps {
  loading: boolean
  diff: string
  error?: string
  className?: string
  reviewTitle?: string
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
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

interface ReviewTreeNode {
  id: string
  name: string
  path: string
  type: 'directory' | 'file'
  additions: number
  deletions: number
  sectionIndex?: number
  children: ReviewTreeNode[]
}

interface DiffHunk {
  id: string
  header?: string
  lines: string[]
}

interface DiffLineRow {
  line: string
  oldLine: number | null
  newLine: number | null
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
  viewOptions,
  onRefresh,
}: FileChangesReviewPanelProps) {
  const { t } = useTranslation('chat')
  const [selection, setSelection] = useState({ diff: '', index: 0 })
  const [fileTreeVisibility, setFileTreeVisibility] = useState({
    diff,
    defaultFileTreeVisible,
    visible: defaultFileTreeVisible,
  })
  const [wrapLines, setWrapLines] = useState(false)
  const [hunksCollapsed, setHunksCollapsed] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  const sections = useMemo(() => parseUnifiedDiff(diff), [diff])
  const selectedIndex =
    selection.diff === diff && selection.index < sections.length ? selection.index : 0
  const selectedSection = sections[selectedIndex] ?? sections[0]
  const treeNodes = useMemo(() => buildReviewTree(sections), [sections])
  const diffStats = useMemo(() => getSectionsDiffStats(sections), [sections])
  const isLargeDiff = useMemo(() => isLargeReviewDiff(sections), [sections])
  const displayedSections = isLargeDiff && selectedSection ? [selectedSection] : sections
  const fileTreeVisible =
    fileTreeVisibility.diff === diff &&
    fileTreeVisibility.defaultFileTreeVisible === defaultFileTreeVisible
      ? fileTreeVisibility.visible
      : defaultFileTreeVisible

  const selectSection = (index: number) => {
    setSelection({ diff, index })
    setHunksCollapsed(false)
    window.requestAnimationFrame(() => {
      document
        .getElementById(getDiffSectionDomId(index))
        ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    })
  }

  const copyGitApplyCommand = () => {
    const patch = diff.trimEnd()
    void navigator.clipboard?.writeText(`git apply <<'PATCH'\n${patch}\nPATCH`)
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
            fileTreeVisible={fileTreeVisible}
            wrapLines={wrapLines}
            hunksCollapsed={hunksCollapsed}
            canRefresh={Boolean(onRefresh)}
            onRefresh={onRefresh}
            onToggleFileTree={() =>
              setFileTreeVisibility({
                diff,
                defaultFileTreeVisible,
                visible: !fileTreeVisible,
              })
            }
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
                selectedIndex={isLargeDiff ? 0 : selectedIndex}
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
                nodes={treeNodes}
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
  fileTreeVisible,
  wrapLines,
  hunksCollapsed,
  canRefresh,
  onRefresh,
  onToggleFileTree,
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
  fileTreeVisible: boolean
  wrapLines: boolean
  hunksCollapsed: boolean
  canRefresh: boolean
  onRefresh?: () => void
  onToggleFileTree: () => void
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
      <div className="flex min-h-7 items-center gap-2">
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
                  className="flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium text-text-primary transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
                        className="flex h-7 w-full items-center gap-2 px-2.5 text-left font-medium text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
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
          <ToolbarButton
            testId="toggle-file-tree-button"
            label={
              fileTreeVisible
                ? t('file_changes.actions.hide_files')
                : t('file_changes.actions.show_files')
            }
            onClick={onToggleFileTree}
            pressed={fileTreeVisible}
            icon={fileTreeVisible ? PanelRightClose : PanelRightOpen}
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
        'flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40',
        pressed && 'border-border bg-muted text-text-primary'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function ReviewFileTree({
  nodes,
  selectedSection,
  sections,
  onSelectSection,
}: {
  nodes: ReviewTreeNode[]
  selectedSection?: DiffFileSection
  sections: DiffFileSection[]
  onSelectSection: (index: number) => void
}) {
  const { t } = useTranslation('chat')
  const [query, setQuery] = useState('')
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(new Set())
  const normalizedQuery = query.trim().toLowerCase()
  const visibleNodes = useMemo(
    () => filterTreeNodes(nodes, normalizedQuery),
    [nodes, normalizedQuery]
  )

  const toggleDirectory = (nodeId: string) => {
    setCollapsedDirectories(previous => {
      const next = new Set(previous)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }

  return (
    <aside
      data-testid="file-changes-review-file-tree"
      className="flex h-full min-h-0 w-[34%] min-w-[240px] max-w-[380px] shrink-0 flex-col border-l border-border bg-background"
      aria-label={t('file_changes.file_list_label')}
    >
      <div className="px-3 py-2.5">
        <div className="flex h-9 items-center gap-2 rounded-xl border border-border bg-background px-3">
          <Search className="h-4 w-4 text-text-muted" />
          <input
            data-testid="file-changes-review-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('file_changes.file_search_placeholder')}
            aria-label={t('file_changes.file_search_placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
          />
        </div>
      </div>
      <div role="tablist" className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {visibleNodes.length === 0 ? (
          <p className="px-2 py-3 text-sm text-text-muted">{t('file_changes.file_search_empty')}</p>
        ) : (
          visibleNodes.map(node => (
            <ReviewTreeNodeRow
              key={node.id}
              node={node}
              depth={0}
              selectedSection={selectedSection}
              sections={sections}
              collapsedDirectories={collapsedDirectories}
              searchActive={Boolean(normalizedQuery)}
              onToggleDirectory={toggleDirectory}
              onSelectSection={onSelectSection}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function ReviewTreeNodeRow({
  node,
  depth,
  selectedSection,
  sections,
  collapsedDirectories,
  searchActive,
  onToggleDirectory,
  onSelectSection,
}: {
  node: ReviewTreeNode
  depth: number
  selectedSection?: DiffFileSection
  sections: DiffFileSection[]
  collapsedDirectories: Set<string>
  searchActive: boolean
  onToggleDirectory: (nodeId: string) => void
  onSelectSection: (index: number) => void
}) {
  const collapsed = collapsedDirectories.has(node.id) && !searchActive
  const selected =
    node.type === 'file' &&
    node.sectionIndex !== undefined &&
    selectedSection === sections[node.sectionIndex]

  if (node.type === 'directory') {
    return (
      <div>
        <button
          type="button"
          data-testid="file-changes-review-directory-row"
          aria-expanded={!collapsed}
          onClick={() => onToggleDirectory(node.id)}
          className="flex h-8 w-full items-center rounded-md pr-2 text-left text-sm text-text-primary outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <TreeIndent depth={depth} />
          <span className="flex h-8 w-5 shrink-0 items-center justify-center">
            <ChevronRight
              className={cn(
                'h-4 w-4 text-text-secondary transition-transform',
                !collapsed && 'rotate-90'
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        {!collapsed
          ? node.children.map(child => (
              <ReviewTreeNodeRow
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedSection={selectedSection}
                sections={sections}
                collapsedDirectories={collapsedDirectories}
                searchActive={searchActive}
                onToggleDirectory={onToggleDirectory}
                onSelectSection={onSelectSection}
              />
            ))
          : null}
      </div>
    )
  }

  return (
    <button
      type="button"
      role="tab"
      data-testid="file-changes-review-file-option"
      aria-selected={selected}
      aria-label={node.path}
      aria-controls="file-changes-review-diff"
      onClick={() => {
        if (node.sectionIndex !== undefined) {
          onSelectSection(node.sectionIndex)
        }
      }}
      className={cn(
        'flex min-h-8 w-full items-center rounded-md pr-2 text-left font-sans text-sm text-text-muted outline-none transition-colors hover:bg-muted hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary/40',
        selected && 'bg-muted text-text-primary'
      )}
    >
      <TreeIndent depth={depth} />
      <span className="flex h-8 w-5 shrink-0 items-center justify-center">
        <FileText className="h-3.5 w-3.5 text-text-muted" />
      </span>
      <span className="min-w-0 flex-1 truncate" title={node.path}>
        {node.name}
      </span>
      <span className="ml-2 shrink-0 font-mono text-xs">
        <span className="text-green-600">+{node.additions}</span>{' '}
        <span className="text-red-600">-{node.deletions}</span>
      </span>
    </button>
  )
}

function TreeIndent({ depth }: { depth: number }) {
  if (depth <= 0) return null

  return (
    <span aria-hidden="true" className="flex h-full shrink-0">
      {Array.from({ length: depth }).map((_, index) => (
        <span
          key={index}
          className="relative h-full w-5 shrink-0 before:absolute before:inset-y-0 before:left-2 before:w-px before:bg-border"
        />
      ))}
    </span>
  )
}

function AllDiffSections({
  sections,
  selectedIndex,
  ariaLabel,
  wrapLines,
  hunksCollapsed,
  collapsedSections,
  expandFileLabel,
  collapseFileLabel,
  onToggleSectionCollapsed,
}: {
  sections: DiffFileSection[]
  selectedIndex: number
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
        className="min-h-0 flex-1 overflow-auto bg-background font-mono text-xs leading-5"
      >
        {sections.map((section, index) => (
          <DiffFileSectionView
            key={`${section.path}:${index}`}
            section={section}
            sectionIndex={index}
            selected={index === selectedIndex}
            wrapLines={wrapLines}
            hunksCollapsed={hunksCollapsed}
            collapsed={collapsedSections.has(getDiffSectionKey(section, index))}
            expandFileLabel={expandFileLabel}
            collapseFileLabel={collapseFileLabel}
            onToggleCollapsed={() => onToggleSectionCollapsed(section, index)}
          />
        ))}
      </div>
    </section>
  )
}

function DiffFileSectionView({
  section,
  sectionIndex,
  selected,
  wrapLines,
  hunksCollapsed,
  collapsed,
  expandFileLabel,
  collapseFileLabel,
  onToggleCollapsed,
}: {
  section: DiffFileSection
  sectionIndex: number
  selected: boolean
  wrapLines: boolean
  hunksCollapsed: boolean
  collapsed: boolean
  expandFileLabel: string
  collapseFileLabel: string
  onToggleCollapsed: () => void
}) {
  const { additions, deletions } = getDiffStats(section.lines)
  const hunks = useMemo(() => parseDiffHunks(section), [section])

  return (
    <article
      id={getDiffSectionDomId(sectionIndex)}
      data-testid="file-changes-review-file-diff-section"
      className={cn(
        'scroll-mt-0 border-b border-border last:border-b-0',
        wrapLines ? 'w-full' : 'w-max min-w-full',
        selected && 'ring-1 ring-inset ring-primary/25'
      )}
    >
      <header className="sticky top-0 z-10 flex min-h-9 items-center gap-2 border-b border-border bg-background px-2 py-1 font-mono text-sm font-semibold text-text-primary">
        <button
          type="button"
          data-testid="toggle-file-diff-section-button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
          aria-label={collapsed ? expandFileLabel : collapseFileLabel}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', !collapsed && 'rotate-90')} />
        </button>
        <span className="min-w-0 flex-1 truncate" title={section.path}>
          {compactPath(section.path)}
        </span>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-green-600">+{additions}</span>{' '}
          <span className="text-red-600">-{deletions}</span>
        </span>
      </header>
      {!collapsed && !hunksCollapsed ? (
        <div>
          <div className={cn(wrapLines ? 'min-w-full' : 'w-max min-w-full')}>
            {hunks
              .filter(hunk => hunk.header)
              .map(hunk => (
                <section
                  key={hunk.id}
                  data-testid={
                    hunk.header ? 'file-changes-review-hunk' : 'file-changes-review-metadata'
                  }
                >
                  {buildDiffLineRows(hunk).map((row, index) => (
                    <DiffLine
                      key={`${hunk.id}:${index}:${row.line}`}
                      row={row}
                      wrapLines={wrapLines}
                    />
                  ))}
                </section>
              ))}
          </div>
        </div>
      ) : null}
    </article>
  )
}

function getDiffSectionKey(section: DiffFileSection, index: number) {
  return `${section.path}:${index}`
}

function getDiffSectionDomId(index: number) {
  return `file-changes-review-diff-section-${index}`
}

function DiffLine({ row, wrapLines }: { row: DiffLineRow; wrapLines: boolean }) {
  return (
    <div
      className={cn(
        wrapLines
          ? 'grid w-full grid-cols-[3rem_minmax(0,1fr)]'
          : 'grid w-max min-w-full grid-cols-[3rem_max-content]',
        row.line.startsWith('+') && 'bg-green-50 text-green-800',
        row.line.startsWith('-') && 'bg-red-50 text-red-800'
      )}
    >
      <span className="select-none border-r border-border/70 px-2 text-right text-text-muted">
        {getDisplayLineNumber(row)}
      </span>
      <span
        className={cn(
          'min-w-0 px-2',
          wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
        )}
      >
        {formatDiffLineContent(row.line)}
      </span>
    </div>
  )
}

function getDisplayLineNumber(row: DiffLineRow) {
  return row.newLine ?? row.oldLine ?? ''
}

function formatDiffLineContent(line: string) {
  if (!line) return ' '
  if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
    return line.slice(1) || ' '
  }
  return line
}

function compactPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) {
    return path
  }
  return `...${parts.slice(-2).join('/')}`
}

function buildReviewTree(sections: DiffFileSection[]): ReviewTreeNode[] {
  const root: ReviewTreeNode[] = []

  sections.forEach((section, sectionIndex) => {
    const parts = section.path.split('/').filter(Boolean)
    const { additions, deletions } = getDiffStats(section.lines)
    let siblings = root
    let currentPath = ''

    parts.forEach((part, partIndex) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isFile = partIndex === parts.length - 1
      let node = siblings.find(
        child => child.name === part && child.type === (isFile ? 'file' : 'directory')
      )

      if (!node) {
        node = {
          id: isFile ? section.path : currentPath,
          name: part,
          path: isFile ? section.path : currentPath,
          type: isFile ? 'file' : 'directory',
          additions: isFile ? additions : 0,
          deletions: isFile ? deletions : 0,
          sectionIndex: isFile ? sectionIndex : undefined,
          children: [],
        }
        siblings.push(node)
        siblings.sort(compareTreeNodes)
      }

      if (isFile) {
        node.additions = additions
        node.deletions = deletions
        node.sectionIndex = sectionIndex
      }

      siblings = node.children
    })
  })

  return root
}

function compareTreeNodes(first: ReviewTreeNode, second: ReviewTreeNode) {
  if (first.type !== second.type) {
    return first.type === 'directory' ? -1 : 1
  }
  return first.name.localeCompare(second.name)
}

function filterTreeNodes(nodes: ReviewTreeNode[], normalizedQuery: string): ReviewTreeNode[] {
  if (!normalizedQuery) return nodes

  return nodes.flatMap(node => {
    const matches = node.path.toLowerCase().includes(normalizedQuery)
    if (node.type === 'file') {
      return matches ? [node] : []
    }

    const children = filterTreeNodes(node.children, normalizedQuery)
    if (matches || children.length > 0) {
      return [{ ...node, children }]
    }
    return []
  })
}

function parseDiffHunks(section: DiffFileSection): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk = {
    id: `${section.path}:metadata`,
    lines: [],
  }
  let hunkIndex = 0

  section.lines.forEach(line => {
    if (line.startsWith('@@')) {
      if (current.header || current.lines.length > 0) {
        hunks.push(current)
      }
      current = {
        id: `${section.path}:hunk:${hunkIndex}`,
        header: line,
        lines: [],
      }
      hunkIndex += 1
      return
    }

    current.lines.push(line)
  })

  if (current.header || current.lines.length > 0) {
    hunks.push(current)
  }

  return hunks
}

function buildDiffLineRows(hunk: DiffHunk): DiffLineRow[] {
  const starts = parseHunkStarts(hunk.header)
  let oldLine = starts.oldLine
  let newLine = starts.newLine

  return hunk.lines.map(line => {
    if (!hunk.header) {
      return { line, oldLine: null, newLine: null }
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const row = { line, oldLine: null, newLine }
      newLine += 1
      return row
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const row = { line, oldLine, newLine: null }
      oldLine += 1
      return row
    }
    if (line.startsWith(' ')) {
      const row = { line, oldLine, newLine }
      oldLine += 1
      newLine += 1
      return row
    }

    return { line, oldLine: null, newLine: null }
  })
}

function parseHunkStarts(header?: string) {
  const match = header?.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  return {
    oldLine: match ? Number(match[1]) : 0,
    newLine: match ? Number(match[2]) : 0,
  }
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
