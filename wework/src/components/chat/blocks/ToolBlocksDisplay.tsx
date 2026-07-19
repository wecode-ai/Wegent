import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, TransitionEvent } from 'react'
import {
  Archive,
  ChevronDown,
  FileText,
  LoaderCircle,
  MessageCircle,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RequestUserInputResponse } from '@/types/api'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import {
  isAnsweredRequestUserInputBlock,
  isHiddenRequestUserInputBlock,
  isRequestUserInputBlock,
  type RequestUserInputBlock,
} from '../requestUserInputMessages'
import { ToolBlockItem, type FileEditDuration } from './ToolBlockItem'
import {
  RequestUserInputCard,
  RequestUserInputSummary,
  type RequestUserInputPayload,
} from '../RequestUserInputCard'
import type { AssistantPlanOpenRequest } from '../AssistantPlanCard'
import {
  buildProcessingDisplayRows,
  getToolActivityFilePaths,
  getToolActivityGroupKind,
  getToolActivityKind,
  getToolActivitySearchItem,
  isCommandToolName,
  isContextCompactionToolBlock,
  isGuidanceActivityGroup,
  isWebSearchActivityGroup,
  type ProcessingDisplayRow,
} from './toolBlockActivity'
import { usePersistentProcessingExpansion } from './processingExpansionState'
import { WebSearchActivityRows } from './WebSearchSources'
import { getWebSearchActivityItems } from './webSearchActivity'
import { getDurationText, getWholeSecondsDurationText } from './processingDuration'
import { getFileInputPaths, isFileEditToolName } from './toolBlockKinds'

const EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS = new Set<string>()
type ProcessingDisplayItem =
  | ProcessingDisplayRow
  | {
      type: 'request_user_input'
      id: string
      block: RequestUserInputBlock
    }

interface ToolBlocksDisplayProps {
  blocks: ProcessingBlock[]
  isStreaming: boolean
  // Wall-clock epoch ms when the turn started (the assistant turn's
  // created_at). Used as the duration anchor so the elapsed time survives a
  // page refresh: after a refresh the in-progress blocks are re-streamed with
  // fresh client timestamps, so anchoring to the first block would restart the
  // timer from the refresh moment.
  startedAt?: number
  forceExpanded?: boolean
  processingPhase?: 'live' | 'intermediate' | 'final'
  showInterToolThinking?: boolean
  showSummary?: boolean
  stateKey?: string
  onOpenWorkspaceFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  onLoadFullTranscript?: () => Promise<void> | void
  loadingFullTranscript?: boolean
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
}

