// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Loader2, Pencil, FileText, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolBlockProps, ToolRendererProps } from '../types'
import { GenericToolRenderer } from './tools/GenericToolRenderer'
import { BashToolRenderer } from './tools/BashToolRenderer'
import { ReadToolRenderer } from './tools/ReadToolRenderer'
import { EditToolRenderer } from './tools/EditToolRenderer'
import { WriteToolRenderer } from './tools/WriteToolRenderer'
import { GrepToolRenderer } from './tools/GrepToolRenderer'
import { GlobToolRenderer } from './tools/GlobToolRenderer'
import { TodoWriteToolRenderer } from './tools/TodoWriteToolRenderer'
import { UploadToolRenderer } from './tools/UploadToolRenderer'

/**
 * Get a short preview of the tool input for display in the header
 * Returns a truncated string suitable for inline display
 */
function getToolInputPreview(
  tool: ToolRendererProps['tool'],
  maxLength: number = 60
): string | null {
  const input = tool.toolUse?.details?.input as Record<string, unknown> | string | undefined
  if (!input) return null

  const toolName = tool.toolName

  // Handle different tool types
  switch (toolName) {
    case 'Bash': {
      const command = typeof input === 'object' ? (input.command as string) : input
      if (command) {
        return truncateText(command, maxLength)
      }
      break
    }
    case 'Read': {
      const filePath = typeof input === 'object' ? (input.file_path as string) : input
      if (filePath) {
        return truncateText(filePath, maxLength)
      }
      break
    }
    case 'Write': {
      const filePath = typeof input === 'object' ? (input.file_path as string) : input
      if (filePath) {
        return truncateText(filePath, maxLength)
      }
      break
    }
    case 'Edit': {
      const filePath = typeof input === 'object' ? (input.file_path as string) : input
      if (filePath) {
        return truncateText(filePath, maxLength)
      }
      break
    }
    case 'Grep': {
      const pattern = typeof input === 'object' ? (input.pattern as string) : input
      if (pattern) {
        return truncateText(`"${pattern}"`, maxLength)
      }
      break
    }
    case 'Glob': {
      const pattern = typeof input === 'object' ? (input.pattern as string) : input
      if (pattern) {
        return truncateText(pattern, maxLength)
      }
      break
    }
    case 'knowledge_base_search':
    case 'web_search': {
      const query = typeof input === 'object' ? (input.query as string) : input
      if (query) {
        return truncateText(`"${query}"`, maxLength)
      }
      break
    }
    default: {
      // For generic tools, try to extract a meaningful preview
      if (typeof input === 'string') {
        return truncateText(input, maxLength)
      }
      // Try common field names
      if (typeof input === 'object') {
        const preview =
          (input.command as string) ||
          (input.query as string) ||
          (input.file_path as string) ||
          (input.path as string) ||
          (input.content as string) ||
          (input.text as string)
        if (preview && typeof preview === 'string') {
          return truncateText(preview, maxLength)
        }
      }
    }
  }

  return null
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed
 */
function truncateText(text: string, maxLength: number): string {
  // Remove newlines and extra whitespace for inline display
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) {
    return cleaned
  }
  return cleaned.substring(0, maxLength - 3) + '...'
}

/**
 * Get tool icon component based on tool name
 */
function getToolIcon(toolName: string) {
  switch (toolName) {
    case 'Edit':
    case 'Write':
      return Pencil
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'TodoWrite':
    default:
      return FileText
  }
}

/**
 * Extended props for ToolBlock with count and merged tools support
 */
interface ToolBlockWithCountProps extends ToolBlockProps {
  /** Number of consecutive same tools (for merged display) */
  count?: number
  /** All merged tools (for expanded view when count > 1) */
  mergedTools?: ToolRendererProps['tool'][]
}

/**
 * ToolBlock Component
 *
 * Displays a single tool execution as a compact inline block.
 * Features a minimal design with icon and text in a rounded pill shape.
 * Supports optional expansion to show detailed tool input/output.
 * When count > 1, displays as "Tool Name x count" format and shows all merged tools when expanded.
 */
