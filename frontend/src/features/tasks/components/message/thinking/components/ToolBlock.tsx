// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolBlockProps, ToolStatus, ToolRendererProps } from '../types'
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
 * ToolBlock Component
 *
 * Displays a single tool execution as a collapsible block.
 * Routes to specialized renderers based on tool name.
 */
export const ToolBlock = memo(function ToolBlock({
  tool,
  defaultExpanded = false,
}: ToolBlockProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  // Get status icon component
  const StatusIcon = getStatusIcon(tool.status)
  const statusColor = getStatusColor(tool.status)

  // Get tool display name
  const toolDisplayName = getToolDisplayName(tool, t)

  // Get tool input preview for header display
  const inputPreview = useMemo(() => getToolInputPreview(tool), [tool])

  // Get specialized renderer
  const ToolRenderer = getToolRenderer(tool.toolName)

  // Check if this is an upload tool with downloadable attachment
  const isDownloadable = tool.toolName === 'Upload' && tool.status === 'done'

  // Check if both input and output are empty
  const hasInput =
    tool.toolUse?.details?.input &&
    (typeof tool.toolUse.details.input === 'string'
      ? tool.toolUse.details.input.length > 0
      : Object.keys(tool.toolUse.details.input).length > 0)
  const hasOutput = tool.toolResult?.details?.output || tool.toolResult?.details?.content
  const hasContent = hasInput || hasOutput
  const isExpandable = hasContent

  return (
    <div className="border border-border rounded-lg bg-surface overflow-hidden mb-2">
      {/* Header */}
      <div
        className={`flex items-center justify-between px-4 py-3 ${
          isExpandable ? 'cursor-pointer hover:bg-fill-tert' : 'cursor-default'
        } transition-colors`}
        onClick={() => isExpandable && setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusIcon className={`h-4 w-4 flex-shrink-0 ${statusColor}`} />
          <span className="text-sm font-medium text-text-primary flex-shrink-0">
            {toolDisplayName}
          </span>
          {/* Input preview - shown inline after tool name */}
          {inputPreview && (
            <code className="text-xs text-text-muted bg-fill-tert px-1.5 py-0.5 rounded font-mono truncate max-w-[300px]">
              {inputPreview}
            </code>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isDownloadable && (
            <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">
              {t('thinking.downloadable') || 'Downloadable'}
            </span>
          )}
          {/* Expand/collapse icon - only show if there's content to expand */}
          {isExpandable && (
            <>
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-text-muted" />
              ) : (
                <ChevronRight className="h-4 w-4 text-text-muted" />
              )}
            </>
          )}
        </div>
      </div>

      {/* Content (Specialized Renderer) */}
      {isExpanded && isExpandable && (
        <div className="px-4 py-3 border-t border-border bg-base">
          <ToolRenderer tool={tool} />
        </div>
      )}
    </div>
  )
})

/**
 * Get status icon component based on tool status
 */
function getStatusIcon(status: ToolStatus) {
  switch (status) {
    case 'done':
      return CheckCircle2
    case 'error':
      return AlertCircle // Changed from XCircle to AlertCircle for softer warning style
    case 'invoking':
    case 'streaming':
    case 'pending':
      return Loader2
    default:
      return Loader2
  }
}

/**
 * Get status color classes
 */
function getStatusColor(status: ToolStatus): string {
  switch (status) {
    case 'done':
      return 'text-primary'
    case 'error':
      return 'text-yellow-600' // Changed from text-red-500 to yellow for softer warning
    case 'invoking':
    case 'streaming':
    case 'pending':
      return 'text-primary animate-spin'
    default:
      return 'text-text-muted'
  }
}

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
