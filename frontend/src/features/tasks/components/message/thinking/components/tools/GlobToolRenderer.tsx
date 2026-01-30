// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import { shouldCollapse, getContentPreview } from '../../utils/thinkingUtils'

/**
 * Glob tool renderer
 * Shows file pattern and matched files
 */
export function GlobToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')
  const [isResultsExpanded, setIsResultsExpanded] = useState(false)

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  const pattern = input?.pattern as string | undefined
  const path = input?.path as string | undefined

  const outputRaw = (tool.toolResult?.details?.content || tool.toolResult?.details?.output) as
    | string
    | undefined
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  // Try to parse output as JSON (for sandbox tools)
  let parsedOutput: Record<string, unknown> | null = null
  let output = outputRaw
  let fileCount = 0

  if (outputRaw && !isError) {
    try {
      parsedOutput = JSON.parse(outputRaw) as Record<string, unknown>

      // Handle sandbox_list_files format
      if (parsedOutput.success && parsedOutput.entries && Array.isArray(parsedOutput.entries)) {
        fileCount = parsedOutput.entries.length
        // Format as readable list
        output = parsedOutput.entries
          .map((entry: Record<string, unknown>) => {
            const typeIcon = entry.type === 'dir' ? '📁' : '📄'
            const size = entry.size ? ` (${(Number(entry.size) / 1024).toFixed(1)} KB)` : ''
            return `${typeIcon} ${entry.name}${size}`
          })
          .join('\n')
      } else {
        // Keep original output if not recognized format
        output = outputRaw
        const lines = output.trim().split('\n')
        fileCount = lines.filter(line => line.trim()).length
      }
    } catch {
      // Not JSON, try to count lines
      if (outputRaw) {
        const lines = outputRaw.trim().split('\n')
        fileCount = lines.filter(line => line.trim()).length
      }
      output = outputRaw
    }
  }

  const isResultsCollapsible = output ? shouldCollapse(output) : false
  const displayResults =
    output && isResultsCollapsible && !isResultsExpanded ? getContentPreview(output) : output

  return (
    <div className="space-y-3">
      {/* File Pattern or Path */}
      {(pattern || path) && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">
            {pattern ? 'Pattern' : 'Directory'}
          </div>
          <div className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono">
            {pattern || path}
          </div>
        </div>
      )}

      {/* Matched Files */}
      {output && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div
              className={`text-xs font-medium ${
                isError ? 'text-yellow-600' : 'text-text-secondary'
              }`}
            >
              {isError
                ? t('thinking.tool_error') || 'Error'
                : fileCount > 0
                  ? `Files (${fileCount})`
                  : 'Files'}
            </div>
            {isResultsCollapsible && (
              <button
                onClick={() => setIsResultsExpanded(!isResultsExpanded)}
                className="text-xs text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
              >
                {isResultsExpanded
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
            style={{ maxHeight: isResultsExpanded ? 'none' : '300px' }}
          >
            {displayResults}
            {isResultsCollapsible && !isResultsExpanded && (
              <span className="text-blue-400">...</span>
            )}
          </pre>
        </div>
      )}

      {/* No output yet (streaming) */}
      {!output && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Finding files...'}
        </div>
      )}
    </div>
  )
}

export default GlobToolRenderer
