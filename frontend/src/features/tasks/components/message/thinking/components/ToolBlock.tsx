// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState } from 'react'
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

  // Get specialized renderer
  const ToolRenderer = getToolRenderer(tool.toolName)

  return (
    <div className="border border-border rounded-lg bg-surface overflow-hidden mb-2">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-fill-tert transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-4 w-4 ${statusColor}`} />
          <span className="text-sm font-medium text-text-primary">{toolDisplayName}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Expand/collapse icon */}
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-text-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-text-muted" />
          )}
        </div>
      </div>

      {/* Content (Specialized Renderer) */}
      {isExpanded && (
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

  // If we have a known tool name, use it
  if (displayNames[toolName]) {
    return displayNames[toolName]
  }

  // For unknown tools, try to extract from title
  if (tool.toolUse.title && typeof tool.toolUse.title === 'string') {
    // Remove common prefixes like "正在", "使用", etc.
    const cleanTitle = tool.toolUse.title.replace(/^(正在|使用|调用)/, '').trim()
    if (cleanTitle && cleanTitle !== 'unknown') {
      return cleanTitle
    }
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
    default:
      return GenericToolRenderer
  }
}

export default ToolBlock
