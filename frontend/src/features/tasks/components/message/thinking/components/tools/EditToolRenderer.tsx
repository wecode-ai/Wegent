// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import { shouldCollapse, getContentPreview } from '../../utils/thinkingUtils'

/**
 * Edit tool renderer
 * Shows file path, old/new strings, and replace mode
 */
export function EditToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')
  const [isOldExpanded, setIsOldExpanded] = useState(false)
  const [isNewExpanded, setIsNewExpanded] = useState(false)

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  const filePath = input?.file_path as string | undefined
  const oldString = input?.old_string as string | undefined
  const newString = input?.new_string as string | undefined
  const replaceAll = input?.replace_all as boolean | undefined

  const output = (tool.toolResult?.details?.content || tool.toolResult?.details?.output) as
    | string
    | undefined
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  const isOldCollapsible = oldString ? shouldCollapse(oldString) : false
  const isNewCollapsible = newString ? shouldCollapse(newString) : false

  const displayOld =
    oldString && isOldCollapsible && !isOldExpanded ? getContentPreview(oldString) : oldString
  const displayNew =
    newString && isNewCollapsible && !isNewExpanded ? getContentPreview(newString) : newString

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

      {/* Replace Mode */}
      {replaceAll !== undefined && (
        <div className="text-xs text-text-muted">
          Mode: {replaceAll ? 'Replace All' : 'Replace First Match'}
        </div>
      )}

      {/* Old String */}
      {oldString && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-medium text-red-600">Old String</div>
            {isOldCollapsible && (
              <button
                onClick={() => setIsOldExpanded(!isOldExpanded)}
                className="text-xs text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
              >
                {isOldExpanded
                  ? t('thinking.collapse') || 'Collapse'
                  : t('thinking.expand') || 'Expand'}
              </button>
            )}
          </div>
          <pre className="text-xs p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono bg-red-50 border border-red-200 text-red-700">
            {displayOld}
            {isOldCollapsible && !isOldExpanded && <span className="text-blue-400">...</span>}
          </pre>
        </div>
      )}

      {/* New String */}
      {newString && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-medium text-green-600">New String</div>
            {isNewCollapsible && (
              <button
                onClick={() => setIsNewExpanded(!isNewExpanded)}
                className="text-xs text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
              >
                {isNewExpanded
                  ? t('thinking.collapse') || 'Collapse'
                  : t('thinking.expand') || 'Expand'}
              </button>
            )}
          </div>
          <pre className="text-xs p-2 rounded overflow-x-auto whitespace-pre-wrap break-words font-mono bg-green-50 border border-green-200 text-green-700">
            {displayNew}
            {isNewCollapsible && !isNewExpanded && <span className="text-blue-400">...</span>}
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
          {t('thinking.tool_executing') || 'Editing file...'}
        </div>
      )}
    </div>
  )
}

export default EditToolRenderer
