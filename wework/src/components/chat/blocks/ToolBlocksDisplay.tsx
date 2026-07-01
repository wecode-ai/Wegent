import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, TransitionEvent } from 'react'
import { ChevronDown, MessageCircle, Search, SquareTerminal } from 'lucide-react'
import type { RequestUserInputResponse } from '@/types/api'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import {
  isAnsweredRequestUserInputBlock,
  isHiddenRequestUserInputBlock,
  isRequestUserInputBlock,
  type RequestUserInputBlock,
} from '../requestUserInputMessages'
import { ToolBlockItem } from './ToolBlockItem'
import {
  RequestUserInputCard,
  RequestUserInputSummary,
  type RequestUserInputPayload,
} from '../RequestUserInputCard'
import {
  buildProcessingDisplayRows,
  isCommandToolName,
  isGuidanceActivityGroup,
  isWebSearchActivityGroup,
  type ProcessingDisplayRow,
} from './toolBlockActivity'
import { usePersistentProcessingExpansion } from './processingExpansionState'
import { WebSearchActivityRows } from './WebSearchSources'
import { getWebSearchActivityItems } from './webSearchActivity'

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
  hasFinalContent?: boolean
  showSummary?: boolean
  showRunningPlaceholder?: boolean
  stateKey?: string
  onOpenWorkspaceFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
}

