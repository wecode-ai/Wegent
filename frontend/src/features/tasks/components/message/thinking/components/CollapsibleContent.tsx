// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollapsibleContentProps } from '../types'
import { shouldCollapse, getContentPreview } from '../utils/thinkingUtils'

/**
 * Component to wrap content with collapse/expand functionality
 */
const CollapsibleContent = memo(function CollapsibleContent({
  content,
  maxLines,
  maxLength,
  uniqueId,
  colorClass = 'text-blue-400 hover:text-blue-500 hover:font-semibold',
}: CollapsibleContentProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)

  const isCollapsible = shouldCollapse(content, maxLines, maxLength)
  const displayContent =
    isCollapsible && !isExpanded ? getContentPreview(content, maxLines) : content

  return (
    <div className="text-xs text-text-secondary" data-collapsible-id={uniqueId}>
      {isCollapsible && (
        <div className="flex justify-end mb-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`flex items-center gap-1 transition-colors ${colorClass}`}
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
        </div>
      )}
      <div className="whitespace-pre-wrap">
        {displayContent}
        {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
      </div>
    </div>
  )
})

export default CollapsibleContent
