// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolGroup } from '../types'
import { ToolBlock } from './ToolBlock'
import { isRunningStatus } from '../utils/thinkingUtils'

interface ToolBlockGroupProps {
  group: ToolGroup
  defaultExpanded?: boolean
  taskStatus?: string
}

/**
 * ToolBlockGroup Component
 *
 * Groups consecutive tool calls into a collapsible accordion.
 */
export const ToolBlockGroup = memo(function ToolBlockGroup({
  group,
  defaultExpanded = true,
  taskStatus,
}: ToolBlockGroupProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  // Check if task is still running
  const isRunning = isRunningStatus(taskStatus)

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
            {isRunning || !group.isComplete
              ? t('chat:messages.using_tools') || 'Using Tools'
              : t('chat:messages.used_tools') || 'Used Tools'}{' '}
            ({totalCount} {t('chat:messages.times') || 'times'})
          </span>
        </div>
        {/* Show status badge only when running - pulse animation on text */}
        {(isRunning || !group.isComplete) && (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 text-xs border border-blue-500/20">
            <span className="animate-pulse">{t('thinking.running') || '执行中'}</span>
          </span>
        )}
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
