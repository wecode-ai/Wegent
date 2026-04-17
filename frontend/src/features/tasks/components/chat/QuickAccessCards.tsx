// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { SparklesIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { Check, Search } from 'lucide-react'
import { userApis } from '@/apis/user'
import { QuickAccessTeam, Team } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Tag } from '@/components/ui/tag'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import TeamCreationWizard from '@/features/settings/components/wizard/TeamCreationWizard'

// Container dimensions
const CONTAINER_WIDTH = 880
const CONTAINER_HEIGHT = 108

// Card dimensions
const CARD_WIDTH = 154
// Maximum number of team cards to display before showing "More" button
const MAX_TEAM_CARDS = 4
// Small button width (compact size for more/quick create buttons)
const SMALL_BUTTON_WIDTH = 72

interface QuickAccessCardsProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  currentMode: 'chat' | 'code' | 'knowledge' | 'task' | 'video' | 'image'
  isLoading?: boolean
  isTeamsLoading?: boolean
  hideSelected?: boolean
  onRefreshTeams?: () => Promise<Team[]>
  showWizardButton?: boolean
  defaultTeam?: Team | null
}

export function QuickAccessCards({
  teams,
  selectedTeam,
  onTeamSelect,
  currentMode,
  isLoading,
  isTeamsLoading: _isTeamsLoading,
  hideSelected: _hideSelected = false,
  onRefreshTeams: _onRefreshTeams,
  showWizardButton: _showWizardButton = false,
  defaultTeam,
}: QuickAccessCardsProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const [quickAccessTeams, setQuickAccessTeams] = useState<QuickAccessTeam[]>([])
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true)
  const [clickedTeamId, setClickedTeamId] = useState<number | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [morePopoverOpen, setMorePopoverOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const sharedBadgeStyle = getSharedBadgeStyle()

  type DisplayTeam = Team & { is_system: boolean; recommended_mode?: 'chat' | 'code' | 'both' }

  useEffect(() => {
    const fetchQuickAccess = async () => {
      try {
        setIsQuickAccessLoading(true)
        const response = await userApis.getQuickAccess()
        setQuickAccessTeams(response.teams)
      } catch (error) {
        console.error('Failed to fetch quick access teams:', error)
        setQuickAccessTeams([])
      } finally {
        setIsQuickAccessLoading(false)
      }
    }

    fetchQuickAccess()
  }, [])

  // Filter teams by bind_mode based on current mode
  const filteredTeams = teams.filter(team => {
    // Filter out teams with empty bind_mode array
    if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
    // If bind_mode is not set (undefined/null), show in all modes
    if (!team.bind_mode) return true
    // Otherwise, only show if current mode is in bind_mode
    return team.bind_mode.includes(currentMode)
  })

  // Get all quick access teams matched with full team data
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

  // Filter out default team only (keep selected team visible with selection state)
  const displayTeams = allDisplayTeams.filter(t => {
    if (defaultTeam && t.id === defaultTeam.id) return false
    return true
  })

  // Limit display teams to MAX_TEAM_CARDS (4 teams)
  const teamCardsToShow = displayTeams.slice(0, MAX_TEAM_CARDS)
  const hasMoreTeams = displayTeams.length > MAX_TEAM_CARDS

  // Filter teams by search query for the more popover
  const filteredTeamsBySearch = displayTeams.filter(team =>
    team.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleMorePopoverOpenChange = (newOpen: boolean) => {
    setMorePopoverOpen(newOpen)
    if (!newOpen) {
      setSearchQuery('')
    }
  }

  const handleSelectTeamFromMore = (team: Team) => {
    onTeamSelect(team)
    setMorePopoverOpen(false)
    setSearchQuery('')
  }

  const handleTeamClick = useCallback(
    (team: DisplayTeam) => {
      setClickedTeamId(team.id)

      setTimeout(() => {
        onTeamSelect(team)
      }, 150)

      setTimeout(() => {
        setClickedTeamId(null)
      }, 300)
    },
    [onTeamSelect]
  )

  const handleWizardSuccess = async (teamId: number, _teamName: string) => {
    setShowWizard(false)
    if (_onRefreshTeams) {
      const refreshedTeams = await _onRefreshTeams()
      const newTeam = refreshedTeams.find(t => t.id === teamId)
      if (newTeam) {
        onTeamSelect(newTeam)
      }
    }
  }

  if (isLoading || isQuickAccessLoading) {
    return (
      <div className="flex flex-col items-center mt-6 w-full">
        <div
          className="flex items-center justify-start gap-3 overflow-hidden rounded-lg bg-base p-3 mx-auto"
          style={{
            width: CONTAINER_WIDTH,
            height: CONTAINER_HEIGHT,
          }}
        >
          {[1, 2, 3, 4, 5].map(i => (
            <div
              key={i}
              className="rounded-[20px] bg-base border border-border animate-pulse"
              style={{
                width: CARD_WIDTH,
                height: 78,
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  if (teams.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center mt-8 mb-4">
        <div className="w-full max-w-md bg-surface border border-border rounded-2xl p-6 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <SparklesIcon className="w-6 h-6 text-primary" />
            </div>
          </div>
          <h3 className="text-lg font-semibold text-text-primary mb-2">
            {t('teams.no_teams_title')}
          </h3>
          <p className="text-sm text-text-muted">{t('teams.no_teams_description')}</p>
        </div>
      </div>
    )
  }

  // Don't show quick access cards if no teams are available after filtering
  if (displayTeams.length === 0) {
    return null
  }

  const renderTeamCard = (team: DisplayTeam) => {
    const isSelected = selectedTeam?.id === team.id
    const isClicked = clickedTeamId === team.id
    const description = team.description || t('common:teams.no_description')
    const isGroupTeam =
      team.namespace && team.namespace !== 'default' && team.namespace !== 'community'

    return (
      <div
        onClick={() => !isClicked && handleTeamClick(team)}
        data-testid={`quick-access-team-${team.name}`}
        className={`
          group relative flex flex-col justify-center
          cursor-pointer transition-all duration-200
          ${
            isSelected
              ? 'border-l-[3px] border-l-primary border-y border-r border-border bg-primary/5'
              : 'border border-border bg-base'
          }
          ${isClicked ? 'clicking-card' : ''}
          ${isClicked ? 'pointer-events-none' : ''}
          ${!isSelected ? 'hover:shadow-[0_2px_12px_0_rgba(0,0,0,0.1)]' : ''}
        `}
        style={{
          width: CARD_WIDTH,
          height: 78,
          padding: '8px 12px',
          borderRadius: 20,
          flexShrink: 0,
          flexGrow: 0,
        }}
      >
        {/* Group namespace badge in top-right corner */}
        {isGroupTeam && (
          <span
            className="absolute top-2 right-2 text-[9px] text-primary/60 leading-none max-w-[60px] truncate"
            title={team.namespace ?? undefined}
          >
            {team.namespace}
          </span>
        )}

        <div className="mb-1 w-full">
          <span
            className={`block text-[15px] font-semibold leading-5 truncate ${
              isSelected ? 'text-primary' : 'text-text-primary'
            }`}
            title={team.name}
          >
            {team.name}
          </span>
        </div>

        <p
          className="text-xs text-text-muted leading-[18px] line-clamp-1 w-full truncate"
          title={description}
        >
          {description}
        </p>
      </div>
    )
  }

  const renderQuickCreateCard = () => {
    if (!_showWizardButton) return null

    return (
      <div
        onClick={() => setShowWizard(true)}
        className="group relative flex flex-col justify-center items-center cursor-pointer transition-all duration-200 border border-dashed border-border bg-base hover:border-primary hover:bg-primary/5 hover:shadow-[0_2px_12px_0_rgba(0,0,0,0.1)]"
        style={{
          width: SMALL_BUTTON_WIDTH,
          height: 78,
          padding: '8px 12px',
          borderRadius: 20,
          flexShrink: 0,
          flexGrow: 0,
        }}
      >
        <SparklesIcon className="w-4 h-4 text-primary mb-1 transition-colors" />
        <span className="text-[10px] font-medium text-text-primary group-hover:text-primary transition-colors text-center leading-tight">
          {t('wizard:wizard_button')}
        </span>
      </div>
    )
  }

  const renderMoreButton = () => {
    if (!hasMoreTeams) return null

    return (
      <Popover open={morePopoverOpen} onOpenChange={handleMorePopoverOpenChange}>
        <PopoverTrigger asChild>
          <div
            className="group relative flex flex-col justify-center items-center cursor-pointer transition-all duration-200 border border-border bg-base hover:border-border-strong hover:bg-hover hover:shadow-sm"
            style={{
              width: SMALL_BUTTON_WIDTH,
              height: 78,
              padding: '8px 12px',
              borderRadius: 20,
              flexShrink: 0,
              flexGrow: 0,
            }}
          >
            <ChevronDownIcon className="w-4 h-4 text-text-muted group-hover:text-text-primary mb-1 transition-colors" />
            <span className="text-[10px] font-medium text-text-muted group-hover:text-text-primary transition-colors text-center leading-tight">
              {t('common:teams.more')}
            </span>
          </div>
        </PopoverTrigger>

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
            {filteredTeamsBySearch.length === 0 ? (
              <div className="py-4 text-center text-sm text-text-muted">
                {searchQuery ? t('common:teams.no_match') : t('common:teams.no_match')}
              </div>
            ) : (
              filteredTeamsBySearch.map(team => {
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
                    onClick={() => handleSelectTeamFromMore(team)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleSelectTeamFromMore(team)
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
                            title={t('common:teams.shared_by', { author: team.user?.user_name })}
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
        </PopoverContent>
      </Popover>
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
            box-shadow: 0 0 0 6px rgba(20, 184, 166, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(20, 184, 166, 0);
          }
        }

        @keyframes scale-bounce {
          0% {
            transform: scale(1);
          }
          50% {
            transform: scale(0.97);
          }
          100% {
            transform: scale(1);
          }
        }

        .clicking-card {
          animation:
            pulse-glow 0.3s ease-out,
            scale-bounce 0.3s ease-out;
        }
      `}</style>

      <div
        className="w-full max-w-[820px] mx-auto flex flex-wrap items-center justify-center gap-3 mt-6"
        data-tour="quick-access-cards"
        data-testid="quick-access-cards"
      >
        {teamCardsToShow.map(team => (
          <div key={team.id}>{renderTeamCard(team)}</div>
        ))}
        {renderMoreButton()}
        {renderQuickCreateCard()}
      </div>

      {/* Team Creation Wizard Dialog */}
      <TeamCreationWizard
        open={showWizard}
        onClose={() => setShowWizard(false)}
        onSuccess={handleWizardSuccess}
        scope="personal"
      />
    </>
  )
}
