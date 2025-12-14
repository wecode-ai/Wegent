// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { XMarkIcon } from '@heroicons/react/24/outline';
import type { Team } from '@/types/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay';

interface SelectedTeamBadgeProps {
  team: Team;
  onClear?: () => void;
  showClearButton?: boolean;
}

/**
 * Badge component to display the currently selected team
 * Shown at the top-left inside the chat input area
 */
export function SelectedTeamBadge({
  team,
  onClear,
  showClearButton = false,
}: SelectedTeamBadgeProps) {
  const badgeContent = (
    <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-primary/30 bg-primary/5 text-primary text-xs">
      <TeamIconDisplay iconId={team.icon} size="xs" className="flex-shrink-0" />
      <span className="font-medium truncate max-w-[120px]">{team.name}</span>
      {showClearButton && onClear && (
        <button
          onClick={e => {
            e.stopPropagation();
            onClear();
          }}
          className="ml-0.5 p-0.5 rounded-full hover:bg-primary/10 transition-colors"
          title="Clear selection"
        >
          <XMarkIcon className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );

  // Tooltip content: prioritize description, fallback to name
  const tooltipText = team.description || team.name;

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
  );
}
