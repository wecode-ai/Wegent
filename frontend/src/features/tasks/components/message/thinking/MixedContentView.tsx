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
  taskStatus: _taskStatus,
  theme,
  blocks,
}: MixedContentViewProps) {
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
            const normalizedToolName = normalizeToolName(
              block.tool_name || 'unknown',
              block.tool_name
            )
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
      console.log('[MixedContentView] After mapping and filtering:', {
        mappedCount: mapped.length,
        mappedTypes: mapped.map(m => (m as { type: string }).type),
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

  // DEBUG: Log final rendering
  console.log('[MixedContentView] Final render:', {
    mixedItemsCount: mixedItems.length,
    mixedItemsTypes: mixedItems.map(item => (item as { type?: string } | null | undefined)?.type),
    willRenderCount: mixedItems.filter(item => {
      if (!item) return false
      if (item.type === 'content') {
        return !!(item.content && typeof item.content === 'string' && item.content.trim())
      }
      return true
    }).length,
  })

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
    </div>
  )
})

export default MixedContentView
