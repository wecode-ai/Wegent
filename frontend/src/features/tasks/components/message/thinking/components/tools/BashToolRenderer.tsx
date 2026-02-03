// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import { shouldCollapse, getContentPreview } from '../../utils/thinkingUtils'

/**
 * Bash tool renderer
 * Shows command and output with syntax highlighting
 */
export function BashToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')
  const [isOutputExpanded, setIsOutputExpanded] = useState(false)

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  const command = input?.command as string | undefined
  const description = input?.description as string | undefined

  const output = (tool.toolResult?.details?.content || tool.toolResult?.details?.output) as
    | string
    | undefined
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  const isOutputCollapsible = output ? shouldCollapse(output) : false
  const displayOutput =
    output && isOutputCollapsible && !isOutputExpanded ? getContentPreview(output) : output

  return (
    <div className="space-y-3">
      {/* Description */}
      {description && <div className="text-xs text-text-secondary italic mb-1">{description}</div>}

      {/* Command */}
      {command && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">
            {t('thinking.tool_input') || 'Command'}
          </div>
          <pre className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono">
            <code>{command}</code>
          </pre>
        </div>
      )}

      {/* Output */}
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
                : t('thinking.tool_output') || 'Output'}
            </div>
            {isOutputCollapsible && (
              <button
                onClick={() => setIsOutputExpanded(!isOutputExpanded)}
                className="text-xs text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
              >
                {isOutputExpanded
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
            style={{ maxHeight: isOutputExpanded ? 'none' : '300px' }}
          >
            {displayOutput}
            {isOutputCollapsible && !isOutputExpanded && <span className="text-blue-400">...</span>}
          </pre>
        </div>
      )}

      {/* No output yet (streaming) */}
      {!output && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Executing...'}
        </div>
      )}
    </div>
  )
}

export default BashToolRenderer
