// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolGroup } from '../types'
import { ToolBlock } from './ToolBlock'

interface ToolBlockGroupProps {
  group: ToolGroup
  defaultExpanded?: boolean
}

/**
 * ToolBlockGroup Component
 *
 * Groups consecutive tool calls into a collapsible accordion.
 */
export const ToolBlockGroup = memo(function ToolBlockGroup({
  group,
  defaultExpanded = true,
}: ToolBlockGroupProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  // Count total tools
  const totalCount = group.tools.length

  return (
    <div className="border border-border rounded-lg bg-surface overflow-hidden mb-3">
      {/* Group Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-fill-tert transition-colors bg-surface/50"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-text-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-text-muted" />
          )}
          <span className="text-sm font-medium text-text-primary">
            {t('thinking.tool_group') || 'Tool Group'} ({totalCount}{' '}
            {t('thinking.tools_count') || 'tools'})
          </span>
        </div>
      </div>

      {/* Tools List */}
      {isExpanded && (
        <div className="p-3 space-y-2 bg-base">
          {group.tools.map(tool => (
            <ToolBlock key={tool.toolUseId} tool={tool} defaultExpanded={false} />
          ))}
        </div>
      )}
    </div>
  )
})

export default ToolBlockGroup
