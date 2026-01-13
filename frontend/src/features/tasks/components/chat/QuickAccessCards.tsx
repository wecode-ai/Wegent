// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback, useTransition, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { HiOutlineCode, HiOutlineChatAlt2 } from 'react-icons/hi'
import {
  ChevronDownIcon,
  Cog6ToothIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { Wand2 } from 'lucide-react'
import { userApis } from '@/apis/user'
import { QuickAccessTeam, Team } from '@/types/api'
import { saveLastTeamByMode } from '@/utils/userPreferences'
import { useTranslation } from '@/hooks/useTranslation'
import { Tag } from '@/components/ui/tag'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { paths } from '@/config/paths'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import TeamCreationWizard from '@/features/settings/components/wizard/TeamCreationWizard'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { MobileTeamSelector } from '@/features/tasks/components/selector'

// Maximum number of quick access cards to display
const MAX_QUICK_ACCESS_CARDS = 4

interface QuickAccessCardsProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  currentMode: 'chat' | 'code'
  isLoading?: boolean
  isTeamsLoading?: boolean
  hideSelected?: boolean // Whether to hide the selected team from the cards
  onRefreshTeams?: () => Promise<Team[]>
  showWizardButton?: boolean // Whether to show the wizard button (only for chat mode)
}