export function ToolBlocksDisplay({
  blocks,
  isStreaming,
  startedAt,
  forceExpanded = false,
  processingPhase = 'live',
  showInterToolThinking = false,
  showSummary = true,
  stateKey,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onLoadFullTranscript,
  loadingFullTranscript = false,
  hideRequestUserInputBlocks = false,
  hiddenRequestUserInputIds,
}: ToolBlocksDisplayProps) {
  const { t } = useTranslation('chat')
  const hasRunningBlock = blocks.some(b => b.status !== 'done' && b.status !== 'error')
  const isRunning =
    (isStreaming && (processingPhase === 'live' || showInterToolThinking)) || hasRunningBlock
  const [userExpanded, setUserExpanded] = usePersistentProcessingExpansion(
    stateKey ? `${stateKey}:processing` : undefined
  )
  const [livePreviewCollapsed, setLivePreviewCollapsed] = useState(false)
  const [mountedAt] = useState(() => Date.now())
  const turnStartedAt = startedAt ?? mountedAt
  const [hasRenderedRunning, setHasRenderedRunning] = useState(isRunning)
  const [completedAt, setCompletedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [isRunning])

  useEffect(() => {
    if (isRunning) {
      if (hasRenderedRunning && completedAt === null) return
      const timer = window.setTimeout(() => {
        setHasRenderedRunning(true)
        setCompletedAt(null)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    if (hasRenderedRunning && completedAt === null) {
      const timer = window.setTimeout(() => setCompletedAt(Date.now()), 0)
      return () => window.clearTimeout(timer)
    }
  }, [completedAt, hasRenderedRunning, isRunning])

  const duration = getDurationText(blocks, turnStartedAt, now, completedAt, isRunning)
  const displayItems = useMemo(() => {
    const hiddenIds = hiddenRequestUserInputIds ?? EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS
    const items: ProcessingDisplayItem[] = []
    let pendingRegularBlocks: ProcessingBlock[] = []

    const flushRegularBlocks = () => {
      if (pendingRegularBlocks.length === 0) return
      items.push(
        ...buildProcessingDisplayRows(pendingRegularBlocks, { groupCompletedTools: false })
      )
      pendingRegularBlocks = []
    }

    blocks.forEach(block => {
      if (!isRequestUserInputBlock(block)) {
        pendingRegularBlocks.push(block)
        return
      }

      const isUnansweredRequest =
        block.status !== 'error' && !isAnsweredRequestUserInputBlock(block)
      const shouldHidePendingRequest =
        isUnansweredRequest &&
        (hideRequestUserInputBlocks || isHiddenRequestUserInputBlock(block, hiddenIds))
      if (shouldHidePendingRequest) return

      flushRegularBlocks()
      items.push({
        type: 'request_user_input',
        id: block.id,
        block,
      })
    })

    flushRegularBlocks()
    return items
  }, [blocks, hiddenRequestUserInputIds, hideRequestUserInputBlocks])
  const rows = useMemo(
    () =>
      displayItems.filter(
        (item): item is ProcessingDisplayRow => item.type !== 'request_user_input'
      ),
    [displayItems]
  )
  const fileEditDurations = useMemo(() => getFileEditDurations(blocks), [blocks])
  const hasPlanResponse = blocks.some(block => block.type === 'plan' && block.content.trim())
  const hasRequestUserInput = displayItems.some(item => item.type === 'request_user_input')
  const hasActiveContextCompaction = blocks.some(
    block =>
      isContextCompactionToolBlock(block) && block.status !== 'done' && block.status !== 'error'
  )
  const isLockedOpen =
    forceExpanded ||
    !showSummary ||
    hasPlanResponse ||
    hasRequestUserInput ||
    hasActiveContextCompaction
  const hasRunningToolActivity = rows.some(row =>
    row.type === 'activity_group'
      ? row.blocks.some(block => block.status !== 'done' && block.status !== 'error')
      : (row.block.type === 'tool' || row.block.type === 'file_changes') &&
        row.block.status !== 'done' &&
        row.block.status !== 'error'
  )
  const hasClosedToolSegment = processingPhase !== 'live'
  const usesUnifiedToolList = showSummary && !isLockedOpen
  const expanded = isLockedOpen || (userExpanded && !usesUnifiedToolList)
  const canToggleSummary =
    showSummary && !isLockedOpen && !hasRunningToolActivity && rows.length > 0
  const hasLivePreview =
    isRunning &&
    (!hasClosedToolSegment || hasRunningToolActivity || showInterToolThinking) &&
    !expanded &&
    rows.length > 0
  const previewRows = useMemo(
    () =>
      !expanded &&
      (hasRunningToolActivity ||
        (hasLivePreview && !livePreviewCollapsed) ||
        (usesUnifiedToolList && userExpanded))
        ? rows
        : [],
    [
      expanded,
      hasLivePreview,
      hasRunningToolActivity,
      livePreviewCollapsed,
      rows,
      userExpanded,
      usesUnifiedToolList,
    ]
  )
  const summaryExpanded = expanded || previewRows.length > 0
  const toggleSummary = () => {
    if (hasLivePreview) {
      setLivePreviewCollapsed(value => !value)
      return
    }
    setUserExpanded(value => !value)
  }
  const hasToolActivity = rows.some(
    row =>
      row.type === 'activity_group' ||
      row.block.type === 'tool' ||
      row.block.type === 'file_changes'
  )
  const activityStats = countProcessingActivityKinds(rows)
  const hasOnlyEditActivity =
    activityStats.edit > 0 &&
    activityStats.command === 0 &&
    activityStats.file === 0 &&
    activityStats.search === 0 &&
    activityStats.other === 0
  const toolCallCount = countProcessingToolCalls(activityStats)
  const summaryTitle = hasToolActivity
    ? hasOnlyEditActivity
      ? t('tool_activity.edit_summary', { count: activityStats.edit })
      : activityStats.edit > 0
        ? t('tool_activity.mixed_summary', {
            count: activityStats.edit,
            toolSummary: t('tool_activity.summary', { count: toolCallCount }),
          })
        : t('tool_activity.summary', { count: toolCallCount })
    : t('thinking.completed')
  const summaryDuration = hasToolActivity
    ? getWholeSecondsDurationText(blocks, turnStartedAt, now, completedAt, isRunning)
    : duration.replace(/^已处理\s*/, '')
  const processingContent = useMemo(
    () =>
      expanded ? (
        <div className="flex min-w-0 flex-col gap-3 pt-0.5">
          {displayItems.map(item => {
            if (item.type === 'request_user_input') {
              return isAnsweredRequestUserInputBlock(item.block) ? (
                <RequestUserInputSummary key={item.id} payload={item.block.renderPayload} />
              ) : (
                <RequestUserInputCard
                  key={item.id}
                  payload={item.block.renderPayload}
                  disabled={item.block.status === 'error'}
                  onSubmit={onRequestUserInputSubmit}
                  onIgnore={() => onRequestUserInputIgnore?.(item.block.renderPayload)}
                />
              )
            }

            return item.type === 'activity_group' ? (
              <ToolActivityGroup
                key={item.id}
                row={item}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            ) : isContextCompactionToolBlock(item.block) ? (
              <ContextCompactionIndicator key={item.id} block={item.block} />
            ) : (
              <ToolBlockItem
                key={item.id}
                block={item.block}
                stateKey={stateKey ? `${stateKey}:${item.id}` : undefined}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onOpenAssistantPlan={onOpenAssistantPlan}
                onLoadFullTranscript={onLoadFullTranscript}
                loadingFullTranscript={loadingFullTranscript}
                fileEditDurations={fileEditDurations}
              />
            )
          })}
        </div>
      ) : null,
    [
      displayItems,
      expanded,
      onOpenWorkspaceFile,
      onOpenAssistantPlan,
      onLoadFullTranscript,
      loadingFullTranscript,
      fileEditDurations,
      onRequestUserInputIgnore,
      onRequestUserInputSubmit,
      stateKey,
    ]
  )

  if (blocks.length === 0 && !isStreaming) return null

  const processingBody = (
    <>
      {showSummary ? (
        <ProcessingSummaryHeader
          canToggle={canToggleSummary}
          duration={summaryDuration}
          durationAriaLabel={duration}
          expanded={summaryExpanded}
          isRunning={isRunning && !hasClosedToolSegment}
          rows={rows}
          onToggle={toggleSummary}
          title={summaryTitle}
          labels={{
            command: t('tool_activity.command'),
            file: t('tool_activity.file'),
            search: t('tool_activity.search'),
            edit: t('tool_activity.edit'),
            other: t('tool_activity.other'),
          }}
        />
      ) : null}
      <CollapsibleProcessingContent expanded={expanded}>
        {processingContent}
      </CollapsibleProcessingContent>
      {previewRows.length > 0 ? (
        <LiveProcessingPreview
          rows={previewRows}
          showThinking={
            isStreaming &&
            hasToolActivity &&
            !hasRunningToolActivity &&
            (processingPhase === 'live' || showInterToolThinking)
          }
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          fileEditDurations={fileEditDurations}
        />
      ) : null}
    </>
  )
  return <div className="mb-3 min-w-0 w-full">{processingBody}</div>
}

type ToolActivityLabels = {
  command: string
  file: string
  search: string
  edit: string
  other: string
}

function ProcessingSummaryHeader({
  canToggle,
  duration,
  durationAriaLabel,
  expanded,
  isRunning,
  rows,
  onToggle,
  title,
  labels,
}: {
  canToggle: boolean
  duration: string
  durationAriaLabel: string
  expanded: boolean
  isRunning: boolean
  rows: ProcessingDisplayRow[]
  onToggle: () => void
  title: string
  labels: ToolActivityLabels
}) {
  const titleContent = (
    <>
      {rows.length > 0 ? (
        <ChevronDown
          data-testid="processing-summary-chevron"
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
          strokeWidth={2}
          aria-hidden="true"
        />
      ) : null}
      <span className="font-medium text-text-secondary">{title}</span>
    </>
  )

  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 text-xs text-text-muted"
      data-testid="processing-summary-header"
    >
      {canToggle ? (
        <button
          type="button"
          data-testid="processing-summary-toggle"
          className="inline-flex shrink-0 items-center gap-1 hover:text-text-primary"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={durationAriaLabel ? `${title} ${durationAriaLabel}` : `${title} 已处理`}
        >
          {titleContent}
        </button>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1">{titleContent}</span>
      )}
      <ToolActivityStats rows={rows} labels={labels} />
      {isRunning || duration ? (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          {isRunning ? (
            <LoaderCircle
              className="h-3 w-3 animate-spin text-blue-500 motion-reduce:animate-none"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
          {duration}
        </span>
      ) : null}
    </div>
  )
}

function ToolActivityStats({
  rows,
  labels,
}: {
  rows: ProcessingDisplayRow[]
  labels: ToolActivityLabels
}) {
  const stats = countProcessingActivityKinds(rows)
  const items = [
    { key: 'command', count: stats.command, label: labels.command, icon: SquareTerminal },
    { key: 'file', count: stats.file, label: labels.file, icon: FileText },
    { key: 'search', count: stats.search, label: labels.search, icon: Search },
    { key: 'edit', count: stats.edit, label: labels.edit, icon: Pencil },
    { key: 'other', count: stats.other, label: labels.other, icon: Wrench },
  ].filter(item => item.count > 0)

  if (items.length === 0) return null

  return (
    <div
      className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="processing-tool-stats"
    >
      {items.map(({ key, count, label, icon: Icon }) => (
        <span
          key={key}
          className="inline-flex shrink-0 items-center gap-1"
          title={`${label} ${count}`}
          aria-label={`${label} ${count}`}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
          <span className="font-mono">{count}</span>
        </span>
      ))}
    </div>
  )
}

function LiveProcessingPreview({
  rows,
  showThinking,
  onOpenWorkspaceFile,
  fileEditDurations,
}: {
  rows: ProcessingDisplayRow[]
  showThinking: boolean
  onOpenWorkspaceFile?: (path: string) => void
  fileEditDurations: ReadonlyMap<string, FileEditDuration>
}) {
  const { t } = useTranslation('chat')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(() => new Set())
  const hasExpandedDetail = rows.some(row => expandedRowIds.has(row.id))

  const updateExpandedRow = useCallback((rowId: string, expanded: boolean) => {
    setExpandedRowIds(current => {
      if (current.has(rowId) === expanded) return current
      const next = new Set(current)
      if (expanded) next.add(rowId)
      else next.delete(rowId)
      return next
    })
    if (!expanded) {
      requestAnimationFrame(() => {
        const scrollArea = scrollRef.current
        if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight
      })
    }
  }, [])

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current
    if (!scrollArea) return
    scrollArea.scrollTop = scrollArea.scrollHeight
  }, [rows.length])

  return (
    <div className="ml-2 min-w-0 border-l border-border pl-3" data-testid="processing-live-preview">
      <div
        ref={scrollRef}
        className="scrollbar-soft flex min-w-0 flex-col"
        data-testid="processing-live-preview-scroll"
        style={{
          maxHeight: hasExpandedDetail ? 'none' : '7rem',
          overflowY: hasExpandedDetail ? 'visible' : 'auto',
        }}
      >
        {rows.map((row, index) => (
          <LiveProcessingPreviewRow
            key={row.id}
            row={row}
            shimmer={isProcessingRowRunning(row) && index === rows.length - 1}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            fileEditDurations={fileEditDurations}
            onExpandedChange={updateExpandedRow}
          />
        ))}
        {showThinking ? (
          <div className="flex min-h-8 items-center py-1 text-sm" data-testid="tool-block-thinking">
            <span className="waiting-thinking-text">{t('thinking.running')}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LiveProcessingPreviewRow({
  row,
  shimmer,
  durationStartedAt,
  durationEndAt,
  fileEditDurations,
  onOpenWorkspaceFile,
  onExpandedChange,
}: {
  row: ProcessingDisplayRow
  shimmer: boolean
  durationStartedAt?: number
  durationEndAt?: number
  fileEditDurations: ReadonlyMap<string, FileEditDuration>
  onOpenWorkspaceFile?: (path: string) => void
  onExpandedChange: (rowId: string, expanded: boolean) => void
}) {
  const handleExpandedChange = useCallback(
    (expanded: boolean) => onExpandedChange(row.id, expanded),
    [onExpandedChange, row.id]
  )

  if (row.type === 'activity_group') {
    return (
      <div className="min-h-8 min-w-0 py-1">
        <ToolActivityGroup
          row={row}
          initialExpanded={false}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </div>
    )
  }

  if (row.block.type === 'tool') {
    if (isContextCompactionToolBlock(row.block)) {
      return <ContextCompactionIndicator block={row.block} />
    }

    return (
      <ToolBlockItem
        block={row.block}
        compact
        shimmer={shimmer}
        durationStartedAt={durationStartedAt}
        durationEndAt={durationEndAt}
        fileEditDurations={fileEditDurations}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onExpandedChange={handleExpandedChange}
      />
    )
  }

  return (
    <ToolBlockItem
      block={row.block}
      shimmer={shimmer}
      durationStartedAt={durationStartedAt}
      durationEndAt={durationEndAt}
      fileEditDurations={fileEditDurations}
      onExpandedChange={handleExpandedChange}
    />
  )
}

function getFileEditDurations(blocks: ProcessingBlock[]): ReadonlyMap<string, FileEditDuration> {
  const edits = blocks.flatMap(block => {
    if (block.type !== 'tool' || !isFileEditToolName(block.toolName)) return []
    const completedAt = block.completedAt
    if (completedAt === undefined) {
      return []
    }
    return getFileInputPaths(block).map(path => ({
      path: normalizeActivityPath(path),
      startedAt: block.createdAt,
      completedAt,
    }))
  })
  const durations = new Map<string, FileEditDuration>()

  blocks.forEach(block => {
    if (block.type !== 'file_changes') return
    block.fileChanges.files.forEach(file => {
      const filePath = normalizeActivityPath(file.path)
      const matches = edits.filter(
        edit =>
          edit.path === filePath ||
          edit.path.endsWith(`/${filePath}`) ||
          filePath.endsWith(`/${edit.path}`)
      )
      if (matches.length === 0) return
      durations.set(file.path, {
        startedAt: Math.min(...matches.map(match => match.startedAt)),
        completedAt: Math.max(...matches.map(match => match.completedAt)),
      })
    })
  })

  return durations
}

function normalizeActivityPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function isProcessingRowRunning(row: ProcessingDisplayRow): boolean {
  if (row.type === 'activity_group') {
    return row.blocks.some(block => block.status !== 'done' && block.status !== 'error')
  }
  return row.block.status !== 'done' && row.block.status !== 'error'
}

function countProcessingActivityKinds(rows: ProcessingDisplayRow[]) {
  const stats = { command: 0, file: 0, search: 0, edit: 0, other: 0 }

  const addToolBlock = (block: ToolBlock) => {
    const kind = getToolActivityKind(block)
    if (kind === 'command') stats.command += 1
    else if (kind === 'file') stats.file += 1
    else if (kind === 'search') stats.search += 1
    else if (kind === 'edit' || kind === 'create') stats.edit += 1
    else stats.other += 1
  }

  rows.forEach(row => {
    if (row.type === 'activity_group') {
      row.blocks.forEach(addToolBlock)
      return
    }
    if (row.block.type === 'tool') {
      addToolBlock(row.block)
      return
    }
    if (row.block.type === 'file_changes') {
      stats.edit += row.block.fileChanges.file_count || row.block.fileChanges.files.length
    }
  })

  return stats
}

function countProcessingToolCalls(stats: ReturnType<typeof countProcessingActivityKinds>): number {
  return stats.command + stats.file + stats.search + stats.other
}

function CollapsibleProcessingContent({
  expanded,
  children,
  keepMounted = false,
  testId = 'processing-collapse-content',
}: {
  expanded: boolean
  children: ReactNode
  keepMounted?: boolean
  testId?: string
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const previousExpandedRef = useRef(expanded)
  const [isRendered, setIsRendered] = useState(() => expanded || keepMounted)
  const [maxHeight, setMaxHeight] = useState(() => (expanded ? 'none' : '0px'))
  const shouldRender = expanded || keepMounted || isRendered

  if (expanded && !isRendered) {
    setIsRendered(true)
  }

  useLayoutEffect(() => {
    if (!shouldRender) return

    const content = contentRef.current
    if (!content) return

    const wasExpanded = previousExpandedRef.current
    let frame: number | undefined

    if (expanded) {
      setMaxHeight(wasExpanded ? 'none' : `${content.scrollHeight}px`)
    } else {
      if (wasExpanded) {
        setMaxHeight(`${content.scrollHeight}px`)
        frame = requestAnimationFrame(() => setMaxHeight('0px'))
      } else {
        setMaxHeight('0px')
      }
    }

    previousExpandedRef.current = expanded

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [expanded, shouldRender])

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'max-height') return
    if (expanded) {
      setMaxHeight('none')
      return
    }
    if (!keepMounted) setIsRendered(false)
  }
  const allowOverflow = expanded && maxHeight === 'none'

  return (
    <div
      data-testid={testId}
      aria-hidden={!expanded}
      inert={!expanded ? true : undefined}
      onTransitionEnd={handleTransitionEnd}
      className={[
        'transition-[max-height,opacity] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        allowOverflow ? 'overflow-visible' : 'overflow-hidden',
        expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
      ].join(' ')}
      style={{ maxHeight }}
    >
      {shouldRender ? (
        <div
          ref={contentRef}
          className={[
            'min-h-0 transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            allowOverflow ? 'overflow-visible' : 'overflow-hidden',
            expanded ? 'translate-y-0' : '-translate-y-1',
          ].join(' ')}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

function ToolActivityGroup({
  row,
  initialExpanded = true,
  onOpenWorkspaceFile,
}: {
  row: Extract<ProcessingDisplayRow, { type: 'activity_group' }>
  initialExpanded?: boolean
  onOpenWorkspaceFile?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const isWebSearchGroup = isWebSearchActivityGroup(row.blocks)
  const isGuidanceGroup = isGuidanceActivityGroup(row.blocks)
  const icon = renderActivityGroupIcon(row.blocks)

  if (isGuidanceGroup) {
    return (
      <div
        className="flex max-w-full items-center gap-1.5 text-sm text-text-muted"
        data-testid="processing-activity-group-label"
      >
        {icon}
        <span className="min-w-0 truncate">{row.label}</span>
      </div>
    )
  }

  return (
    <div className="min-w-0 overflow-x-clip text-sm">
      <button
        type="button"
        data-testid="processing-activity-group-toggle"
        data-tool-detail-toggle
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex max-w-full items-center gap-1.5 text-text-muted hover:text-text-secondary"
      >
        {icon}
        <span className="min-w-0 truncate">{row.label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
          strokeWidth={2}
        />
      </button>
      <CollapsibleProcessingContent expanded={expanded} testId="processing-activity-group-content">
        <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
          {isWebSearchGroup ? (
            <WebSearchActivityDetails blocks={row.blocks} />
          ) : (
            <ToolActivityDetails blocks={row.blocks} onOpenWorkspaceFile={onOpenWorkspaceFile} />
          )}
        </div>
      </CollapsibleProcessingContent>
    </div>
  )
}

function ContextCompactionIndicator({ block }: { block: ToolBlock }) {
  const label = getContextCompactionLabel(block)
  const isRunning = block.status !== 'done' && block.status !== 'error'
  const textClassName = block.status === 'error' ? 'text-red-500' : 'text-text-muted'

  return (
    <div
      className="flex w-full min-w-0 items-center gap-3 py-1"
      data-testid="context-compaction-indicator"
      aria-label={label}
    >
      <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
      <span
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm font-semibold ${textClassName}`}
      >
        <Archive className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        <span className={`min-w-0 truncate ${isRunning ? 'waiting-thinking-text' : ''}`}>
          {label}
        </span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}

function getContextCompactionLabel(block: ToolBlock): string {
  if (block.status === 'error') return '上下文压缩失败'
  if (block.status === 'done') return '上下文已自动压缩'
  return '正在自动压缩上下文'
}

function WebSearchActivityDetails({ blocks }: { blocks: ToolBlock[] }) {
  const items = getWebSearchActivityItems(blocks)

  if (items.length === 0) return null

  return <WebSearchActivityRows items={items} />
}

function ToolActivityDetails({
  blocks,
  onOpenWorkspaceFile,
}: {
  blocks: ToolBlock[]
  onOpenWorkspaceFile?: (path: string) => void
}) {
  return (
    <>
      {blocks.map(block => {
        const item = getToolActivitySearchItem(block)
        if (item) {
          return <CodeSearchActivityRow key={item.id} label={item.label} />
        }

        const paths = getToolActivityFilePaths(block)
        if (paths.length > 0) {
          return paths.map(path => (
            <FileReadActivityRow
              key={`${block.id}:${path}`}
              path={path}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ))
        }

        return (
          <ToolBlockItem key={block.id} block={block} onOpenWorkspaceFile={onOpenWorkspaceFile} />
        )
      })}
    </>
  )
}

function CodeSearchActivityRow({ label }: { label: string }) {
  return (
    <div
      data-testid="code-search-activity-row"
      className="flex max-w-full items-start gap-1.5 text-sm leading-5 text-text-muted"
    >
      <Search className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
      <span className="min-w-0 break-words">{label}</span>
    </div>
  )
}

function FileReadActivityRow({
  path,
  onOpenWorkspaceFile,
}: {
  path: string
  onOpenWorkspaceFile?: (path: string) => void
}) {
  const { t } = useTranslation('chat')
  const label = t('tool_activity.file_done', { name: basename(path) })
  const content = (
    <span data-testid="file-read-activity-row" className="min-w-0 truncate">
      {label}
    </span>
  )

  if (onOpenWorkspaceFile) {
    return (
      <button
        type="button"
        data-testid="file-read-activity-button"
        className="flex max-w-full items-center gap-1.5 text-left text-text-muted hover:text-text-secondary"
        onClick={() => onOpenWorkspaceFile(path)}
      >
        <FileText className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        {content}
      </button>
    )
  }

  return (
    <div className="flex max-w-full items-center gap-1.5 text-text-muted">
      <FileText className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
      {content}
    </div>
  )
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function hasCommandBlocks(blocks: ToolBlock[]): boolean {
  return blocks.some(block => isCommandToolName(block.toolName))
}

function hasCodeSearchBlocks(blocks: ToolBlock[]): boolean {
  return blocks.some(block => getToolActivityKind(block) === 'search')
}

function renderActivityGroupIcon(blocks: ToolBlock[]) {
  if (hasCodeSearchBlocks(blocks)) {
    return (
      <Search
        data-testid="processing-activity-search-icon"
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
      />
    )
  }
  if (hasCommandBlocks(blocks)) {
    return <SquareTerminal className="h-4 w-4 shrink-0" strokeWidth={1.7} />
  }
  if (isGuidanceActivityGroup(blocks)) {
    return <MessageCircle className="h-4 w-4 shrink-0" strokeWidth={1.7} />
  }
  const kind = getToolActivityGroupKind(blocks)
  if (kind === 'edit') {
    return (
      <Pencil
        data-testid="processing-activity-edit-icon"
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
      />
    )
  }
  if (kind === 'create' || kind === 'file') {
    return (
      <FileText
        data-testid="processing-activity-file-icon"
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
      />
    )
  }
  return <Search className="h-4 w-4 shrink-0" strokeWidth={1.7} />
}