export function ToolBlocksDisplay({
  blocks,
  isStreaming,
  startedAt,
  forceExpanded = false,
  hasFinalContent = false,
  showSummary = true,
  showRunningPlaceholder = true,
  stateKey,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  hideRequestUserInputBlocks = false,
  hiddenRequestUserInputIds,
}: ToolBlocksDisplayProps) {
  const isRunning = isStreaming || blocks.some(b => b.status !== 'done' && b.status !== 'error')
  const [userExpanded, setUserExpanded] = usePersistentProcessingExpansion(
    stateKey ? `${stateKey}:processing` : undefined
  )
  const [mountedAt] = useState(() => Date.now())
  const turnStartedAt = startedAt ?? mountedAt
  const [hasRenderedRunning, setHasRenderedRunning] = useState(isRunning)
  const [completedAt, setCompletedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
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
      items.push(...buildProcessingDisplayRows(pendingRegularBlocks))
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
  const isLockedOpen = forceExpanded || (isRunning && !hasFinalContent)
  const expanded = isLockedOpen || userExpanded
  const canToggleSummary = showSummary && !isLockedOpen && rows.length > 0
  const hasLiveDisplayBlock = useMemo(
    () =>
      rows.some(
        row =>
          row.type === 'block' &&
          row.block.status !== 'done' &&
          row.block.status !== 'error' &&
          (row.block.type === 'tool' ||
            row.block.type === 'file_changes' ||
            Boolean(row.block.content))
      ),
    [rows]
  )
  const processingContent = useMemo(
    () => (
      <div className="flex min-w-0 flex-col gap-3 pt-0.5">
        {displayItems.map(item =>
          item.type === 'request_user_input' ? (
            isAnsweredRequestUserInputBlock(item.block) ? (
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
          ) : item.type === 'activity_group' ? (
            <ToolActivityGroup
              key={item.id}
              row={item}
              stateKey={stateKey ? `${stateKey}:${item.id}` : undefined}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ) : (
            <ToolBlockItem
              key={item.id}
              block={item.block}
              stateKey={stateKey ? `${stateKey}:${item.id}` : undefined}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          )
        )}
        {isRunning && showRunningPlaceholder && !hasLiveDisplayBlock && <ThinkingIndicator />}
      </div>
    ),
    [
      displayItems,
      hasLiveDisplayBlock,
      isRunning,
      onOpenWorkspaceFile,
      onRequestUserInputIgnore,
      onRequestUserInputSubmit,
      showRunningPlaceholder,
      stateKey,
    ]
  )

  if (blocks.length === 0 && !isStreaming) return null

  return (
    <div className="mb-3 min-w-0 w-full">
      {showSummary && !canToggleSummary ? (
        <div className="mb-3 w-full border-b border-border pb-2 text-xs text-text-muted">
          <span className="inline-flex items-center gap-1">{duration}</span>
        </div>
      ) : showSummary ? (
        <div className="mb-3 w-full border-b border-border pb-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-left text-xs text-text-muted hover:text-text-secondary"
            onClick={() => setUserExpanded(value => !value)}
            aria-expanded={expanded}
          >
            <span>{duration}</span>
            <svg
              className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      ) : null}
      <CollapsibleProcessingContent expanded={expanded} keepMounted>
        {processingContent}
      </CollapsibleProcessingContent>
    </div>
  )
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

  return (
    <div
      data-testid={testId}
      aria-hidden={!expanded}
      inert={!expanded ? true : undefined}
      onTransitionEnd={handleTransitionEnd}
      className={[
        'overflow-hidden transition-[max-height,opacity] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
      ].join(' ')}
      style={{ maxHeight }}
    >
      {shouldRender ? (
        <div
          ref={contentRef}
          className={[
            'min-h-0 overflow-hidden transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
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
  onOpenWorkspaceFile,
}: {
  row: Extract<ProcessingDisplayRow, { type: 'activity_group' }>
  stateKey?: string
  onOpenWorkspaceFile?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isWebSearchGroup = isWebSearchActivityGroup(row.blocks)
  const isGuidanceGroup = isGuidanceActivityGroup(row.blocks)
  const icon = renderActivityGroupIcon(row.blocks)

  if (isGuidanceGroup) {
    return (
      <div
        className="flex max-w-full items-center gap-1.5 text-[13px] text-text-muted"
        data-testid="processing-activity-group-label"
      >
        {icon}
        <span className="min-w-0 truncate">{row.label}</span>
      </div>
    )
  }

  return (
    <div className="min-w-0 overflow-x-hidden text-[13px]">
      <button
        type="button"
        data-testid="processing-activity-group-toggle"
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
        <div
          className={[
            'mt-2 flex min-w-0 flex-col gap-3',
            isWebSearchGroup ? '' : 'border-l border-border pl-4',
          ].join(' ')}
        >
          {isWebSearchGroup ? (
            <WebSearchActivityDetails blocks={row.blocks} />
          ) : (
            row.blocks.map(block => (
              <ToolBlockItem
                key={block.id}
                block={block}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            ))
          )}
        </div>
      </CollapsibleProcessingContent>
    </div>
  )
}

function WebSearchActivityDetails({ blocks }: { blocks: ToolBlock[] }) {
  const items = getWebSearchActivityItems(blocks)

  if (items.length === 0) return null

  return <WebSearchActivityRows items={items} />
}

function hasCommandBlocks(blocks: ToolBlock[]): boolean {
  return blocks.some(block => isCommandToolName(block.toolName))
}

function renderActivityGroupIcon(blocks: ToolBlock[]) {
  if (hasCommandBlocks(blocks)) {
    return <SquareTerminal className="h-4 w-4 shrink-0" strokeWidth={1.7} />
  }
  if (isGuidanceActivityGroup(blocks)) {
    return <MessageCircle className="h-4 w-4 shrink-0" strokeWidth={1.7} />
  }
  return <Search className="h-4 w-4 shrink-0" strokeWidth={1.7} />
}

function ThinkingIndicator() {
  return (
    <div
      className="flex items-center gap-1.5 text-[13px] text-text-muted"
      data-testid="thinking-indicator"
    >
      <span>正在思考</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
      </span>
    </div>
  )
}

function getDurationText(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): string {
  // Anchor the elapsed time to the turn's wall-clock start rather than the
  // first block. After a page refresh the in-progress blocks are re-streamed
  // with fresh client timestamps, so anchoring to blocks[0] would restart the
  // timer from the refresh moment.
  const first = turnStartedAt
  const last = blocks[blocks.length - 1]?.createdAt ?? first
  // While running, keep counting against the live clock so the timer advances
  // every second even during pure thinking phases with no new tool output.
  // Once finished, lock to the completion time (or the last block timestamp
  // when the turn was restored from history after a refresh).
  const endTime = isRunning ? now : (completedAt ?? last)
  const durationMs = isRunning ? Math.max(1000, endTime - first) : Math.max(0, endTime - first)
  const duration = formatDuration(durationMs)

  return `已处理 ${duration}`
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds} 秒`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (remainingMinutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${remainingMinutes} 分钟`
}
