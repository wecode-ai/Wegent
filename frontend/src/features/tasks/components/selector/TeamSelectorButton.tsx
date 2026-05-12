// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TeamSelectorButton Component
 *
 * Simplified team selector for chat input controls.
 * Always displays "智能体" label with AgentIcon.
 * Includes quick create functionality with integrated TeamCreationWizard.
 */

'use client'

import React, { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { SparklesIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { ActionButton } from '@/components/ui/action-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { AgentIcon } from '@/components/icons/AgentIcon'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team, TaskDetail, TaskType } from '@/types/api'
import TeamCreationWizard from '@/features/settings/components/wizard/TeamCreationWizard'
import TeamSelectorList from './TeamSelectorList'
import { TEAM_SELECTOR_POPOVER_CLASS_NAME } from './team-selector-popover'
import { filterTeamsByMode, getTeamDisplayName } from './team-selector-utils'
import { useTeamFavorites } from './useTeamFavorites'

interface TeamSelectorButtonProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  taskDetail?: TaskDetail | null
  hideSettingsLink?: boolean
  /** Current mode for filtering teams by bind_mode */
  currentMode?: TaskType
  /** Callback to refresh teams list after creation */
  onTeamsRefresh?: () => Promise<void>
}

export default function TeamSelectorButton({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  hideSettingsLink = false,
  currentMode = 'chat',
  onTeamsRefresh,
}: TeamSelectorButtonProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const {
    favoriteTeamIdSet,
    favoriteUpdatingTeamId,
    handleToggleFavorite,
    quickAccessMetaLoaded,
    systemRecommendedTeamIdSet,
  } = useTeamFavorites()

  // Filter teams by bind_mode based on current mode
  const filteredTeamsByMode = useMemo(
    () => filterTeamsByMode(teams, currentMode),
    [teams, currentMode]
  )

  // Filter teams by search query
  const filteredTeams = filteredTeamsByMode.filter(team => {
    const normalizedSearch = searchQuery.toLowerCase()
    return (
      team.name.toLowerCase().includes(normalizedSearch) ||
      getTeamDisplayName(team).toLowerCase().includes(normalizedSearch)
    )
  })

  const handleSelectTeam = (team: Team) => {
    setSelectedTeam(team)
    setOpen(false)
    setSearchQuery('')
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (disabled) return
    setOpen(newOpen)
    if (!newOpen) {
      setSearchQuery('')
    }
  }

  const handleCreateClick = () => {
    setOpen(false)
    setWizardOpen(true)
  }

  const handleWizardSuccess = async (teamId: number, _teamName: string) => {
    setWizardOpen(false)
    // Refresh teams list
    if (onTeamsRefresh) {
      await onTeamsRefresh()
    }
    // Find and select the newly created team
    const newTeam = teams.find(t => t.id === teamId)
    if (newTeam) {
      setSelectedTeam(newTeam)
    }
  }

  if (!selectedTeam || teams.length === 0) return null

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div data-testid="team-selector">
                <ActionButton
                  onClick={() => setOpen(!open)}
                  disabled={disabled}
                  icon={<AgentIcon className="h-4 w-4" />}
                  label={t('common:teamSelector.agent_label', '智能体')}
                />
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">{t('common:teamSelector.select_agent_tooltip', '选择智能体')}</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="start" side="top" className={TEAM_SELECTOR_POPOVER_CLASS_NAME}>
          <div className="px-2 pb-2 text-sm font-medium text-text-primary">
            {t('common:teams.select_team')}
          </div>

          {/* Search input */}
          <div className="px-2 pb-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('common:teams.search_team')}
                className="h-8 pl-7 text-sm"
              />
            </div>
          </div>

          {/* Teams list */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <TeamSelectorList
              teams={filteredTeams}
              selectedTeam={selectedTeam}
              onTeamSelect={handleSelectTeam}
              emptyText={t('common:teams.no_match')}
              favoriteTeamIdSet={favoriteTeamIdSet}
              systemRecommendedTeamIdSet={systemRecommendedTeamIdSet}
              quickAccessMetaLoaded={quickAccessMetaLoaded}
              favoriteUpdatingTeamId={favoriteUpdatingTeamId}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>

          {/* Footer with create and settings buttons */}
          {!hideSettingsLink && (
            <div className="border-t border-primary/10 bg-base mt-2 flex items-center gap-1 p-1">
              {/* Quick Create Button - Left */}
              <div
                className={cn(
                  'cursor-pointer group flex-1',
                  'flex items-center justify-center space-x-1.5 text-xs text-text-secondary',
                  'hover:bg-hover active:bg-hover transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  'px-2 py-2 rounded-md'
                )}
                onClick={handleCreateClick}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleCreateClick()
                  }
                }}
              >
                <SparklesIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="font-medium group-hover:text-text-primary">
                  {t('wizard:wizard_button')}
                </span>
              </div>

              {/* Settings Button - Right */}
              <div
                className={cn(
                  'cursor-pointer group flex-1',
                  'flex items-center justify-center space-x-1.5 text-xs text-text-secondary',
                  'hover:bg-hover active:bg-hover transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  'px-2 py-2 rounded-md'
                )}
                onClick={() => {
                  setOpen(false)
                  router.push(paths.settings.team.getHref())
                }}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpen(false)
                    router.push(paths.settings.team.getHref())
                  }
                }}
              >
                <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="font-medium group-hover:text-text-primary">
                  {t('common:teams.manage')}
                </span>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Team Creation Wizard Dialog */}
      <TeamCreationWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onSuccess={handleWizardSuccess}
        scope="personal"
      />
    </TooltipProvider>
  )
}
