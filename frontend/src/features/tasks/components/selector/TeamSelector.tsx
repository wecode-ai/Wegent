// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TeamSelector Component
 *
 * A component for displaying and selecting teams.
 * Supports two usage patterns:
 *
 * 1. Legacy mode (backward compatible): Pass selectedTeam, setSelectedTeam, etc.
 *    The component will use useTeamSelection hook internally.
 *
 * 2. New mode: Use useTeamSelection hook externally and pass the returned values.
 *
 * This design allows gradual migration from the old API to the new API.
 */

'use client'

import React, { useEffect, useMemo } from 'react'
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select'
import { Tag } from '@/components/ui/tag'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { useRouter } from 'next/navigation'
import { Team, TaskDetail } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { paths } from '@/config/paths'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import { cn } from '@/lib/utils'
import MobileTeamSelector from './MobileTeamSelector'
import { useTeamSelection } from '@/features/tasks/hooks/useTeamSelection'

// Re-export hook for convenience
export { useTeamSelection } from '@/features/tasks/hooks/useTeamSelection'
export type {
  UseTeamSelectionOptions,
  UseTeamSelectionReturn,
} from '@/features/tasks/hooks/useTeamSelection'

interface TeamSelectorProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  isLoading?: boolean
  // Optional: pass task detail directly instead of using context
  taskDetail?: TaskDetail | null
  // Optional: whether there are messages (for preference restoration logic)
  hasMessages?: boolean
  // Optional: hide the settings footer link
  hideSettingsLink?: boolean
  // Optional: current mode for filtering teams by bind_mode
  currentMode?: 'chat' | 'code'
  // Optional: whether to open the dropdown by default
  defaultOpen?: boolean
  // Optional: clear version from chat stream context (for "New Chat" detection)
  clearVersion?: number
}

