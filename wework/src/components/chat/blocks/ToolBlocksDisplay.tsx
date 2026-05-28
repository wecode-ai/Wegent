import { useState } from 'react'
import type { ToolBlock } from '@/types/workbench'
import { ToolBlockItem } from './ToolBlockItem'

interface ToolBlocksDisplayProps {
  blocks: ToolBlock[]
  isStreaming: boolean
}

export function ToolBlocksDisplay({ blocks, isStreaming }: ToolBlocksDisplayProps) {
  const [expanded, setExpanded] = useState(true)

  if (blocks.length === 0) return null

  const duration = getDuration(blocks)
  const isRunning = isStreaming || blocks.some(b => b.status !== 'done' && b.status !== 'error')

  return (
    <div className="mb-3">
      <button
        type="button"
        className="mb-2 flex items-center gap-1 text-xs text-[#999] hover:text-[#666]"
        onClick={() => setExpanded(!expanded)}
      >
        <span>
          {isRunning ? '处理中' : `已处理${duration ? ` ${duration}` : ''}`}
        </span>
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
        <div className="flex flex-col gap-2.5">
          {blocks.map(block => (
            <ToolBlockItem key={block.id} block={block} />
          ))}
        </div>
      )}
    </div>
  )
}

function getDuration(blocks: ToolBlock[]): string | null {
  if (blocks.length === 0) return null
  const first = blocks[0].createdAt
  const last = blocks[blocks.length - 1].createdAt
  const now = Date.now()
  const endTime = blocks.every(b => b.status === 'done' || b.status === 'error') ? last : now
  const durationMs = endTime - first
  if (durationMs < 1000) return null
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}
