// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TeamSelector Component
 *
 * A simple component for displaying and selecting teams.
 * Handles:
 * 1. Team filtering by bind_mode (chat/code)
 * 2. Syncing team from task detail (with URL matching to prevent race conditions)
 * 3. Restoring from localStorage for new chats
 * 4. Mobile/Desktop responsive rendering
 */

'use client'

import React, { useEffect, useMemo, useRef } from 'react'
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select'
import { Tag } from '@/components/ui/tag'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { useRouter, useSearchParams } from 'next/navigation'
import { Team, TaskDetail } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { paths } from '@/config/paths'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import { cn } from '@/lib/utils'
import MobileTeamSelector from './MobileTeamSelector'
import { getLastTeamIdByMode, saveLastTeamByMode } from '@/utils/userPreferences'

interface TeamSelectorProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  isLoading?: boolean
  // Optional: pass task detail directly
  taskDetail?: TaskDetail | null
  // Optional: hide the settings footer link
  hideSettingsLink?: boolean
  // Optional: current mode for filtering teams by bind_mode
  currentMode?: 'chat' | 'code'
  // Optional: whether to open the dropdown by default
  defaultOpen?: boolean
}

export default function TeamSelector({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  isLoading,
  taskDetail,
  hideSettingsLink = false,
  currentMode = 'chat',
  defaultOpen = false,
}: TeamSelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const sharedBadgeStyle = useMemo(() => getSharedBadgeStyle(), [])

  // Get taskId from URL
  const taskIdFromUrl =
    searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')

  // Track if we've initialized from localStorage
  const hasInitializedRef = useRef(false)
  // Track the last synced task ID to avoid re-syncing
  const lastSyncedTaskIdRef = useRef<number | null>(null)

  // Filter teams by bind_mode based on current mode
  const filteredTeams = useMemo(() => {
    // First filter out teams with empty bind_mode array
    const teamsWithValidBindMode = teams.filter(team => {
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
      return true
    })

    return teamsWithValidBindMode.filter(team => {
      // If bind_mode is not set (undefined/null), show in all modes
      if (!team.bind_mode) return true
      // Otherwise, only show if current mode is in bind_mode
      return team.bind_mode.includes(currentMode)
    })
  }, [teams, currentMode])

  // Main selection logic
  useEffect(() => {
    if (filteredTeams.length === 0) {
      if (selectedTeam !== null) {
        setSelectedTeam(null)
      }
      return
    }

    // Extract team ID from task detail
    const detailTeamId = taskDetail?.team
      ? typeof taskDetail.team === 'number'
        ? taskDetail.team
        : (taskDetail.team as Team).id
      : null

    // -----------------------------------------------------------------------
    // Case 1: Sync from task detail (HIGHEST PRIORITY)
    // Only sync when URL taskId matches taskDetail.id to prevent race conditions
    // -----------------------------------------------------------------------
    if (taskIdFromUrl && taskDetail?.id && detailTeamId) {
      // Check if URL and taskDetail are in sync
      if (taskDetail.id.toString() === taskIdFromUrl) {
        // Only update if we haven't synced this task yet or team is different
        if (lastSyncedTaskIdRef.current !== taskDetail.id || selectedTeam?.id !== detailTeamId) {
          const teamFromDetail = filteredTeams.find(t => t.id === detailTeamId)
          if (teamFromDetail) {
            console.log('[TeamSelector] Syncing team from task detail:', teamFromDetail.name)
            setSelectedTeam(teamFromDetail)
            lastSyncedTaskIdRef.current = taskDetail.id
            hasInitializedRef.current = true
            return
          } else {
            // Team not in filtered list, try to use the team object from detail
            const teamObject =
              typeof taskDetail.team === 'object' ? (taskDetail.team as Team) : null
            if (teamObject) {
              console.log('[TeamSelector] Using team object from detail:', teamObject.name)
              setSelectedTeam(teamObject)
              lastSyncedTaskIdRef.current = taskDetail.id
              hasInitializedRef.current = true
              return
            }
          }
        } else {
          // Already synced this task, skip
          return
        }
      } else {
        // URL and taskDetail don't match - wait for correct taskDetail to load
        console.log('[TeamSelector] Waiting for taskDetail to match URL', {
          taskIdFromUrl,
          taskDetailId: taskDetail.id,
        })
        return
      }
    }

    // -----------------------------------------------------------------------
    // Case 2: New chat (no taskId in URL) - restore from localStorage
    // -----------------------------------------------------------------------
    if (!taskIdFromUrl && !hasInitializedRef.current) {
      const lastTeamId = getLastTeamIdByMode(currentMode)
      if (lastTeamId) {
        const lastTeam = filteredTeams.find(t => t.id === lastTeamId)
        if (lastTeam) {
          console.log('[TeamSelector] Restoring team from localStorage:', lastTeam.name)
          setSelectedTeam(lastTeam)
          hasInitializedRef.current = true
          lastSyncedTaskIdRef.current = null
          return
        }
      }
      // No saved preference or team not found, select first team
      console.log('[TeamSelector] Selecting first team:', filteredTeams[0].name)
      setSelectedTeam(filteredTeams[0])
      hasInitializedRef.current = true
      lastSyncedTaskIdRef.current = null
      return
    }

    // -----------------------------------------------------------------------
    // Case 3: Validate current selection exists in filtered list
    // -----------------------------------------------------------------------
    if (selectedTeam) {
      const exists = filteredTeams.some(t => t.id === selectedTeam.id)
      if (!exists) {
        console.log('[TeamSelector] Current team not in filtered list, selecting first')
        setSelectedTeam(filteredTeams[0])
      }
    } else if (!taskIdFromUrl) {
      // No selection and no task - select first team
      console.log('[TeamSelector] No selection, selecting first team')
      setSelectedTeam(filteredTeams[0])
    }
  }, [filteredTeams, taskDetail, taskIdFromUrl, selectedTeam, setSelectedTeam, currentMode])

  // Reset initialization when switching from task to new chat
  useEffect(() => {
    if (!taskIdFromUrl) {
      lastSyncedTaskIdRef.current = null
    }
  }, [taskIdFromUrl])

  const handleChange = (value: string) => {
    const team = filteredTeams.find(t => t.id === Number(value))
    if (team) {
      setSelectedTeam(team)
      // Save to localStorage when user manually selects
      saveLastTeamByMode(team.id, currentMode)
    }
  }

  // Convert filtered teams to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    return filteredTeams.map(team => {
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
  }, [filteredTeams, t, sharedBadgeStyle])

  if (!selectedTeam || filteredTeams.length === 0) return null

  // Footer for settings link
  const footer = hideSettingsLink ? undefined : (
    <div
      className={cn(
        'border-t border-border bg-base cursor-pointer group',
        'flex items-center space-x-2 text-xs text-text-secondary',
        'hover:bg-muted active:bg-muted transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full',
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
      <span className="font-medium group-hover:text-text-primary">{t('common:teams.manage')}</span>
    </div>
  )

  // Render trigger value
  const renderTriggerValue = (item: SearchableSelectItem | undefined) => {
    if (!item) return null
    const team = filteredTeams.find(t => t.id.toString() === item.value)
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
  }

  return (
    <div
      className="flex items-center space-x-2 min-w-0 flex-shrink"
      data-tour="team-selector"
      style={{ maxWidth: isMobile ? 200 : 260, minWidth: isMobile ? 60 : 80 }}
    >
      {isMobile ? (
        <MobileTeamSelector
          selectedTeam={selectedTeam}
          teams={filteredTeams}
          onTeamSelect={team => {
            setSelectedTeam(team)
            saveLastTeamByMode(team.id, currentMode)
          }}
          disabled={disabled}
          isLoading={isLoading}
        />
      ) : (
        <>
          <TeamIconDisplay
            iconId={selectedTeam?.icon}
            size="xs"
            className={`text-text-muted flex-shrink-0 ml-1 ${isLoading ? 'animate-pulse' : ''}`}
          />
          <div className="relative min-w-0 flex-1">
            <SearchableSelect
              value={selectedTeam?.id.toString()}
              onValueChange={handleChange}
              disabled={disabled || isLoading}
              placeholder={isLoading ? 'Loading...' : t('common:teams.select_team')}
              searchPlaceholder={t('common:teams.search_team')}
              items={selectItems}
              loading={isLoading}
              emptyText={t('common:teams.no_match')}
              noMatchText={t('common:teams.no_match')}
              triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
              contentClassName="max-w-[320px]"
              defaultOpen={defaultOpen}
              renderTriggerValue={renderTriggerValue}
              footer={footer}
            />
          </div>
        </>
      )}
    </div>
  )
}
