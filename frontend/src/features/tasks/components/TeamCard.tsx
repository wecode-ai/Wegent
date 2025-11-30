// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Star } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Team } from '@/types/api';

interface TeamCardProps {
  team: Team;
  onSelect: (team: Team) => void;
  onToggleFavorite: (team: Team) => void;
  isTogglingFavorite?: boolean;
}

export default function TeamCard({
  team,
  onSelect,
  onToggleFavorite,
  isTogglingFavorite = false,
}: TeamCardProps) {
  // Get the icon component dynamically
  const IconComponent = team.icon
    ? (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[
        team.icon
      ]
    : null;

  // Get first letter for default avatar
  const firstLetter = team.name.trim().charAt(0).toUpperCase() || 'T';

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isTogglingFavorite) {
      onToggleFavorite(team);
    }
  };

  return (
    <div
      className={cn(
        'group relative bg-surface rounded-lg border border-border p-4 cursor-pointer',
        'hover:shadow-md hover:border-primary/30 transition-all duration-200',
        'flex flex-col gap-3'
      )}
      onClick={() => onSelect(team)}
    >
      {/* Header: Icon + Name + Favorite */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Team Icon/Avatar */}
          <div
            className={cn(
              'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
              'bg-primary/10 text-primary'
            )}
          >
            {IconComponent ? (
              <IconComponent className="w-5 h-5" />
            ) : (
              <span className="text-lg font-semibold">{firstLetter}</span>
            )}
          </div>

          {/* Team Name */}
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-medium text-text-primary truncate">{team.name}</h3>
            {team.user?.user_name && team.share_status === 2 && (
              <p className="text-xs text-text-muted truncate">by {team.user.user_name}</p>
            )}
          </div>
        </div>

        {/* Favorite Button */}
        <button
          onClick={handleFavoriteClick}
          disabled={isTogglingFavorite}
          className={cn(
            'flex-shrink-0 p-1.5 rounded-md transition-colors',
            'hover:bg-primary/10',
            isTogglingFavorite && 'opacity-50 cursor-not-allowed'
          )}
          title={team.is_favorited ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star
            className={cn(
              'w-4 h-4 transition-colors',
              team.is_favorited
                ? 'fill-primary text-primary'
                : 'text-text-muted group-hover:text-primary'
            )}
          />
        </button>
      </div>

      {/* Agent Type Badge */}
      {team.agent_type && (
        <div className="flex items-center gap-1">
          <span className={cn('px-2 py-0.5 text-xs rounded-md', 'bg-muted text-text-secondary')}>
            {team.agent_type}
          </span>
        </div>
      )}
    </div>
  );
}
