// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupItem - A single group item in the sidebar.
 *
 * Displays group name, icon, KB count, and navigation arrow.
 */

'use client'

import { User, Users, Building2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export type GroupType = 'personal' | 'group' | 'organization'

export interface GroupItemProps {
  /** Group ID */
  id: string
  /** Group type */
  type: GroupType
  /** Display name */
  displayName: string
  /** Knowledge base count */
  kbCount: number
  /** Whether this group is selected */
  isSelected: boolean
  /** Click handler */
  onClick: () => void
}

/**
 * Get icon for group type
 */
function getGroupIcon(type: GroupType) {
  switch (type) {
    case 'personal':
      return <User className="w-4 h-4 text-primary" />
    case 'group':
      return <Users className="w-4 h-4 text-text-secondary" />
    case 'organization':
      return <Building2 className="w-4 h-4 text-text-secondary" />
    default:
      return <Users className="w-4 h-4 text-text-secondary" />
  }
}

export function GroupItem({ id, type, displayName, kbCount, isSelected, onClick }: GroupItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
        isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-text-primary'
      )}
      data-testid={`group-item-${id}`}
    >
      {/* Icon */}
      <span className="flex-shrink-0">{getGroupIcon(type)}</span>

      {/* Name */}
      <span className="flex-1 text-left truncate text-xs">{displayName}</span>

      {/* KB count */}
      <span className="flex-shrink-0 text-xs text-text-muted tabular-nums">{kbCount}</span>

      {/* Arrow */}
      <ChevronRight className="w-4 h-4 text-text-muted flex-shrink-0" />
    </button>
  )
}

export default GroupItem
