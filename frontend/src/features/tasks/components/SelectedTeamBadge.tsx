// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { XMarkIcon } from '@heroicons/react/24/outline';
import type { Team } from '@/types/api';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

  // If no description, just render the badge without popover
  if (!team.description) {
    return badgeContent;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="cursor-pointer">
          {badgeContent}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[300px] p-3 text-sm" side="top" align="start">
        <div className="space-y-1">
          <div className="font-medium text-text-primary">{team.name}</div>
          <div className="text-text-secondary">{team.description}</div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
