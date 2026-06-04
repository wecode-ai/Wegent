import { useEffect, useState } from 'react'
import type { ProcessingBlock } from '@/types/workbench'
import { ToolBlockItem } from './ToolBlockItem'

interface ToolBlocksDisplayProps {
  blocks: ProcessingBlock[]
  isStreaming: boolean
}

export function ToolBlocksDisplay({ blocks, isStreaming }: ToolBlocksDisplayProps) {
  const isRunning = isStreaming || blocks.some(b => b.status !== 'done' && b.status !== 'error')
  const [expanded, setExpanded] = useState(true)
  const [startedAt] = useState(() => Date.now())
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  if (blocks.length === 0 && !isStreaming) return null

  const duration = getDuration(blocks, startedAt)

  return (
    <div className="mb-3 min-w-0">
      <button
        type="button"
        className="mb-3 flex w-full items-center gap-1 border-b border-border pb-2 text-left text-xs text-text-muted hover:text-text-secondary"
        onClick={() => setExpanded(value => !value)}
      >
        <span>已处理 {duration}</span>
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
      {expanded && (
        <div className="flex min-w-0 flex-col gap-3">
          {blocks.map(block => (
            <ToolBlockItem key={block.id} block={block} />
          ))}
          {isRunning && <ThinkingIndicator />}
        </div>
      )}
    </div>
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

function getDuration(blocks: ProcessingBlock[], fallbackStart: number): string {
  const first = blocks[0]?.createdAt ?? fallbackStart
  const last = blocks[blocks.length - 1]?.createdAt ?? first
  const now = Date.now()
  const isComplete =
    blocks.length > 0 && blocks.every(b => b.status === 'done' || b.status === 'error')
  const endTime = isComplete ? last : now
  const durationMs = Math.max(0, endTime - first)
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}
