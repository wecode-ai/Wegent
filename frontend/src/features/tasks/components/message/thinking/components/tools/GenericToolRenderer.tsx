// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'

/**
 * Generic tool renderer (fallback)
 * Displays tool input and output as JSON
 */
export function GenericToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')

  // Extract input from multiple possible sources
  const inputRaw = tool.toolUse.details?.input
  const input =
    inputRaw && Object.keys(inputRaw).length > 0
      ? typeof inputRaw === 'string'
        ? inputRaw
        : JSON.stringify(inputRaw, null, 2)
      : undefined

  // Extract output from multiple possible sources
  const outputRaw = tool.toolResult?.details?.content || tool.toolResult?.details?.output
  const output = outputRaw
    ? typeof outputRaw === 'string'
      ? outputRaw
      : JSON.stringify(outputRaw, null, 2)
    : undefined

  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  // For Chat shell, use title as display name if no input/output
  const displayTitle = typeof tool.toolUse.title === 'string' ? tool.toolUse.title : undefined
  const completedTitle =
    tool.toolResult && typeof tool.toolResult.title === 'string' ? tool.toolResult.title : undefined

  return (
    <div className="space-y-3">
      {/* Display title from tool_use (Chat shell format) */}
      {displayTitle && !input && (
        <div className="text-xs text-text-secondary italic">{displayTitle}</div>
      )}

      {/* Tool Input */}
      {input && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">
            {t('thinking.tool_input') || 'Input'}
          </div>
          <pre className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
            {input}
          </pre>
        </div>
      )}

      {/* Tool Output or completed title */}
      {(output || completedTitle) && (
        <div>
          <div
            className={`text-xs font-medium mb-1 ${
              isError ? 'text-yellow-600' : 'text-text-secondary'
            }`}
          >
            {isError ? t('thinking.tool_error') || 'Error' : t('thinking.tool_output') || 'Output'}
          </div>
          {output ? (
            <pre
              className={`text-xs p-2 rounded overflow-x-auto whitespace-pre-wrap break-words ${
                isError
                  ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                  : 'text-text-tertiary bg-fill-tert'
              }`}
            >
              {output}
            </pre>
          ) : completedTitle ? (
            <div className="text-xs text-text-tertiary">{completedTitle}</div>
          ) : null}
        </div>
      )}

      {/* No output yet (streaming) */}
      {!output && !completedTitle && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Executing...'}
        </div>
      )}
    </div>
  )
}

export default GenericToolRenderer