export function QuickAccessCards({
  teams,
  selectedTeam,
  onTeamSelect,
  currentMode,
  isLoading,
  isTeamsLoading,
  hideSelected = false,
  onRefreshTeams,
  showWizardButton = false,
}: QuickAccessCardsProps) {
  const router = useRouter()
  const { t } = useTranslation(['common', 'wizard'])
  const [isPending, startTransition] = useTransition()
  const [quickAccessTeams, setQuickAccessTeams] = useState<QuickAccessTeam[]>([])
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true)
  const [clickedTeamId, setClickedTeamId] = useState<number | null>(null)
  const [switchingToMode, setSwitchingToMode] = useState<'chat' | 'code' | null>(null)
  const [showMoreTeams, setShowMoreTeams] = useState(false)
  const [showWizard, setShowWizard] = useState(false)
  const moreButtonRef = useRef<HTMLDivElement>(null)
  const isMobile = useMediaQuery('(max-width: 767px)')

  // Define the extended team type for display
  type DisplayTeam = Team & { is_system: boolean; recommended_mode?: 'chat' | 'code' | 'both' }

  // Prefetch both chat and code pages on mount for smoother navigation
  useEffect(() => {
    router.prefetch('/chat')
    router.prefetch('/code')
  }, [router])

  // Fetch quick access teams
  useEffect(() => {
    const fetchQuickAccess = async () => {
      try {
        setIsQuickAccessLoading(true)
        const response = await userApis.getQuickAccess()
        setQuickAccessTeams(response.teams)
      } catch (error) {
        console.error('Failed to fetch quick access teams:', error)
        // Fallback: use first few teams from the teams list
        setQuickAccessTeams([])
      } finally {
        setIsQuickAccessLoading(false)
      }
    }

    fetchQuickAccess()
  }, [])

  // Filter teams by bind_mode based on current mode (same logic as TeamSelector)
  const filteredTeams = teams.filter(team => {
    // If bind_mode is not set or is an empty array, filter it out (team has no bound mode)
    if (!team.bind_mode || team.bind_mode.length === 0) return false
    // Otherwise, only show if current mode is in bind_mode
    return team.bind_mode.includes(currentMode)
  })

  // Get display teams: quick access teams matched with full team data
  const allDisplayTeams: DisplayTeam[] =
    quickAccessTeams.length > 0
      ? quickAccessTeams
          .map(qa => {
            const fullTeam = filteredTeams.find(t => t.id === qa.id)
            if (fullTeam) {
              return {
                ...fullTeam,
                is_system: qa.is_system,
                recommended_mode: qa.recommended_mode || fullTeam.recommended_mode,
              } as DisplayTeam
            }
            return null
          })
          .filter((t): t is DisplayTeam => t !== null)
      : // Fallback: show first teams from filtered list if no quick access configured
        filteredTeams.map(t => ({ ...t, is_system: false }) as DisplayTeam)

  // Filter out selected team if hideSelected is true
  const teamsAfterFilter =
    hideSelected && selectedTeam
      ? allDisplayTeams.filter(t => t.id !== selectedTeam.id)
      : allDisplayTeams

  // Limit display teams to MAX_QUICK_ACCESS_CARDS
  const displayTeams = teamsAfterFilter.slice(0, MAX_QUICK_ACCESS_CARDS)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (moreButtonRef.current && !moreButtonRef.current.contains(event.target as Node)) {
        setShowMoreTeams(false)
      }
    }

    if (showMoreTeams) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showMoreTeams])

  // Handle team selection from dropdown
  const handleTeamSelectFromDropdown = useCallback(
    (team: Team) => {
      onTeamSelect(team)
      setShowMoreTeams(false)
    },
    [onTeamSelect]
  )

  // Search state for team list
  const [searchQuery, setSearchQuery] = useState('')

  // Filter teams for dropdown based on search query
  const dropdownTeams = useMemo(() => {
    if (!searchQuery.trim()) return filteredTeams
    const query = searchQuery.toLowerCase()
    return filteredTeams.filter(team => team.name.toLowerCase().includes(query))
  }, [filteredTeams, searchQuery])

  // Get shared badge style
  const sharedBadgeStyle = useMemo(() => getSharedBadgeStyle(), [])

  // Reset search when dropdown closes
  useEffect(() => {
    if (!showMoreTeams) {
      setSearchQuery('')
    }
  }, [showMoreTeams])

  // Determine the target mode for a team based on recommended_mode or bind_mode
  const getTeamTargetMode = (team: DisplayTeam): 'chat' | 'code' | 'both' => {
    // First check recommended_mode (from quick access config)
    if (team.recommended_mode && team.recommended_mode !== 'both') {
      return team.recommended_mode
    }
    // Then check bind_mode - if only one mode is allowed, use that
    if (team.bind_mode && team.bind_mode.length === 1) {
      return team.bind_mode[0]
    }
    // Default to both (no mode switch needed)
    return 'both'
  }

  const handleTeamClick = useCallback(
    (team: DisplayTeam) => {
      const targetMode = getTeamTargetMode(team)

      // Check if we need to switch mode
      const needsModeSwitch = targetMode !== 'both' && targetMode !== currentMode

      // Always trigger click animation
      setClickedTeamId(team.id)

      if (needsModeSwitch) {
        setSwitchingToMode(targetMode)

        // When switching mode, save the team preference to the TARGET mode's localStorage
        // This ensures the new page will restore the correct team
        saveLastTeamByMode(team.id, targetMode)

        // Use startTransition for smoother navigation without blocking UI
        // Delay slightly to allow animation to start
        setTimeout(() => {
          const targetPath = targetMode === 'code' ? '/code' : '/chat'
          startTransition(() => {
            router.push(targetPath)
          })
        }, 200)
      } else {
        // No mode switch needed, just select the team in current page after animation
        // First let the animation play, then select the team
        setTimeout(() => {
          onTeamSelect(team)
        }, 300)

        // Reset the clicked state after animation completes
        setTimeout(() => {
          setClickedTeamId(null)
          setSwitchingToMode(null)
        }, 400)
      }
    },
    [currentMode, router, onTeamSelect, startTransition]
  )

  if (isLoading || isQuickAccessLoading) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className="flex items-center gap-1 h-[42px] px-4 rounded-full border border-border bg-surface animate-pulse"
          >
            <div className="w-4 h-4 bg-muted rounded" />
            <div className="w-16 h-3 bg-muted rounded" />
          </div>
        ))}
      </div>
    )
  }

  if (displayTeams.length === 0) {
    return null
  }

  // Render a single team card with optional tooltip
  const renderTeamCard = (team: DisplayTeam) => {
    const isSelected = selectedTeam?.id === team.id
    const isClicked = clickedTeamId === team.id
    const targetMode = getTeamTargetMode(team)
    const willSwitchMode = targetMode !== 'both' && targetMode !== currentMode

    const cardContent = (
      <div
        onClick={() => !isClicked && !isPending && handleTeamClick(team)}
        className={`
          group relative flex items-center gap-1 h-[42px] px-4
          rounded-full border cursor-pointer transition-all duration-200
          ${
            isClicked || isPending
              ? 'switching-card border-primary bg-primary/10 ring-2 ring-primary/50'
              : isSelected
                ? 'border-primary bg-primary/5'
                : 'border-border bg-base hover:bg-hover hover:border-border-strong hover:shadow-sm'
          }
          ${isClicked || isPending ? 'pointer-events-none' : ''}
        `}
      >
        <TeamIconDisplay
          iconId={team.icon}
          size="sm"
          className={`flex-shrink-0 transition-colors duration-200 ${
            isClicked || isSelected ? 'text-primary' : 'text-text-muted'
          }`}
        />
        <span
          className={`text-xs font-normal transition-colors duration-200 whitespace-nowrap ${
            isClicked || isSelected ? 'text-primary' : 'text-text-primary'
          }`}
        >
          {team.name}
        </span>

        {/* Mode switch indicator */}
        {isClicked && switchingToMode && (
          <div className="mode-indicator flex items-center gap-1 ml-0.5 text-primary">
            <span className="text-xs">→</span>
            {switchingToMode === 'code' ? (
              <HiOutlineCode className="w-3.5 h-3.5" />
            ) : (
              <HiOutlineChatAlt2 className="w-3.5 h-3.5" />
            )}
          </div>
        )}

        {/* Hover hint for mode switch */}
        {!isClicked && willSwitchMode && (
          <div className="flex items-center text-text-muted opacity-0 group-hover:opacity-100 transition-opacity duration-200 ml-0.5">
            {targetMode === 'code' ? (
              <HiOutlineCode className="w-3 h-3" />
            ) : (
              <HiOutlineChatAlt2 className="w-3 h-3" />
            )}
          </div>
        )}
      </div>
    )

    // Tooltip content: prioritize description, fallback to name
    const tooltipText = team.description || team.name

    // Always wrap with Tooltip
    return (
      <TooltipProvider key={team.id}>
        <Tooltip>
          <TooltipTrigger asChild>{cardContent}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-[300px]">
            <p>{tooltipText}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <>
      <style jsx>{`
        @keyframes pulse-glow {
          0% {
            box-shadow: 0 0 0 0 rgba(20, 184, 166, 0.4);
          }
          50% {
            box-shadow: 0 0 0 8px rgba(20, 184, 166, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(20, 184, 166, 0);
          }
        }

        @keyframes scale-bounce {
          0% {
            transform: scale(1);
          }
          30% {
            transform: scale(0.95);
          }
          60% {
            transform: scale(1.02);
          }
          100% {
            transform: scale(1);
          }
        }

        @keyframes slide-fade {
          0% {
            opacity: 0;
            transform: translateX(-8px);
          }
          100% {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .switching-card {
          animation:
            pulse-glow 0.4s ease-out,
            scale-bounce 0.4s ease-out;
        }

        .mode-indicator {
          animation: slide-fade 0.2s ease-out forwards;
        }
      `}</style>
      <div
        className="flex flex-wrap items-center justify-start gap-2.5 mt-6"
        data-tour="quick-access-cards"
      >
        {/* Show selected team first with highlighted style */}
        {selectedTeam && (
          <div className="flex items-center gap-1.5 h-[42px] px-4 rounded-full border border-primary bg-primary/5 text-primary">
            <TeamIconDisplay
              iconId={selectedTeam.icon}
              size="sm"
              className="flex-shrink-0 text-primary"
            />
            <span className="text-xs font-medium whitespace-nowrap">{selectedTeam.name}</span>
          </div>
        )}
        {displayTeams.map(team => renderTeamCard(team))}

        {/* More button - use MobileTeamSelector on mobile, dropdown on desktop */}
        {isMobile ? (
          // Mobile: Use iOS-style drawer selector with "更多" text
          filteredTeams.length > 0 && selectedTeam ? (
            <MobileTeamSelector
              selectedTeam={selectedTeam}
              teams={filteredTeams}
              onTeamSelect={onTeamSelect}
              disabled={isLoading || isTeamsLoading || false}
              isLoading={isTeamsLoading}
              triggerText={t('teams.more')}
            />
          ) : (
            // Fallback: Show a button with "更多" text if no team selected but teams exist
            filteredTeams.length > 0 && (
              <button
                onClick={() => {
                  // Select first team if none selected
                  if (!selectedTeam && filteredTeams.length > 0) {
                    onTeamSelect(filteredTeams[0])
                  }
                }}
                className="flex items-center gap-1 h-[42px] px-4 rounded-full border border-border bg-base hover:bg-hover transition-colors"
              >
                <span className="text-xs font-normal text-text-primary">{t('teams.more')}</span>
                <ChevronDownIcon className="w-2.5 h-2.5 text-text-muted" />
              </button>
            )
          )
        ) : (
          // Desktop: Original dropdown
          <div ref={moreButtonRef} className="relative">
            <button
              onClick={() => setShowMoreTeams(!showMoreTeams)}
              className={`
                flex items-center gap-1 h-[42px] px-4
                rounded-full border cursor-pointer transition-all duration-200
                ${
                  showMoreTeams
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-base hover:bg-hover hover:border-border-strong'
                }
              `}
              title={t('teams.more_teams')}
            >
              <span className="text-xs font-normal text-text-primary">{t('teams.more')}</span>
              <ChevronDownIcon
                className={`w-2.5 h-2.5 text-text-muted transition-transform duration-200 ${showMoreTeams ? 'rotate-180' : ''}`}
              />
            </button>

            {/* Dropdown with team list */}
            {showMoreTeams && (
              <div className="absolute top-full left-0 mt-2 z-50 min-w-[300px] max-w-[400px] bg-surface border border-border rounded-xl shadow-xl overflow-hidden">
                {/* Search input */}
                <div className="p-2 border-b border-border">
                  <div className="relative">
                    <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder={t('teams.search_team')}
                      className="w-full pl-9 pr-3 py-2 text-sm bg-base border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-text-muted"
                      autoFocus
                    />
                  </div>
                </div>

                {/* Team list */}
                <div className="max-h-[240px] overflow-y-auto">
                  {isTeamsLoading ? (
                    <div className="py-4 text-center text-sm text-text-muted">
                      {t('actions.loading')}
                    </div>
                  ) : dropdownTeams.length === 0 ? (
                    <div className="py-4 text-center text-sm text-text-muted">
                      {t('teams.no_match')}
                    </div>
                  ) : (
                    dropdownTeams.map(team => {
                      const isSelected = selectedTeam?.id === team.id
                      const isSharedTeam = team.share_status === 2 && team.user?.user_name
                      const isGroupTeam = team.namespace && team.namespace !== 'default'

                      return (
                        <div
                          key={team.id}
                          onClick={() => handleTeamSelectFromDropdown(team)}
                          className={`
                            flex items-center gap-3 px-3 py-2 mx-1 my-0.5 rounded-md cursor-pointer
                            transition-colors duration-150
                            ${
                              isSelected
                                ? 'bg-primary/10 text-primary'
                                : 'hover:bg-hover text-text-primary'
                            }
                          `}
                        >
                          <CheckIcon
                            className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'opacity-100 text-primary' : 'opacity-0'}`}
                          />
                          <TeamIconDisplay
                            iconId={team.icon}
                            size="sm"
                            className="flex-shrink-0 text-text-muted"
                          />
                          <span className="flex-1 text-sm font-medium truncate" title={team.name}>
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
                              {team.user?.user_name}
                            </Tag>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Footer with settings link */}
                <div
                  className="border-t border-border bg-base cursor-pointer group flex items-center space-x-2 px-3 py-2.5 text-xs text-text-secondary hover:bg-muted transition-colors duration-150"
                  onClick={() => {
                    setShowMoreTeams(false)
                    router.push(paths.settings.team.getHref())
                  }}
                >
                  <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                  <span className="font-medium group-hover:text-text-primary">
                    {t('teams.manage')}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Divider */}
        <div className="h-7 w-px bg-border mx-1" />

        {/* Wizard button - quick create agent (only show in chat mode) */}
        {showWizardButton && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowWizard(true)}
                  className="flex items-center justify-center w-8 h-8 rounded-full border border-dashed border-primary/50 bg-primary/5 hover:bg-primary/10 hover:border-primary cursor-pointer transition-all duration-200"
                >
                  <Wand2 className="w-4 h-4 text-primary" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{t('wizard:wizard_button_tooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Team Creation Wizard Dialog */}
      {showWizardButton && (
        <TeamCreationWizard
          open={showWizard}
          onClose={() => setShowWizard(false)}
          onSuccess={async (teamId, teamName) => {
            // Refresh teams list first to get the new team
            if (onRefreshTeams) {
              const refreshedTeams = await onRefreshTeams()
              // Find and select the new team from refreshed list
              const newTeam = refreshedTeams.find(t => t.id === teamId)
              if (newTeam) {
                onTeamSelect(newTeam)
              }
            } else {
              // Fallback: try to find in current teams (may not work for newly created)
              const newTeam = teams.find(t => t.id === teamId)
              if (newTeam) {
                onTeamSelect(newTeam)
              }
            }
            console.log(`Created team: ${teamName} (ID: ${teamId})`)
          }}
        />
      )}
    </>
  )
}
