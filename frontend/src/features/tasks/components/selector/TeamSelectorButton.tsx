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
import { useRouter } from 'next/navigation'
import { Cog6ToothIcon, SparklesIcon, Squares2X2Icon } from '@heroicons/react/24/outline'
import { ActionButton } from '@/components/ui/action-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/icons/AgentIcon'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team, TaskDetail } from '@/types/api'
import TeamCreationWizard from '@/features/settings/components/wizard/TeamCreationWizard'
import TeamSelectorList from './TeamSelectorList'
import { TEAM_SELECTOR_POPOVER_CLASS_NAME } from './team-selector-popover'
import {
  buildTeamTargetHref,
  filterTeamsByMode,
  getRecentTeams,
  getTeamDisplayName,
  getTeamTargetPage,
} from './team-selector-utils'
import type { TeamModeFilter } from './team-selector-utils'
import { useTeamFavorites } from './useTeamFavorites'
import { useRecentTeams } from './useRecentTeams'
import { getCurrentTargetPageByMode } from '../chat/quick-launch/launch-intent'

interface TeamSelectorButtonProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  taskDetail?: TaskDetail | null
  hideSettingsLink?: boolean
  /** Current mode for filtering teams by bind_mode */
  currentMode?: TeamModeFilter
  /** Callback to refresh teams list after creation */
  onTeamsRefresh?: () => Promise<void>
  /** Render style for the selector trigger */
  triggerVariant?: 'button' | 'menu-item'
  /** Render the default trigger as an icon-only action */
  iconOnly?: boolean
  /** Optional test id for the selector trigger */
  triggerTestId?: string
}

export default function TeamSelectorButton({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  hideSettingsLink = false,
  currentMode = 'chat',
  onTeamsRefresh,
  triggerVariant = 'button',
  iconOnly = false,
  triggerTestId = 'team-selector',
}: TeamSelectorButtonProps) {
  const { t } = useTranslation('tasks')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const {
    favoriteTeamIdSet,
    favoriteUpdatingTeamId,
    handleToggleFavorite,
    quickAccessMetaLoaded,
    systemRecommendedTeamIdSet,
  } = useTeamFavorites()
  const { recentTeamIds, refreshRecentTeams } = useRecentTeams(currentMode)

  const recentTeamCandidates = useMemo(
    () =>
      currentMode === 'code'
        ? filterTeamsByMode(teams, 'code')
        : filterTeamsByMode(teams, 'all').filter(
            team => !team.bind_mode || team.bind_mode.some(mode => mode !== 'code')
          ),
    [teams, currentMode]
  )

  const recentTeams = useMemo(
    () => getRecentTeams(recentTeamCandidates, recentTeamIds),
    [recentTeamCandidates, recentTeamIds]
  )

  const handleSelectTeam = (team: Team) => {
    const targetPage = getTeamTargetPage(team, 'all')
    const currentPage = getCurrentTargetPageByMode(currentMode)
    if (targetPage !== currentPage) {
      router.push(buildTeamTargetHref(targetPage, new URLSearchParams({ teamId: String(team.id) })))
      setOpen(false)
      return
    }
    setSelectedTeam(team)
    setOpen(false)
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (disabled) return
    setOpen(newOpen)
    if (newOpen) {
      void refreshRecentTeams()
    }
  }

  const handleCreateClick = () => {
    setOpen(false)
    setWizardOpen(true)
  }

  const handleUseMoreAgents = () => {
    setOpen(false)
    router.push(`${paths.resourceLibrary.getHref()}?tab=mine&type=agent&from=chat`)
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

  const popoverContent = (
    <PopoverContent align="start" side="top" className={TEAM_SELECTOR_POPOVER_CLASS_NAME}>
      <div className="px-2 pb-2 text-sm font-medium text-text-primary">
        {t('common:teams.select_team')}
      </div>

      {/* Teams list */}
      <div className="px-2 pb-1 text-xs font-medium text-text-muted">
        {t('common:teams.recently_used')}
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <TeamSelectorList
          teams={recentTeams}
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

      <button
        type="button"
        data-testid="team-selector-use-more-agents"
        onClick={handleUseMoreAgents}
        className={cn(
          'border-t border-primary/10 bg-base mt-2 w-full',
          'flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium',
          'text-primary hover:bg-hover active:bg-hover transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
        )}
      >
        <Squares2X2Icon className="h-4 w-4" />
        <span>{t('common:teams.use_more_agents')}</span>
      </button>

      {/* Footer with create and settings buttons */}
      {!hideSettingsLink && (
        <div className="border-t border-primary/10 bg-base flex items-center gap-1 p-1">
          {/* Quick Create Button - Left */}
          <div
            data-testid="quick-create-button"
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
            data-testid="settings-button"
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
  )

  const trigger =
    triggerVariant === 'menu-item' ? (
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-hover active:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="team-selector"
        >
          <span className="flex items-center gap-3 min-w-0">
            <AgentIcon className="h-4 w-4 flex-shrink-0 text-text-muted" />
            <span className="text-sm">{t('common:teamSelector.agent_label', '智能体')}</span>
          </span>
          <span className="ml-3 max-w-28 truncate text-xs text-text-muted">
            {getTeamDisplayName(selectedTeam)}
          </span>
        </button>
      </PopoverTrigger>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <div data-testid={triggerTestId}>
              <ActionButton
                onClick={() => setOpen(!open)}
                disabled={disabled}
                icon={<AgentIcon className="h-4 w-4" />}
                label={iconOnly ? undefined : t('common:teamSelector.agent_label', '智能体')}
                title={t('common:teamSelector.select_agent_tooltip', '选择智能体')}
              />
            </div>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{t('common:teamSelector.select_agent_tooltip', '选择智能体')}</p>
        </TooltipContent>
      </Tooltip>
    )

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={handleOpenChange}>
        {trigger}
        {popoverContent}
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
