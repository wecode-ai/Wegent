// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState, useMemo } from 'react'
import { Search, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ThinkingStep } from './types'
import { extractToolCalls, isRunningStatus, isTerminalStatus } from './utils/thinkingUtils'

interface SimpleThinkingViewProps {
  thinking: ThinkingStep[] | null
  taskStatus?: string
}

interface ToolEntry {
  toolName: string
  query: string
  status: 'running' | 'completed' | 'failed'
  resultCount?: number
  startIndex: number
  endIndex?: number
  // Display name from backend (e.g., "正在渲染图表", "正在搜索网页")
  displayTitle?: string
  // Completed display title from backend (e.g., "渲染图表完成", "搜索网页完成")
  completedTitle?: string
  // Error message for failed status
  errorMessage?: string
}

/**
 * Simple thinking view for Chat shell type
 * Shows a collapsible timeline of tool usage with minimal detail
 */
const SimpleThinkingView = memo(function SimpleThinkingView({
  thinking,
  taskStatus,
}: SimpleThinkingViewProps) {
  const { t } = useTranslation()
  const items = useMemo(() => thinking ?? [], [thinking])

  // Process thinking steps into paired tool entries
  const toolEntries = useMemo(() => {
    const entries: ToolEntry[] = []
    const toolStartMap = new Map<string, number>()

    if (items.length > 0) {
      items.forEach((step, index) => {
        const details = step.details
        if (!details) return

        // Track tool_use starts
        if (details.type === 'tool_use' && details.status === 'started') {
          const toolName: string =
            (typeof details.tool_name === 'string' ? details.tool_name : '') ||
            (typeof details.name === 'string' ? details.name : '') ||
            'unknown'
          const runId = (step as { run_id?: string }).run_id || `${index}`

          let query: string = ''
          if (toolName === 'web_search' && details.input) {
            query = (details.input as { query?: string }).query || ''
          } else if (toolName === 'wegentFetch' && details.input) {
            query = (details.input as { url?: string }).url || ''
          } else {
            const titleStr = typeof step.title === 'string' ? step.title : ''
            query = titleStr || toolName
          }

          // Get display title from backend (e.g., "正在渲染图表")
          const displayTitle = typeof step.title === 'string' ? step.title : undefined

          toolStartMap.set(runId, entries.length)
          entries.push({
            toolName,
            query,
            status: 'running',
            startIndex: index,
            displayTitle,
          })
        }
        // Match tool_result with tool_use (completed or failed)
        else if (
          details.type === 'tool_result' &&
          (details.status === 'completed' || details.status === 'failed')
        ) {
          console.log('[SimpleThinkingView] Processing tool_result:', {
            status: details.status,
            tool_name: details.tool_name,
            error: details.error,
            title: step.title,
          })
          const toolName: string =
            (typeof details.tool_name === 'string' ? details.tool_name : '') ||
            (typeof details.name === 'string' ? details.name : '') ||
            'unknown'
          const runId = (step as { run_id?: string }).run_id || ''
          const startIdx = toolStartMap.get(runId)

          let resultCount: number | undefined
          if (toolName === 'web_search') {
            try {
              const output = details.output || details.content
              let outputData: { count?: number }

              if (typeof output === 'string') {
                outputData = JSON.parse(output)
              } else {
                outputData = output as { count?: number }
              }

              resultCount = outputData.count
            } catch {
              // Ignore parse errors
            }
          }

          // Get completed title from backend (e.g., "渲染图表完成" or "任务失败: xxx")
          const completedTitle = typeof step.title === 'string' ? step.title : undefined
          // Get error message if failed
          const errorMessage =
            details.status === 'failed' ? (details.error as string | undefined) : undefined

          if (startIdx !== undefined && entries[startIdx]) {
            entries[startIdx].status = details.status as 'completed' | 'failed'
            entries[startIdx].resultCount = resultCount
            entries[startIdx].endIndex = index
            entries[startIdx].completedTitle = completedTitle
            entries[startIdx].errorMessage = errorMessage
          }
        }
      })
    }

    return entries
  }, [items])

  // Check if any tool is still running
  const hasRunningTool = toolEntries.some(entry => entry.status === 'running')
  const isRunning = isRunningStatus(taskStatus)
  const isCompleted = isTerminalStatus(taskStatus)

  // Also get tool counts from the standard extraction for fallback
  const toolCounts = useMemo(() => extractToolCalls(items), [items])
  const toolCountFromCounts = Object.values(toolCounts).reduce((sum, count) => sum + count, 0)

  // Default to expanded if there's an active tool
  const [isExpanded, setIsExpanded] = useState(hasRunningTool || isRunning)

  // Early return after hooks
  if (items.length === 0 || (toolEntries.length === 0 && toolCountFromCounts === 0)) {
    return null
  }

  const toolCount = toolEntries.length > 0 ? toolEntries.length : toolCountFromCounts

  // Summary text
  const summaryText =
    isRunning && !isCompleted
      ? `${t('chat:messages.using_tools') || 'Using tools'}...`
      : toolCount > 0
        ? `${t('chat:messages.used_tools') || 'Used tools'} · ${toolCount} ${t('chat:messages.times') || 'times'}`
        : `${t('chat:messages.used_tools') || 'Used tools'}`

  return (
    <div className="-mb-2">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all hover:bg-surface/50 bg-blue-500/5 border-blue-500/20 text-blue-600 dark:text-blue-400"
      >
        <Search
          className={`h-3.5 w-3.5 flex-shrink-0 ${isRunning && !isCompleted ? 'animate-slide' : ''}`}
        />
        <span className="text-xs font-medium">{summaryText}</span>
        {isExpanded ? (
          <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
        )}
      </button>

      {/* Expandable timeline */}
      {isExpanded && toolEntries.length > 0 && (
        <div className="mt-2 ml-4 pl-4 space-y-2">
          {toolEntries.map((entry, index) => (
            <div key={index} className="relative">
              {/* Tool entry - single line display */}
              <div className="relative">
                <div
                  className={`absolute -left-[19px] top-0.5 w-3 h-3 rounded-full border-2 bg-surface ${
                    entry.status === 'running'
                      ? 'border-blue-500 animate-pulse'
                      : entry.status === 'failed'
                        ? 'border-red-500/60'
                        : 'border-green-500/60'
                  }`}
                />
                <div className="text-xs">
                  <div
                    className={`font-medium ${
                      entry.status === 'running'
                        ? 'text-blue-600 dark:text-blue-400'
                        : entry.status === 'failed'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-green-600 dark:text-green-400'
                    }`}
                  >
                    {entry.status === 'running'
                      ? entry.displayTitle ||
                        `${t('chat:messages.using_tool') || 'Using tool'}: ${entry.toolName}`
                      : entry.completedTitle || entry.displayTitle || entry.toolName}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default SimpleThinkingView
