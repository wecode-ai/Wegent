// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import { shouldCollapse, getContentPreview } from '../../utils/thinkingUtils'

/**
 * Write tool renderer
 * Shows file path and content to write
 */
export function WriteToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')
  const [isContentExpanded, setIsContentExpanded] = useState(false)

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  let filePath = input?.file_path as string | undefined
  const content = input?.content as string | undefined

  const outputRaw = (tool.toolResult?.details?.content || tool.toolResult?.details?.output) as
    | string
    | undefined
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  // Try to parse output as JSON (for sandbox tools)
  let output = outputRaw
  let parsedOutput: Record<string, unknown> | null = null

  if (outputRaw && !isError) {
    try {
      parsedOutput = JSON.parse(outputRaw) as Record<string, unknown>
      // Handle sandbox_write_file format
      if (parsedOutput.success && parsedOutput.path) {
        filePath = (parsedOutput.path as string) || filePath
        // For write operations, output is usually just a success message
        output =
          (parsedOutput.message as string) ||
          `File written successfully (${parsedOutput.size || 0} bytes)`
      }
    } catch {
      // Not JSON, use raw output
      output = outputRaw
    }
  }

  const isContentCollapsible = content ? shouldCollapse(content) : false
  const displayContent =
    content && isContentCollapsible && !isContentExpanded ? getContentPreview(content) : content

  return (
    <div className="space-y-3">
      {/* File Path */}
      {filePath && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">File Path</div>
          <div className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono">
            {filePath}
          </div>
        </div>
      )}

      {/* Content to Write */}
      {content && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-medium text-text-secondary">Content</div>
            {isContentCollapsible && (
              <button
                onClick={() => setIsContentExpanded(!isContentExpanded)}
                className="text-xs text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
              >
                {isContentExpanded
                  ? t('thinking.collapse') || 'Collapse'
                  : t('thinking.expand') || 'Expand'}
              </button>
            )}
          </div>
          <pre
            className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono"
            style={{ maxHeight: isContentExpanded ? 'none' : '400px' }}
          >
            {displayContent}
            {isContentCollapsible && !isContentExpanded && (
              <span className="text-blue-400">...</span>
            )}
          </pre>
        </div>
      )}

      {/* Result */}
      {output && (
        <div>
          <div
            className={`text-xs font-medium mb-1 ${
              isError ? 'text-yellow-600' : 'text-text-secondary'
            }`}
          >
            {isError ? t('thinking.tool_error') || 'Error' : 'Result'}
          </div>
          <div
            className={`text-xs p-2 rounded ${
              isError
                ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                : 'text-text-tertiary bg-fill-tert'
            }`}
          >
            {output}
          </div>
        </div>
      )}

      {/* No output yet (streaming) */}
      {!output && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Writing file...'}
        </div>
      )}
    </div>
  )
}

export default WriteToolRenderer
