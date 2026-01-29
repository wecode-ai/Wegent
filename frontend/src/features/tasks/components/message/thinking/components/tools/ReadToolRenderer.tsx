// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import { shouldCollapse, getContentPreview } from '../../utils/thinkingUtils'

/**
 * Read tool renderer
 * Shows file path and content preview
 */
export function ReadToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')
  const [isContentExpanded, setIsContentExpanded] = useState(false)

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  let filePath = input?.file_path as string | undefined
  const offset = input?.offset as number | undefined
  const limit = input?.limit as number | undefined

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
      // Handle sandbox_read_file format
      if (parsedOutput.success && parsedOutput.content) {
        output = parsedOutput.content as string
        filePath = (parsedOutput.path as string) || filePath
      }
    } catch {
      // Not JSON, use raw output
      output = outputRaw
    }
  }

  const isContentCollapsible = output ? shouldCollapse(output) : false
  const displayContent =
    output && isContentCollapsible && !isContentExpanded ? getContentPreview(output) : output

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

      {/* Range Info */}
      {(offset !== undefined || limit !== undefined) && (
        <div className="text-xs text-text-muted">
          {offset !== undefined && `Offset: ${offset}`}
          {offset !== undefined && limit !== undefined && ' | '}
          {limit !== undefined && `Limit: ${limit} lines`}
        </div>
      )}

      {/* File Content */}
      {output && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div
              className={`text-xs font-medium ${
                isError ? 'text-yellow-600' : 'text-text-secondary'
              }`}
            >
              {isError ? t('thinking.tool_error') || 'Error' : 'File Content'}
            </div>
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
            className={`text-xs p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono ${
              isError
                ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                : 'text-text-tertiary bg-fill-tert'
            }`}
            style={{ maxHeight: isContentExpanded ? 'none' : '400px' }}
          >
            {displayContent}
            {isContentCollapsible && !isContentExpanded && (
              <span className="text-blue-400">...</span>
            )}
          </pre>
        </div>
      )}

      {/* No output yet (streaming) */}
      {!output && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Reading file...'}
        </div>
      )}
    </div>
  )
}

export default ReadToolRenderer
