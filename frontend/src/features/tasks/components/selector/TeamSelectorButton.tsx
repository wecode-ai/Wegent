// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TeamSelectorButton Component
 *
 * Simplified team selector for chat input controls.
 * Always displays "智能体" label with AgentIcon.
 */

'use client'

import React, { useState } from 'react'
import { Check, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { ActionButton } from '@/components/ui/action-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Tag } from '@/components/ui/tag'
import { AgentIcon } from '@/components/icons/AgentIcon'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import type { Team, TaskDetail, TaskType } from '@/types/api'

interface TeamSelectorButtonProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  taskDetail?: TaskDetail | null
  hideSettingsLink?: boolean
  /** Current mode for filtering teams by bind_mode */
  currentMode?: TaskType
}

export default function TeamSelectorButton({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  hideSettingsLink = false,
  currentMode = 'chat',
}: TeamSelectorButtonProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const sharedBadgeStyle = getSharedBadgeStyle()

  // Filter teams by bind_mode based on current mode
  const filteredTeamsByMode = React.useMemo(() => {
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

  // Filter teams by search query
  const filteredTeams = filteredTeamsByMode.filter(team =>
    team.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

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

  if (!selectedTeam || teams.length === 0) return null

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div>
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

        <PopoverContent
          align="start"
          side="top"
          className="w-[280px] p-2 max-h-[320px] overflow-hidden flex flex-col"
        >
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
            {filteredTeams.length === 0 ? (
              <div className="py-4 text-center text-sm text-text-muted">
                {searchQuery ? t('common:teams.no_match') : t('common:teams.no_match')}
              </div>
            ) : (
              filteredTeams.map(team => {
                const isSelected = selectedTeam?.id === team.id
                const isSharedTeam = team.share_status === 2 && team.user?.user_name
                const isGroupTeam =
                  team.namespace && team.namespace !== 'default' && team.namespace !== 'community'

                return (
                  <div
                    key={team.id}
                    className={`flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors ${
                      isSelected ? 'bg-primary/10' : 'hover:bg-hover'
                    }`}
                    onClick={() => handleSelectTeam(team)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleSelectTeam(team)
                      }
                    }}
                  >
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        isSelected
                          ? 'bg-primary border-primary text-white'
                          : 'border-border bg-background'
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="text-sm text-text-primary truncate flex-1 min-w-0"
                          title={team.name}
                        >
                          {team.name}
                        </span>
                        {isGroupTeam && (
                          <Tag className="text-xs !m-0 flex-shrink-0" variant="info">
                            {team.namespace}
                          </Tag>
                        )}
                        {isSharedTeam && (
                          <Tag
                            className="text-xs !m-0 flex-shrink-0"
                            variant="default"
                            style={sharedBadgeStyle}
                          >
                            {t('common:teams.shared_by', { author: team.user?.user_name })}
                          </Tag>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Footer with settings link */}
          {!hideSettingsLink && (
            <div
              className={cn(
                'border-t border-primary/10 bg-base cursor-pointer group mt-2',
                'flex items-center space-x-2 text-xs text-text-secondary',
                'hover:bg-hover active:bg-hover transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full',
                'px-2.5 py-2'
              )}
              onClick={() => {
                router.push(paths.settings.team.getHref())
                setOpen(false)
              }}
              role="button"
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  router.push(paths.settings.team.getHref())
                  setOpen(false)
                }
              }}
            >
              <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
              <span className="font-medium group-hover:text-text-primary">
                {t('common:teams.manage')}
              </span>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}
