import {
  ChevronRight,
  Copy,
  FileText,
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

interface FileChangesReviewPanelProps {
  loading: boolean
  diff: string
  error?: string
  className?: string
  onRefresh?: () => void
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
  onRefresh,
}: FileChangesReviewPanelProps) {
  const { t } = useTranslation('chat')
  const [selection, setSelection] = useState({ diff: '', index: 0 })
  const [fileTreeVisible, setFileTreeVisible] = useState(true)
  const [wrapLines, setWrapLines] = useState(false)
  const [hunksCollapsed, setHunksCollapsed] = useState(false)

  const sections = useMemo(() => parseUnifiedDiff(diff), [diff])
  const selectedIndex =
    selection.diff === diff && selection.index < sections.length ? selection.index : 0
  const selectedSection = sections[selectedIndex] ?? sections[0]
  const treeNodes = useMemo(() => buildReviewTree(sections), [sections])

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

  return (
    <div
      data-testid="file-changes-review-panel"
      className={cn('min-h-0 flex-1 overflow-hidden p-3', className)}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-text-muted">{t('file_changes.loading_diff')}</p>
      ) : error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : sections.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">{t('file_changes.empty_diff')}</p>
      ) : (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <ReviewToolbar
            fileTreeVisible={fileTreeVisible}
            wrapLines={wrapLines}
            hunksCollapsed={hunksCollapsed}
            canRefresh={Boolean(onRefresh)}
            onRefresh={onRefresh}
            onToggleFileTree={() => setFileTreeVisible(visible => !visible)}
            onToggleWrap={() => setWrapLines(value => !value)}
            onToggleHunks={() => setHunksCollapsed(value => !value)}
            onCopyGitApplyCommand={copyGitApplyCommand}
          />
          <div
            data-testid="file-changes-review-content"
            className="flex min-h-0 flex-1 overflow-hidden"
          >
            <AllDiffSections
              sections={sections}
              selectedIndex={selectedIndex}
              ariaLabel={t('file_changes.all_files_diff_label')}
              wrapLines={wrapLines}
              hunksCollapsed={hunksCollapsed}
            />
            {fileTreeVisible && (
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

  return (
    <div
      data-testid="file-changes-review-toolbar"
      className="mb-3 flex min-h-9 shrink-0 items-center justify-end gap-1.5"
    >
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
      className="flex h-full min-h-0 w-[260px] shrink-0 flex-col border-l border-border bg-background"
      aria-label={t('file_changes.file_list_label')}
    >
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2">
          <Search className="h-4 w-4 text-text-muted" />
          <input
            data-testid="file-changes-review-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('file_changes.file_search_placeholder')}
            aria-label={t('file_changes.file_search_placeholder')}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
          />
        </div>
      </div>
      <div role="tablist" className="min-h-0 flex-1 overflow-auto p-2">
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
        'flex min-h-8 w-full items-center rounded-md pr-2 text-left font-mono text-xs text-text-secondary outline-none transition-colors hover:bg-muted hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary/40',
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
      <span className="ml-2 shrink-0 font-mono text-[11px]">
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
}: {
  sections: DiffFileSection[]
  selectedIndex: number
  ariaLabel: string
  wrapLines: boolean
  hunksCollapsed: boolean
}) {
  return (
    <section
      id="file-changes-review-diff"
      data-testid="file-changes-review-diff"
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
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
}: {
  section: DiffFileSection
  sectionIndex: number
  selected: boolean
  wrapLines: boolean
  hunksCollapsed: boolean
}) {
  const { additions, deletions } = getDiffStats(section.lines)
  const hunks = useMemo(() => parseDiffHunks(section), [section])

  return (
    <article
      id={getDiffSectionDomId(sectionIndex)}
      data-testid="file-changes-review-file-diff-section"
      className={cn(
        'scroll-mt-2 border-b border-border last:border-b-0',
        selected && 'ring-1 ring-inset ring-primary/40'
      )}
    >
      <header className="sticky top-0 z-10 flex min-h-10 items-center gap-2 border-b border-border bg-surface px-2.5 py-1.5 font-mono text-xs font-medium text-text-primary">
        <span className="min-w-0 flex-1 truncate" title={section.path}>
          {section.path}
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-green-600">+{additions}</span>{' '}
          <span className="text-red-600">-{deletions}</span>
        </span>
      </header>
      {hunks.map(hunk => (
        <section
          key={hunk.id}
          data-testid={hunk.header ? 'file-changes-review-hunk' : 'file-changes-review-metadata'}
        >
          {hunk.header ? (
            <div className="grid grid-cols-[4rem_4rem_minmax(0,1fr)] bg-surface text-text-secondary">
              <span />
              <span />
              <span className="min-w-0 px-2">{hunk.header}</span>
            </div>
          ) : null}
          {!hunksCollapsed
            ? buildDiffLineRows(hunk).map((row, index) => (
                <DiffLine key={`${hunk.id}:${index}:${row.line}`} row={row} wrapLines={wrapLines} />
              ))
            : null}
        </section>
      ))}
    </article>
  )
}

function getDiffSectionDomId(index: number) {
  return `file-changes-review-diff-section-${index}`
}

function DiffLine({ row, wrapLines }: { row: DiffLineRow; wrapLines: boolean }) {
  return (
    <div
      className={cn(
        'grid grid-cols-[4rem_4rem_minmax(0,1fr)]',
        row.line.startsWith('+') && !row.line.startsWith('+++') && 'bg-green-50 text-green-800',
        row.line.startsWith('-') && !row.line.startsWith('---') && 'bg-red-50 text-red-800',
        (row.line.startsWith('diff --git') ||
          row.line.startsWith('index ') ||
          row.line.startsWith('---') ||
          row.line.startsWith('+++')) &&
          'bg-surface text-text-secondary'
      )}
    >
      <span className="select-none border-r border-border/70 px-2 text-right text-text-muted">
        {row.oldLine ?? ''}
      </span>
      <span className="select-none border-r border-border/70 px-2 text-right text-text-muted">
        {row.newLine ?? ''}
      </span>
      <span
        className={cn(
          'min-w-0 px-2',
          wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
        )}
      >
        {row.line || ' '}
      </span>
    </div>
  )
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
