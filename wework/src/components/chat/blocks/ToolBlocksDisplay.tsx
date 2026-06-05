import { useEffect, useState } from 'react'
import { ChevronDown, Search, SquareTerminal } from 'lucide-react'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import { ToolBlockItem } from './ToolBlockItem'
import {
  buildProcessingDisplayRows,
  type ProcessingDisplayRow,
} from './toolBlockActivity'

interface ToolBlocksDisplayProps {
  blocks: ProcessingBlock[]
  isStreaming: boolean
}

export function ToolBlocksDisplay({ blocks, isStreaming }: ToolBlocksDisplayProps) {
  const isRunning = isStreaming || blocks.some(b => b.status !== 'done' && b.status !== 'error')
  const [userExpanded, setUserExpanded] = useState(false)
  const [startedAt] = useState(() => Date.now())
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

  if (blocks.length === 0 && !isStreaming) return null

  const duration = getDuration(blocks, startedAt, now, completedAt)
  const rows = buildProcessingDisplayRows(blocks)
  const expanded = isRunning || userExpanded

  return (
    <div className="mb-3 min-w-0">
      <button
        type="button"
        className="mb-3 flex w-full items-center gap-1 border-b border-border pb-2 text-left text-xs text-text-muted hover:text-text-secondary disabled:hover:text-text-muted"
        disabled={isRunning}
        onClick={() => {
          if (!isRunning) setUserExpanded(value => !value)
        }}
      >
        <span>已处理 {duration} 时间了</span>
        <svg
          className={`h-3 w-3 transition-transform ${expanded || isRunning ? '' : '-rotate-90'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="flex min-w-0 flex-col gap-3">
          {rows.map(row =>
            row.type === 'activity_group' ? (
              <ToolActivityGroup key={row.id} row={row} />
            ) : (
              <ToolBlockItem key={row.id} block={row.block} />
            )
          )}
          {isRunning && <ThinkingIndicator />}
        </div>
      )}
    </div>
  )
}

function ToolActivityGroup({
  row,
}: {
  row: Extract<ProcessingDisplayRow, { type: 'activity_group' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = hasCommandBlocks(row.blocks) ? SquareTerminal : Search

  return (
    <div className="min-w-0 overflow-x-hidden text-sm">
      <button
        type="button"
        data-testid="processing-activity-group-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex max-w-full items-center gap-1.5 text-text-muted hover:text-text-secondary"
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.7} />
        <span className="min-w-0 truncate">{row.label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${
            expanded ? '' : '-rotate-90'
          }`}
          strokeWidth={2}
        />
      </button>
      {expanded && (
        <div className="mt-2 flex min-w-0 flex-col gap-3 border-l border-border pl-4">
          {row.blocks.map(block => (
            <ToolBlockItem key={block.id} block={block} />
          ))}
        </div>
      )}
    </div>
  )
}

function hasCommandBlocks(blocks: ToolBlock[]): boolean {
  return blocks.some(block =>
    ['bash', 'execute_command', 'run_terminal_command'].includes(
      block.toolName.toLowerCase()
    )
  )
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1.5 text-sm text-text-muted">
      <span>正在思考</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
      </span>
    </div>
  )
}

function getDuration(
  blocks: ProcessingBlock[],
  fallbackStart: number,
  now: number,
  completedAt: number | null
): string {
  const first = blocks[0]?.createdAt ?? fallbackStart
  const last = blocks[blocks.length - 1]?.createdAt ?? first
  const isComplete =
    blocks.length > 0 && blocks.every(b => b.status === 'done' || b.status === 'error')
  const endTime = isComplete ? (completedAt ?? last) : now
  const durationMs = Math.max(0, endTime - first)
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}