export default function TeamSelector({
  selectedTeam: externalSelectedTeam,
  setSelectedTeam: externalSetSelectedTeam,
  teams,
  disabled,
  isLoading: externalLoading,
  taskDetail,
  hasMessages = false,
  hideSettingsLink = false,
  currentMode = 'chat',
  defaultOpen = false,
  clearVersion = 0,
}: TeamSelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const sharedBadgeStyle = useMemo(() => getSharedBadgeStyle(), [])

  // Use the centralized team selection hook
  const teamSelection = useTeamSelection({
    teams,
    currentMode,
    selectedTaskDetail: taskDetail ?? null,
    hasMessages,
    disabled,
    clearVersion,
  })

  // Sync external state with internal hook state
  // This allows the component to work with both legacy and new APIs
  useEffect(() => {
    if (teamSelection.selectedTeam !== externalSelectedTeam) {
      if (teamSelection.selectedTeam) {
        externalSetSelectedTeam(teamSelection.selectedTeam)
      }
    } else if (externalSelectedTeam && teamSelection.selectedTeam?.id !== externalSelectedTeam.id) {
      // External state changed (e.g., from QuickAccessCards)
      // Treat this as a user selection (isUserAction = true)
      teamSelection.selectTeam(externalSelectedTeam, true)
    }
  }, [teamSelection.selectedTeam, teamSelection.selectTeam, externalSelectedTeam, externalSetSelectedTeam])

  const handleChange = (value: string) => {
    const team = teamSelection.filteredTeams.find(t => t.id === Number(value))
    if (team) {
      teamSelection.selectTeam(team)
    }
  }

  // Convert filtered teams to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    return teamSelection.filteredTeams.map(team => {
      const isSharedTeam = team.share_status === 2 && team.user?.user_name
      const isGroupTeam = team.namespace && team.namespace !== 'default'
      return {
        value: team.id.toString(),
        label: team.name,
        searchText: team.name,
        content: (
          <div className="flex items-center gap-2 min-w-0">
            <TeamIconDisplay
              iconId={team.icon}
              size="sm"
              className="flex-shrink-0 text-text-muted"
            />
            <span
              className="font-medium text-xs text-text-secondary truncate flex-1 min-w-0"
              title={team.name}
            >
              {team.name}
            </span>
            {isGroupTeam && (
              <Tag className="ml-2 text-xs !m-0 flex-shrink-0" variant="info">
                {team.namespace}
              </Tag>
            )}
            {isSharedTeam && (
              <Tag
                className="ml-2 text-xs !m-0 flex-shrink-0"
                variant="default"
                style={sharedBadgeStyle}
              >
                {t('common:teams.shared_by', { author: team.user?.user_name })}
              </Tag>
            )}
          </div>
        ),
      }
    })
  }, [teamSelection.filteredTeams, t, sharedBadgeStyle])

  if (!teamSelection.selectedTeam || teamSelection.filteredTeams.length === 0) return null

  // Common props for both mobile and desktop versions
  const selectProps = {
    value: teamSelection.selectedTeam?.id.toString(),
    onValueChange: handleChange,
    disabled: disabled || externalLoading || teamSelection.isLoading,
    placeholder: externalLoading ? 'Loading...' : t('common:teams.select_team'),
    searchPlaceholder: t('common:teams.search_team'),
    items: selectItems,
    loading: externalLoading || teamSelection.isLoading,
    emptyText: t('common:teams.no_match'),
    noMatchText: t('common:teams.no_match'),
    defaultOpen,
    renderTriggerValue: (item: SearchableSelectItem | undefined) => {
      if (!item) return null
      const team = teamSelection.filteredTeams.find(t => t.id.toString() === item.value)
      const isSharedTeam = team?.share_status === 2 && team?.user?.user_name
      const isGroupTeam = team?.namespace && team.namespace !== 'default'
      return (
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate max-w-full flex-1 min-w-0" title={item.label}>
            {item.label}
          </span>
          {isGroupTeam && (
            <Tag className="text-xs !m-0 flex-shrink-0 ml-2" variant="info">
              {team.namespace}
            </Tag>
          )}
          {isSharedTeam && (
            <Tag
              className="text-xs !m-0 flex-shrink-0 ml-2"
              variant="default"
              style={sharedBadgeStyle}
            >
              {team.user?.user_name}
            </Tag>
          )}
        </div>
      )
    },
    footer: hideSettingsLink ? undefined : (
      <div
        className={cn(
          'border-t border-border bg-base cursor-pointer group',
          'flex items-center space-x-2 text-xs text-text-secondary',
          'hover:bg-muted active:bg-muted transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full',
          // Touch-friendly sizing on mobile
          isMobile ? 'px-4 py-3 min-h-[44px]' : 'px-2.5 py-2'
        )}
        onClick={() => router.push(paths.settings.team.getHref())}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            router.push(paths.settings.team.getHref())
          }
        }}
      >
        <Cog6ToothIcon
          className={cn(
            'text-text-secondary group-hover:text-text-primary',
            isMobile ? 'w-5 h-5' : 'w-4 h-4'
          )}
        />
        <span className="font-medium group-hover:text-text-primary">
          {t('common:teams.manage')}
        </span>
      </div>
    ),
  }

  return (
    <div
      className="flex items-center space-x-2 min-w-0 flex-shrink"
      data-tour="team-selector"
      style={{ maxWidth: isMobile ? 200 : 260, minWidth: isMobile ? 60 : 80 }}
    >
      {isMobile ? (
        // Mobile: Use iOS-style drawer selector (similar to MobileModelSelector)
        <MobileTeamSelector
          selectedTeam={teamSelection.selectedTeam}
          teams={teamSelection.filteredTeams}
          onTeamSelect={team => teamSelection.selectTeam(team)}
          disabled={disabled}
          isLoading={externalLoading || teamSelection.isLoading}
        />
      ) : (
        // Desktop: Use original dropdown with icon
        <>
          <TeamIconDisplay
            iconId={teamSelection.selectedTeam?.icon}
            size="xs"
            className={`text-text-muted flex-shrink-0 ml-1 ${externalLoading || teamSelection.isLoading ? 'animate-pulse' : ''}`}
          />
          <div className="relative min-w-0 flex-1">
            <SearchableSelect
              {...selectProps}
              triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
              contentClassName="max-w-[320px]"
            />
          </div>
        </>
      )}
    </div>
  )
}