export const ToolBlock = memo(function ToolBlock({
  tool,
  defaultExpanded = false,
  count = 1,
  mergedTools = [],
}: ToolBlockWithCountProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  // Get tool icon component
  const ToolIcon = getToolIcon(tool.toolName)

  // Check if any tool is running (for spinner animation)
  // For merged tools, check if any of them is still running
  const isRunning = useMemo(() => {
    const checkRunning = (status: string | undefined) =>
      status === 'invoking' || status === 'streaming' || status === 'pending'

    if (count > 1 && mergedTools.length > 0) {
      return mergedTools.some(item => checkRunning(item.status))
    }
    return checkRunning(tool.status)
  }, [tool.status, count, mergedTools])

  // Check if any tool has error status
  const hasError = useMemo(() => {
    if (count > 1 && mergedTools.length > 0) {
      return mergedTools.some(item => item.status === 'error')
    }
    return tool.status === 'error'
  }, [tool.status, count, mergedTools])

  // Count completed tools for merged display
  const completedCount = useMemo(() => {
    if (count > 1 && mergedTools.length > 0) {
      return mergedTools.filter(item => item.status === 'done').length
    }
    return tool.status === 'done' ? 1 : 0
  }, [tool.status, count, mergedTools])

  // Get tool display name and input preview
  const toolDisplayName = getToolDisplayName(tool, t)
  const inputPreview = useMemo(() => getToolInputPreview(tool), [tool])

  // Check if expandable (has content to show)
  const hasInput =
    tool.toolUse?.details?.input &&
    (typeof tool.toolUse.details.input === 'string'
      ? tool.toolUse.details.input.length > 0
      : Object.keys(tool.toolUse.details.input).length > 0)
  const hasOutput = tool.toolResult?.details?.output || tool.toolResult?.details?.content
  const hasContent = hasInput || hasOutput
  const isExpandable = hasContent

  // Build display text: tool name + input preview (or count if merged)
  // When count > 1, show "Tool Name x count" format without input preview
  const displayText =
    count > 1
      ? toolDisplayName
      : inputPreview
        ? `${toolDisplayName} ${inputPreview}`
        : toolDisplayName

  // Get all tools to display (merged tools or just the single tool)
  const toolsToDisplay = count > 1 && mergedTools.length > 0 ? mergedTools : [tool]

  // Check if any tool has content to show
  const hasMergedContent = count > 1 && mergedTools.length > 0
  const canExpand = isExpandable || hasMergedContent

  return (
    <div className="mb-1">
      {/* Compact inline block - pill style with border and rounded corners */}
      <div
        className={`inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 border rounded-xl ${
          hasError
            ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
            : 'bg-[#f7f7f8] dark:bg-[#2a2a2a] border-[#e5e5e5] dark:border-[#3a3a3a]'
        } ${
          canExpand
            ? 'cursor-pointer hover:bg-[#f0f0f0] dark:hover:bg-[#333] hover:border-[#ddd] dark:hover:border-[#444]'
            : 'cursor-default'
        } transition-all`}
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
      >
        {/* Icon container with background and border */}
        <div className="flex items-center justify-center w-4 h-4 bg-white dark:bg-[#3a3a3a] border border-[#e8e8e8] dark:border-[#444] rounded-md flex-shrink-0">
          {isRunning ? (
            <Loader2 className="w-2.5 h-2.5 text-[#888] dark:text-[#999] animate-spin" />
          ) : hasError ? (
            <AlertCircle className="w-2.5 h-2.5 text-red-500" />
          ) : (
            <ToolIcon className="w-2.5 h-2.5 text-[#888] dark:text-[#999]" />
          )}
        </div>

        {/* Tool name and preview text */}
        <span className="text-xs text-[#666] dark:text-[#aaa] truncate max-w-[400px]">
          {displayText}
        </span>

        {/* Count badge when merged (count > 1) with status indicator */}
        {count > 1 && (
          <span className="text-xs flex items-center gap-1 flex-shrink-0">
            {/* Status indicator for merged tools - only show error icon */}
            {hasError && <AlertCircle className="w-3 h-3 text-amber-500" />}
            <span className="text-[#999] dark:text-[#777]">
              {isRunning ? `${completedCount}/${count}` : `x ${count}`}
            </span>
          </span>
        )}

        {/* Expand/collapse indicator */}
        {canExpand && (
          <div className="flex-shrink-0 ml-0.5">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-[#aaa] dark:text-[#666]" />
            ) : (
              <ChevronRight className="w-3 h-3 text-[#aaa] dark:text-[#666]" />
            )}
          </div>
        )}
      </div>

      {/* Expanded content - shows all merged tools or single tool */}
      {isExpanded && canExpand && (
        <div className="mt-1.5 ml-6 space-y-2">
          {toolsToDisplay.map((toolItem, idx) => {
            const CurrentToolRenderer = getToolRenderer(toolItem.toolName)
            const preview = getToolInputPreview(toolItem, 80)
            // Check if tool has content to render
            const toolHasInput =
              toolItem.toolUse?.details?.input &&
              (typeof toolItem.toolUse.details.input === 'string'
                ? toolItem.toolUse.details.input.length > 0
                : Object.keys(toolItem.toolUse.details.input).length > 0)
            const toolHasOutput =
              toolItem.toolResult?.details?.output || toolItem.toolResult?.details?.content
            const toolHasContent = toolHasInput || toolHasOutput
            const toolIsRunning =
              toolItem.status === 'invoking' ||
              toolItem.status === 'streaming' ||
              toolItem.status === 'pending'

            return (
              <div
                key={toolItem.toolUseId || idx}
                className="p-2.5 bg-[#f7f7f8] dark:bg-[#2a2a2a] rounded-xl border border-[#e5e5e5] dark:border-[#3a3a3a]"
              >
                {/* Show preview header for merged tools */}
                {count > 1 && preview && (
                  <div className="text-xs text-[#888] dark:text-[#777] mb-2 font-mono truncate">
                    {preview}
                  </div>
                )}
                {/* Show loading state if tool is running and has no content yet */}
                {!toolHasContent && toolIsRunning ? (
                  <div className="flex items-center gap-2 text-xs text-[#888] dark:text-[#777]">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>{t('thinking.tool_executing') || 'Executing...'}</span>
                  </div>
                ) : toolHasContent ? (
                  <CurrentToolRenderer tool={toolItem} />
                ) : (
                  // Tool completed but no content (edge case)
                  <div className="text-xs text-[#888] dark:text-[#777] italic">
                    {t('thinking.no_output') || 'No output'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

/**
 * Get friendly display name for tool
 */
function getToolDisplayName(tool: ToolRendererProps['tool'], t: (key: string) => string): string {
  const toolName = tool.toolName

  // Map tool names to friendly display names
  const displayNames: Record<string, string> = {
    Bash: t('thinking.tools.bash') || 'Execute Command',
    Read: t('thinking.tools.read') || 'Read File',
    Edit: t('thinking.tools.edit') || 'Edit File',
    Write: t('thinking.tools.write') || 'Write File',
    Grep: t('thinking.tools.grep') || 'Search Code',
    Glob: t('thinking.tools.glob') || 'Find Files',
    TodoWrite: t('thinking.tools.todo') || 'Update Tasks',
    knowledge_base_search: t('thinking.tools.kb_search') || 'Search Knowledge Base',
    web_search: t('thinking.tools.web_search') || 'Web Search',
  }

  // Priority 1: If we have a known tool name, use it
  if (displayNames[toolName]) {
    return displayNames[toolName]
  }

  // Priority 2: Use displayName from tool block if available
  if (tool.displayName) {
    return tool.displayName
  }

  return toolName || 'Unknown Tool'
}

/**
 * Get specialized renderer for tool type
 * Returns component that renders tool input/output
 */
function getToolRenderer(
  toolName: string
): React.ComponentType<{ tool: ToolRendererProps['tool'] }> {
  switch (toolName) {
    case 'Bash':
      return BashToolRenderer
    case 'Read':
      return ReadToolRenderer
    case 'Edit':
      return EditToolRenderer
    case 'Write':
      return WriteToolRenderer
    case 'Grep':
      return GrepToolRenderer
    case 'Glob':
      return GlobToolRenderer
    case 'TodoWrite':
      return TodoWriteToolRenderer
    case 'Upload':
      return UploadToolRenderer
    default:
      return GenericToolRenderer
  }
}

export default ToolBlock
