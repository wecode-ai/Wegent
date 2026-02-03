// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import { shouldCollapse, getContentPreview } from '../../utils/thinkingUtils'

/**
 * Grep tool renderer
 * Shows search pattern and results
 */
export function GrepToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')
  const [isResultsExpanded, setIsResultsExpanded] = useState(false)

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  const pattern = input?.pattern as string | undefined
  const path = input?.path as string | undefined
  const glob = input?.glob as string | undefined
  const outputMode = input?.output_mode as string | undefined

  const output = (tool.toolResult?.details?.content || tool.toolResult?.details?.output) as
    | string
    | undefined
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  const isResultsCollapsible = output ? shouldCollapse(output) : false
  const displayResults =
    output && isResultsCollapsible && !isResultsExpanded ? getContentPreview(output) : output

  return (
    <div className="space-y-3">
      {/* Search Pattern */}
      {pattern && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">Search Pattern</div>
          <div className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono">
            {pattern}
          </div>
        </div>
      )}

      {/* Search Parameters */}
      <div className="text-xs text-text-muted space-y-0.5">
        {path && <div>Path: {path}</div>}
        {glob && <div>Glob: {glob}</div>}
        {outputMode && <div>Mode: {outputMode}</div>}
      </div>

      {/* Search Results */}
      {output && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div
              className={`text-xs font-medium ${
                isError ? 'text-yellow-600' : 'text-text-secondary'
              }`}
            >
              {isError ? t('thinking.tool_error') || 'Error' : 'Search Results'}
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
            style={{ maxHeight: isResultsExpanded ? 'none' : '400px' }}
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
          {t('thinking.tool_executing') || 'Searching...'}
        </div>
      )}
    </div>
  )
}

export default GrepToolRenderer
