// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, GripVertical, Star } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Tag } from '@/components/ui/tag'
import { cn } from '@/lib/utils'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import type { Team } from '@/types/api'
import SystemTeamTag from './SystemTeamTag'
import { getTeamDisplayName, type SelectableTeam } from './team-selector-utils'

interface TeamSelectorListProps {
  teams: SelectableTeam[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  emptyText: string
  favoriteTeamIdSet: Set<number>
  systemRecommendedTeamIdSet: Set<number>
  quickAccessMetaLoaded: boolean
  favoriteUpdatingTeamId: number | null
  onToggleFavorite: (event: React.MouseEvent, team: Team) => void
  showFavoriteActions?: boolean
  optionTestIdPrefix?: string
  showReorderHandle?: boolean
  canReorder?: boolean
  dragOverTeamId?: number | null
  onTeamDragStart?: (event: React.DragEvent<HTMLElement>, team: SelectableTeam) => void
  onTeamDragOver?: (event: React.DragEvent<HTMLElement>, team: SelectableTeam) => void
  onTeamDragLeave?: () => void
  onTeamDrop?: (event: React.DragEvent<HTMLElement>, team: SelectableTeam) => void
  onTeamDragEnd?: () => void
}

export default function TeamSelectorList({
  teams,
  selectedTeam,
  onTeamSelect,
  emptyText,
  favoriteTeamIdSet,
  systemRecommendedTeamIdSet,
  quickAccessMetaLoaded,
  favoriteUpdatingTeamId,
  onToggleFavorite,
  showFavoriteActions = true,
  optionTestIdPrefix = 'team-option',
  showReorderHandle = false,
  canReorder = false,
  dragOverTeamId,
  onTeamDragStart,
  onTeamDragOver,
  onTeamDragLeave,
  onTeamDrop,
  onTeamDragEnd,
}: TeamSelectorListProps) {
  const { t } = useTranslation('common')
  const sharedBadgeStyle = getSharedBadgeStyle()

  if (teams.length === 0) {
    return <div className="py-4 text-center text-sm text-text-muted">{emptyText}</div>
  }

  return (
    <>
      {teams.map(team => {
        const displayName = getTeamDisplayName(team)
        const isSelected = selectedTeam?.id === team.id
        const isSystemTeam = team.is_system ?? team.user_id === 0
        const isFavorite = favoriteTeamIdSet.has(team.id)
        const isSystemRecommended = systemRecommendedTeamIdSet.has(team.id)
        const isSharedTeam = team.share_status === 2 && team.user?.user_name
        const isGroupTeam =
          team.namespace && team.namespace !== 'default' && team.namespace !== 'community'

        return (
          <div
            key={team.id}
            data-testid={`${optionTestIdPrefix}-${team.name}`}
            className={`flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors ${
              isSelected ? 'bg-primary/10' : 'hover:bg-hover'
            } ${dragOverTeamId === team.id ? 'ring-2 ring-primary/40' : ''}`}
            onClick={() => onTeamSelect(team)}
            onDragOver={event => onTeamDragOver?.(event, team)}
            onDragLeave={onTeamDragLeave}
            onDrop={event => onTeamDrop?.(event, team)}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onTeamSelect(team)
              }
            }}
          >
            {showReorderHandle && (
              <button
                type="button"
                draggable={canReorder}
                data-testid={`quick-access-sort-handle-${team.id}`}
                aria-label={t('teams.reorder_quick_access')}
                title={t('teams.reorder_quick_access')}
                onClick={event => event.stopPropagation()}
                onDragStart={event => {
                  event.stopPropagation()
                  onTeamDragStart?.(event, team)
                }}
                onDragEnd={onTeamDragEnd}
                className="h-7 w-7 flex-shrink-0 rounded-md inline-flex items-center justify-center cursor-grab active:cursor-grabbing text-text-muted hover:bg-hover hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <GripVertical className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                isSelected ? 'bg-primary border-primary text-white' : 'border-border bg-background'
              }`}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-sm text-text-primary truncate flex-1 min-w-0"
                  title={displayName}
                >
                  {displayName}
                </span>
                {isSystemTeam && <SystemTeamTag className="max-w-[120px] truncate" />}
                {isGroupTeam && (
                  <Tag
                    className="text-xs !m-0 flex-shrink-0 max-w-[120px] truncate"
                    variant="info"
                    title={team.namespace}
                  >
                    {team.namespace}
                  </Tag>
                )}
                {isSharedTeam && (
                  <Tag
                    className="text-xs !m-0 flex-shrink-0 max-w-[120px] truncate"
                    variant="default"
                    style={sharedBadgeStyle}
                    title={t('teams.shared_by', { author: team.user?.user_name })}
                  >
                    {t('teams.shared_by', { author: team.user?.user_name })}
                  </Tag>
                )}
              </div>
            </div>
            {showFavoriteActions && quickAccessMetaLoaded && !isSystemRecommended && (
              <button
                type="button"
                data-testid={`favorite-team-button-${team.id}`}
                aria-label={
                  isFavorite ? t('teams.remove_from_quick_access') : t('teams.add_to_quick_access')
                }
                title={
                  isFavorite ? t('teams.remove_from_quick_access') : t('teams.add_to_quick_access')
                }
                disabled={favoriteUpdatingTeamId === team.id}
                onClick={event => onToggleFavorite(event, team)}
                className={cn(
                  'h-7 w-7 flex-shrink-0 rounded-md inline-flex items-center justify-center',
                  'text-text-muted hover:bg-hover hover:text-primary transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  'disabled:pointer-events-none disabled:opacity-50',
                  isFavorite && 'text-primary'
                )}
              >
                <Star className={cn('h-4 w-4', isFavorite && 'fill-current')} aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}
