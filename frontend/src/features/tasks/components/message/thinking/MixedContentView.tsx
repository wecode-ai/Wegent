// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useMemo } from 'react'
import type { ThinkingStep, MessageBlock, ToolPair } from './types'
import { useToolExtraction } from './hooks/useToolExtraction'
import { ToolBlock } from './components/ToolBlock'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { normalizeToolName } from './utils/toolExtractor'
import { useTranslation } from '@/hooks/useTranslation'

interface MixedContentViewProps {
  thinking: ThinkingStep[] | null
  content: string
  taskStatus?: string // For future use (e.g., showing pending states)
  theme: 'light' | 'dark'
  blocks?: MessageBlock[] // NEW: Block-based rendering support
}

/**
 * MixedContentView Component
 *
 * Renders content and tool calls in chronological order.
 * Supports two modes:
 * 1. Block-based (new): Uses blocks array for chronological mixed rendering
 * 2. Thinking-based (legacy): Extracts tools from thinking array
 */
const MixedContentView = memo(function MixedContentView({
  thinking,
  content,
  taskStatus,
  theme,
  blocks,
}: MixedContentViewProps) {
  const { t } = useTranslation('chat')
  // Extract tools from thinking (legacy mode)
  const { toolGroups } = useToolExtraction(thinking)

  // Create a map of tool_use_id to ToolPair for quick lookup (legacy mode)
  const toolMap = useMemo(() => {
    const map = new Map()
    toolGroups.forEach(group => {
      group.tools.forEach(tool => {
        map.set(tool.toolUseId, tool)
      })
    })
    return map
  }, [toolGroups])

  // Build mixed content array - prefer blocks if available
  const mixedItems = useMemo(() => {
    // NEW: Block-based rendering (preferred)
    if (blocks && blocks.length > 0) {
      const mapped = blocks
        .map(block => {
          if (block.type === 'text') {
            return {
              type: 'content' as const,
              content: block.content || '',
              blockId: block.id,
            }
          } else if (block.type === 'tool') {
            // Convert MessageBlock to ToolPair format for ToolBlock component
            // Normalize tool name to match preset components (e.g., sandbox_write_file -> Write)
            const normalizedToolName = normalizeToolName(block.tool_name || 'unknown')
            const toolPair = {
              toolUseId: block.tool_use_id || block.id,
              toolName: normalizedToolName,
              displayName: block.display_name, // Pass display_name from block
              status:
                (block.status as 'pending' | 'streaming' | 'invoking' | 'done' | 'error') || 'done',
              toolUse: {
                title: `Using ${normalizedToolName}`,
                next_action: 'continue',
                tool_use_id: block.tool_use_id,
                details: {
                  type: 'tool_use',
                  tool_name: normalizedToolName,
                  status: 'started',
                  input: block.tool_input,
                },
              },
              toolResult: block.tool_output
                ? {
                    title: `Result from ${normalizedToolName}`,
                    next_action: 'continue',
                    tool_use_id: block.tool_use_id,
                    details: {
                      type: 'tool_result',
                      tool_name: normalizedToolName,
                      status: block.status === 'error' ? 'failed' : 'completed',
                      content:
                        typeof block.tool_output === 'string'
                          ? block.tool_output
                          : JSON.stringify(block.tool_output),
                      output: block.tool_output,
                    },
                  }
                : undefined,
            }
            return {
              type: 'tool' as const,
              tool: toolPair,
              blockId: block.id,
            }
          }
          return null
        })
        .filter(Boolean)

      // CRITICAL FIX: When blocks exist but no text blocks, we need to also render
      // the main content. This handles the case where:
      // 1. chat:block_created creates a tool block
      // 2. chat:chunk sends text content (accumulated in message.content)
      // 3. Without this fix, only tool blocks are rendered, text content is lost
      const hasTextBlock = blocks.some(b => b.type === 'text')
      if (!hasTextBlock && content && content.trim()) {
        // Handle ${$$}$ separator - only show the result part (after separator)
        // This separator is used to split prompt and result in some message formats
        let contentToRender = content
        if (content.includes('${$$}$')) {
          const parts = content.split('${$$}$')
          contentToRender = parts[1] || ''
        }

        if (contentToRender && contentToRender.trim()) {
          // Add main content at the end (after tool blocks)
          mapped.push({
            type: 'content' as const,
            content: contentToRender,
            blockId: 'main-content',
          })
        }
      }

      console.log('[MixedContentView] After mapping and filtering:', {
        mappedCount: mapped.length,
        mappedTypes: mapped.map(m => (m as { type: string }).type),
        hasTextBlock,
        hasMainContent: !hasTextBlock && content && content.trim(),
      })
      return mapped
    }

    // LEGACY: Thinking-based rendering (fallback for old messages)
    if (!thinking?.length) {
      // No thinking data, just show content if not empty
      if (content && content.trim()) {
        return [{ type: 'content' as const, content }]
      }
      return []
    }

    const items: Array<{ type: 'content'; content: string } | { type: 'tool'; tool: ToolPair }> = []

    let hasShownMainContent = false

    thinking.forEach(step => {
      const stepType = step.details?.type

      // Show main content before first tool if not shown yet
      if (!hasShownMainContent && stepType === 'tool_use') {
        if (content && content.trim()) {
          items.push({ type: 'content', content })
          hasShownMainContent = true
        }
      }

      if (stepType === 'tool_use') {
        // Find the tool pair
        const toolUseId = step.tool_use_id || step.run_id
        const tool = toolUseId ? toolMap.get(toolUseId) : null

        if (tool) {
          items.push({ type: 'tool', tool })
        }
      } else if (stepType === 'assistant' || stepType === 'user') {
        // Text content from thinking steps
        const text = step.details?.content || step.title
        if (text && text.trim() && typeof text === 'string') {
          items.push({ type: 'content', content: text })
        }
      }
    })

    // If main content wasn't shown yet (no tools), show it at the end
    if (!hasShownMainContent && content && content.trim()) {
      items.push({ type: 'content', content })
    }

    return items
  }, [blocks, thinking, content, toolMap])

  // Check if we should show "Processing..." indicator
  const shouldShowProcessing = useMemo(() => {
    // Show processing indicator whenever task is running
    // This ensures users always see feedback that the task is being processed
    return taskStatus === 'RUNNING'
  }, [taskStatus])

  return (
    <div className="space-y-3">
      {mixedItems.map((item, index) => {
        // Null check after filter
        if (!item) {
          return null
        }

        if (item.type === 'content') {
          // Skip empty content or non-string content
          if (!item.content || typeof item.content !== 'string' || !item.content.trim()) {
            return null
          }
          const key = 'blockId' in item ? item.blockId : `content-${index}`
          return (
            <div key={key} className="text-sm">
              <EnhancedMarkdown source={item.content} theme={theme} />
            </div>
          )
        } else if (item.type === 'tool') {
          const key = 'blockId' in item ? item.blockId : `tool-${item.tool.toolUseId}`
          return <ToolBlock key={key} tool={item.tool} defaultExpanded={false} />
        }
        return null
      })}

      {/* Show "Processing..." indicator when task is running and last block is complete */}
      {shouldShowProcessing && (
        <div className="flex items-center gap-2 text-xs text-text-muted italic px-2 py-1">
          <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
          <span>{t('thinking.processing') || 'Processing...'}</span>
        </div>
      )}
    </div>
  )
})

export default MixedContentView
