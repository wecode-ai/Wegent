// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { XMarkIcon, PencilIcon } from '@heroicons/react/24/outline'
import type { Team } from '@/types/api'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface SelectedTeamBadgeProps {
  team: Team
  onClear?: () => void
  showClearButton?: boolean
  /** Whether to show tooltip on hover. Set to false when used inside another Tooltip to avoid nesting issues. */
  showTooltip?: boolean
  /** Callback when the badge is clicked for editing. Shows pencil icon when provided. */
  onEdit?: () => void
}

/**
 * Badge component to display the currently selected team
 * Shown at the top-left inside the chat input area
 * Figma: rounded-[24px] px-[10px] py-[6px] bg-white text-[#5d5ec9] text-[16px]
 */
export function SelectedTeamBadge({
  team,
  onClear,
  showClearButton = false,
  showTooltip = true,
  onEdit,
}: SelectedTeamBadgeProps) {
  const isEditable = !!onEdit

  const badgeContent = (
    <div
      className={cn(
        'group inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-base text-primary text-base leading-[18px] transition-colors',
        isEditable && 'cursor-pointer hover:bg-primary/10'
      )}
      onClick={isEditable ? onEdit : undefined}
      role={isEditable ? 'button' : undefined}
      tabIndex={isEditable ? 0 : undefined}
      onKeyDown={
        isEditable
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onEdit()
              }
            }
          : undefined
      }
      data-testid="selected-team-badge"
    >
      {/* Team name - shows edit button on hover when editable */}
      {isEditable ? (
        <span className="relative font-medium truncate max-w-[120px]">
          {/* Default text */}
          <span className="group-hover:opacity-0 transition-opacity duration-200">{team.name}</span>
          {/* Edit button overlay - shows on hover */}
          <span className="absolute inset-0 -mx-1 -my-0.5 flex items-center justify-center gap-1 rounded opacity-0 group-hover:opacity-100 transition-all duration-200 text-primary">
            <PencilIcon className="w-3 h-3" />
            <span className="text-xs">编辑</span>
          </span>
        </span>
      ) : (
        <span className="font-medium truncate max-w-[120px]">{team.name}</span>
      )}
      {showClearButton && onClear && (
        <button
          onClick={e => {
            e.stopPropagation()
            onClear()
          }}
          className="ml-0.5 p-0.5 rounded-full hover:bg-primary/10 transition-colors"
          title="Clear selection"
          data-testid="clear-team-button"
        >
          <XMarkIcon className="w-3 h-3" />
        </button>
      )}
    </div>
  )

  // If tooltip is disabled, just return the badge content
  if (!showTooltip) {
    return <div className={isEditable ? undefined : 'cursor-default'}>{badgeContent}</div>
  }

  // Tooltip content: prioritize description (if not empty), fallback to name
  const tooltipText = team.description?.trim() || team.name

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={isEditable ? undefined : 'cursor-default'}>{badgeContent}</div>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-[300px]">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
