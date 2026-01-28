// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { formatDuration } from '../utils'
import { getToolIcon } from '../constants'
import { SkeletonValue } from './SkeletonValue'

interface ToolHeaderProps {
  toolName: string
  icon?: string
  params?: ReactNode // e.g., file name, URL
  stats?: string // e.g., "125 lines, 4.2KB"
  duration?: number // Duration in ms
  isLoading?: boolean
  isError?: boolean
}

/**
 * Tool header component for displaying tool name and metadata
 */
export const ToolHeader = memo(function ToolHeader({
  toolName,
  icon,
  params,
  stats,
  duration,
  isLoading,
  isError,
}: ToolHeaderProps) {
  const { t } = useTranslation('chat')

  return (
    <div className="flex items-center justify-between w-full gap-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-base flex-shrink-0">{icon || getToolIcon(toolName)}</span>
        <span className="font-medium text-text-primary text-sm flex-shrink-0">{toolName}</span>
        {params && (
          <span className="text-text-secondary text-xs truncate">
            {isLoading ? <SkeletonValue value={null} width="120px" /> : params}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-text-tertiary flex-shrink-0">
        {stats && <span>{stats}</span>}
        {duration !== undefined && duration !== null && <span>{formatDuration(duration)}</span>}
        {isError && (
          <span className={cn('text-red-500')}>{t('thinking.tool_error') || 'Error'}</span>
        )}
      </div>
    </div>
  )
})
