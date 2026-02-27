// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useMemo } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolStatus, ToolRendererProps } from '../types'
import { useToolDetail, ToolDetailPanelContentProvider } from '../contexts/ToolDetailContext'
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
 * Get status icon component based on tool status
 */
function getStatusIcon(status: ToolStatus) {
  // Return icon emoji instead of Lucide component for consistency with Workbench
  switch (status) {
    case 'done':
      return '✅'
    case 'error':
      return '⚠️'
    case 'invoking':
    case 'streaming':
    case 'pending':
      return '⏳'
    default:
      return '🔧'
  }
}

/**
 * Get friendly display name for tool
 */
function getToolDisplayName(tool: ToolRendererProps['tool'], t: (key: string) => string): string {
  const toolName = tool.toolName

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

  if (displayNames[toolName]) {
    return displayNames[toolName]
  }

  if (tool.displayName) {
    return tool.displayName
  }

  return toolName || 'Unknown Tool'
}

/**
 * Get specialized renderer for tool type
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

/**
 * Get tool input preview for display
 */
function getToolInputPreview(tool: ToolRendererProps['tool'], maxLength: number = 80): string | null {
  const input = tool.toolUse?.details?.input as Record<string, unknown> | string | undefined
  if (!input) return null

  const toolName = tool.toolName

  const truncate = (text: string) => {
    const cleaned = text.replace(/\s+/g, ' ').trim()
    return cleaned.length <= maxLength ? cleaned : cleaned.substring(0, maxLength - 3) + '...'
  }

  switch (toolName) {
    case 'Bash': {
      const command = typeof input === 'object' ? (input.command as string) : input
      return command ? truncate(command) : null
    }
    case 'Read':
    case 'Write':
    case 'Edit': {
      const filePath = typeof input === 'object' ? (input.file_path as string) : input
      return filePath ? truncate(filePath) : null
    }
    case 'Grep':
    case 'Glob': {
      const pattern = typeof input === 'object' ? (input.pattern as string) : input
      return pattern ? truncate(`"${pattern}"`) : null
    }
    case 'knowledge_base_search':
    case 'web_search': {
      const query = typeof input === 'object' ? (input.query as string) : input
      return query ? truncate(`"${query}"`) : null
    }
    default: {
      if (typeof input === 'string') {
        return truncate(input)
      }
      if (typeof input === 'object') {
        const preview =
          (input.command as string) ||
          (input.query as string) ||
          (input.file_path as string) ||
          (input.path as string) ||
          (input.content as string) ||
          (input.text as string)
        if (preview && typeof preview === 'string') {
          return truncate(preview)
        }
      }
    }
  }

  return null
}

/**
 * ToolDetailPanel Component
 *
 * Displays detailed information for the currently selected tool.
 * Appears below the tool blocks when a tool is selected.
 */
export const ToolDetailPanel = memo(function ToolDetailPanel() {
  const { t } = useTranslation('chat')
  const { selectedTool, setSelectedTool } = useToolDetail()

  // Get tool input preview (must be before early return to follow Hooks rules)
  const inputPreview = useMemo(
    () => (selectedTool ? getToolInputPreview(selectedTool) : null),
    [selectedTool]
  )

  // Early return for no selection
  if (!selectedTool) {
    return null
  }

  // Get tool display name
  const toolDisplayName = getToolDisplayName(selectedTool, t)

  // Get status icon (emoji)
  const statusIcon = getStatusIcon(selectedTool.status)

  // Get specialized renderer
  const ToolRenderer = getToolRenderer(selectedTool.toolName)

  return (
    // Right panel - matches Workbench layout exactly
    <div
      className="transition-all duration-300 ease-in-out bg-surface overflow-hidden"
      style={{ width: '40%' }}
    >
      <div className="h-full flex flex-col border border-border rounded-lg overflow-hidden">
        {/* Header - matches Workbench navigation header style */}
        <nav className="border-b border-border bg-surface">
          <div className="mx-auto px-2 sm:px-3 lg:px-4">
            <div className="flex h-12 justify-between items-center">
              {/* Title with status icon */}
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg">{statusIcon}</span>
                <h3 className="text-sm font-medium text-text-primary truncate">{toolDisplayName}</h3>
              </div>
              {/* Close button - matches Workbench style */}
              <button
                onClick={() => setSelectedTool(null)}
                className="relative rounded-full p-1 text-text-muted hover:text-text-primary focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary"
              >
                <span className="sr-only">Close tool detail</span>
                <XMarkIcon aria-hidden="true" className="size-6" />
              </button>
            </div>
          </div>
        </nav>

        {/* Content - matches Workbench content style */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-2 pt-4 pb-2 sm:px-3 lg:px-4">
            {/* Input preview */}
            {inputPreview && (
              <div className="mb-4 rounded-lg border border-border bg-surface p-4">
                <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
                  Input
                </h4>
                <code className="text-xs text-text-primary bg-muted px-2 py-1 rounded font-mono break-all block">
                  {inputPreview}
                </code>
              </div>
            )}
            {/* Tool content - wrapped in provider to enable auto-expand */}
            <ToolDetailPanelContentProvider>
              <ToolRenderer tool={selectedTool} />
            </ToolDetailPanelContentProvider>
          </div>
        </div>
      </div>
    </div>
  )
})

export default ToolDetailPanel
