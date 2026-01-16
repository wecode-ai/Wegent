// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { XMarkIcon } from '@heroicons/react/24/outline'
import type { Team } from '@/types/api'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface SelectedTeamBadgeProps {
  team: Team
  onClear?: () => void
  showClearButton?: boolean
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
}: SelectedTeamBadgeProps) {
  const badgeContent = (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-base text-primary text-base leading-[18px]">
      <span className="font-medium truncate max-w-[120px]">{team.name}</span>
      {showClearButton && onClear && (
        <button
          onClick={e => {
            e.stopPropagation()
            onClear()
          }}
          className="ml-0.5 p-0.5 rounded-full hover:bg-primary/10 transition-colors"
          title="Clear selection"
        >
          <XMarkIcon className="w-3 h-3" />
        </button>
      )}
    </div>
  )

  // Tooltip content: prioritize description, fallback to name
  const tooltipText = team.description || team.name

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-default">{badgeContent}</div>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-[300px]">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
