// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolResultItemProps } from '../types'
import { shouldCollapse, getContentPreview } from '../utils/thinkingUtils'

/**
 * Component to display a tool execution result
 */
const ToolResultItem = memo(function ToolResultItem({
  content,
  isError = false,
  itemIndex,
}: ToolResultItemProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)

  const resultContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  const isCollapsible = shouldCollapse(resultContent)
  const displayContent =
    isCollapsible && !isExpanded ? getContentPreview(resultContent) : resultContent

  const textClass = isError ? 'text-red-400' : 'text-green-400'
  const buttonClass = isError
    ? 'text-red-400 hover:text-red-500 hover:font-semibold'
    : 'text-green-400 hover:text-green-500 hover:font-semibold'

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between mb-1">
        <div className={`text-xs font-medium ${textClass}`}>
          {isError
            ? t('chat:thinking.tool_error') || 'Tool Error'
            : t('chat:thinking.tool_result') || 'Tool Result'}
        </div>
        {isCollapsible && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`flex items-center gap-1 transition-colors ${buttonClass}`}
          >
            {isExpanded ? (
              <>
                <Minimize2 className="h-3 w-3" />
                <span className="text-xs">{t('chat:thinking.collapse') || 'Collapse'}</span>
              </>
            ) : (
              <>
                <Maximize2 className="h-3 w-3" />
                <span className="text-xs">{t('chat:thinking.expand') || 'Expand'}</span>
              </>
            )}
          </button>
        )}
      </div>
      <pre
        className={`text-xs whitespace-pre-wrap break-words ${
          isError ? 'text-red-400/90' : 'text-text-tertiary'
        }`}
        data-result-index={itemIndex}
      >
        {displayContent}
        {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
      </pre>
    </div>
  )
})

export default ToolResultItem
