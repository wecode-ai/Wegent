// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import {
  BookOpenIcon,
  CommandLineIcon,
  PencilSquareIcon,
  DocumentPlusIcon,
  MagnifyingGlassIcon,
  FolderIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolBlockProps, ToolRendererProps } from '../types'
import { useToolDetail } from '../contexts/ToolDetailContext'

/**
 * Get icon for tool based on tool name
 */
function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  switch (toolName) {
    case 'Bash':
      return CommandLineIcon
    case 'Read':
      return BookOpenIcon
    case 'Edit':
      return PencilSquareIcon
    case 'Write':
      return DocumentPlusIcon
    case 'Grep':
      return MagnifyingGlassIcon
    case 'Glob':
      return FolderIcon
    default:
      return BookOpenIcon
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
 * ToolBlock Component
 *
 * Displays a single tool execution as a simple clickable pill/tag.
 * Click to display details in the shared detail panel.
 */
export const ToolBlock = memo(function ToolBlock({
  tool,
  defaultExpanded: _defaultExpanded = false,
}: ToolBlockProps) {
  const { t } = useTranslation('chat')
  const { selectedTool, setSelectedTool } = useToolDetail()

  // Get tool icon
  const ToolIcon = getToolIcon(tool.toolName)

  // Get tool display name using previous logic
  const toolDisplayName = getToolDisplayName(tool, t)

  // Check if both input and output are empty
  const hasInput =
    tool.toolUse?.details?.input &&
    (typeof tool.toolUse.details.input === 'string'
      ? tool.toolUse.details.input.length > 0
      : Object.keys(tool.toolUse.details.input).length > 0)
  const hasOutput = tool.toolResult?.details?.output || tool.toolResult?.details?.content
  const hasContent = hasInput || hasOutput
  const isExpandable = hasContent

  // Check if this tool is currently selected
  const isSelected = selectedTool?.toolUseId === tool.toolUseId

  // Handle click - select this tool for detail display
  const handleClick = () => {
    if (isExpandable) {
      // Toggle selection: if already selected, deselect; otherwise select
      setSelectedTool(isSelected ? null : tool)
    }
  }

  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors ${
        isSelected
          ? 'bg-hover text-text-primary'
          : 'bg-muted text-text-secondary hover:bg-hover'
      } ${isExpandable ? 'cursor-pointer' : 'cursor-default'}`}
      onClick={handleClick}
      disabled={!isExpandable}
    >
      <ToolIcon className="h-4 w-4" />
      <span className="font-normal">{toolDisplayName}</span>
    </button>
  )
})

export default ToolBlock
