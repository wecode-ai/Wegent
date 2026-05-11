// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { SparklesIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { ArrowLeft, List, Search } from 'lucide-react'
import { userApis } from '@/apis/user'
import type { QuickAccessResponse, QuickAccessTeam, Team, UserPreferences } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import TeamCreationWizard from '@/features/settings/components/wizard/TeamCreationWizard'
import { TEAM_SELECTOR_POPOVER_CLASS_NAME } from '../selector/team-selector-popover'
import TeamSelectorList from '../selector/TeamSelectorList'
import {
  filterTeamsByMode,
  getTeamDisplayName,
  type SelectableTeam,
} from '../selector/team-selector-utils'
import { useTeamFavorites } from '../selector/useTeamFavorites'

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
  const [quickAccessResponse, setQuickAccessResponse] = useState<QuickAccessResponse | null>(null)
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true)
  const [clickedTeamId, setClickedTeamId] = useState<number | null>(null)
  const [draggedTeamId, setDraggedTeamId] = useState<number | null>(null)
  const [dragOverTeamId, setDragOverTeamId] = useState<number | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [morePopoverOpen, setMorePopoverOpen] = useState(false)
  const [showAllTeamsInMore, setShowAllTeamsInMore] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const isDragReorderingRef = useRef(false)

  type DisplayTeam = SelectableTeam & {
    is_system: boolean
    recommended_mode?: 'chat' | 'code' | 'both'
  }

  const fetchQuickAccess = useCallback(async () => {
    try {
      setIsQuickAccessLoading(true)
      const response = await userApis.getQuickAccess()
      setQuickAccessResponse(response)
      setQuickAccessTeams(response.teams)
    } catch (error) {
      console.error('Failed to fetch quick access teams:', error)
      setQuickAccessResponse(null)
      setQuickAccessTeams([])
    } finally {
      setIsQuickAccessLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchQuickAccess()
    window.addEventListener('quick-access-updated', fetchQuickAccess)

    return () => {
      window.removeEventListener('quick-access-updated', fetchQuickAccess)
    }
  }, [fetchQuickAccess])

  const filteredTeams = filterTeamsByMode(teams, currentMode)

  // Get all quick access teams matched with full team data
  const allDisplayTeams: DisplayTeam[] = quickAccessTeams
    .map(qa => {
      const fullTeam = filteredTeams.find(t => t.id === qa.id)
      if (fullTeam) {
        return {
          ...fullTeam,
          display_name: qa.display_name,
          is_system: qa.is_system,
          recommended_mode: qa.recommended_mode || fullTeam.recommended_mode,
        } as DisplayTeam
      }
      return null
    })
    .filter((t): t is DisplayTeam => t !== null)

  // Filter out default team only (keep selected team visible with selection state)
  const displayTeams = allDisplayTeams.filter(t => {
    if (defaultTeam && t.id === defaultTeam.id) return false
    return true
  })

  const allSelectableTeams: DisplayTeam[] = filteredTeams.map(team => {
    const quickAccessTeam = quickAccessTeams.find(qa => qa.id === team.id)
    return {
      ...team,
      display_name: quickAccessTeam?.display_name ?? team.displayName,
      is_system: quickAccessTeam?.is_system ?? team.user_id === 0,
      recommended_mode: quickAccessTeam?.recommended_mode || team.recommended_mode,
    } as DisplayTeam
  })

  // Limit display teams to MAX_TEAM_CARDS (4 teams)
  const teamCardsToShow = displayTeams.slice(0, MAX_TEAM_CARDS)
  const quickAccessTeamIds = new Set(displayTeams.map(team => team.id))
  const hasTeamsOutsideQuickAccess = allSelectableTeams.some(
    team => !quickAccessTeamIds.has(team.id)
  )
  const morePopoverTeams = showAllTeamsInMore ? allSelectableTeams : displayTeams
  const systemRecommendedQuickAccessIds = quickAccessResponse?.system_team_ids ?? []
  const systemRecommendedQuickAccessIdSet = new Set(systemRecommendedQuickAccessIds)
  const favoriteQuickAccessTeamIds = quickAccessTeams
    .filter(team => !systemRecommendedQuickAccessIdSet.has(team.id))
    .map(team => team.id)
  const {
    favoriteTeamIdSet,
    favoriteUpdatingTeamId,
    handleToggleFavorite,
    quickAccessMetaLoaded,
    systemRecommendedTeamIdSet,
  } = useTeamFavorites({
    initialFavoriteTeamIds: favoriteQuickAccessTeamIds,
    initialSystemRecommendedTeamIds: systemRecommendedQuickAccessIds,
    loadMetadata: false,
  })

  // Filter teams by search query for the more popover
  const filteredTeamsBySearch = morePopoverTeams.filter(team => {
    const normalizedSearch = searchQuery.toLowerCase()
    return (
      getTeamDisplayName(team).toLowerCase().includes(normalizedSearch) ||
      team.name.toLowerCase().includes(normalizedSearch)
    )
  })

  const handleMorePopoverOpenChange = (newOpen: boolean) => {
    setMorePopoverOpen(newOpen)
    if (!newOpen) {
      setSearchQuery('')
      setShowAllTeamsInMore(false)
    }
  }

  const handleSelectTeamFromMore = (team: Team) => {
    onTeamSelect(team)
    setMorePopoverOpen(false)
    setSearchQuery('')
    setShowAllTeamsInMore(false)
  }

  const handleShowAllTeams = () => {
    setShowAllTeamsInMore(true)
    setSearchQuery('')
  }

  const handleShowQuickAccessTeams = () => {
    setShowAllTeamsInMore(false)
    setSearchQuery('')
  }

  const handleTeamClick = useCallback(
    (team: DisplayTeam) => {
      if (isDragReorderingRef.current) return

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

  const persistQuickAccessOrder = useCallback(
    async (orderedTeams: QuickAccessTeam[], previousTeams: QuickAccessTeam[]) => {
      try {
        const currentUser = await userApis.getCurrentUser()
        const currentPreferences: UserPreferences = {
          send_key: currentUser.preferences?.send_key || 'enter',
          ...currentUser.preferences,
        }
        const nextQuickAccess = {
          ...currentPreferences.quick_access,
          version: quickAccessResponse?.system_version ?? currentPreferences.quick_access?.version,
          teams: orderedTeams.map(team => team.id),
        }

        await userApis.updateUser({
          preferences: {
            ...currentPreferences,
            quick_access: nextQuickAccess,
          },
        })
      } catch (error) {
        console.error('Failed to reorder quick access teams:', error)
        setQuickAccessTeams(previousTeams)
        setQuickAccessResponse(previous =>
          previous
            ? {
                ...previous,
                teams: previousTeams,
              }
            : previous
        )
      }
    },
    [quickAccessResponse?.system_version]
  )

  const reorderQuickAccessTeams = useCallback(
    (sourceTeamId: number, targetTeamId: number) => {
      if (sourceTeamId === targetTeamId) return

      const sourceIndex = quickAccessTeams.findIndex(team => team.id === sourceTeamId)
      const targetIndex = quickAccessTeams.findIndex(team => team.id === targetTeamId)

      if (sourceIndex === -1 || targetIndex === -1) return

      const previousTeams = [...quickAccessTeams]
      const reorderedTeams = [...quickAccessTeams]
      const [movedTeam] = reorderedTeams.splice(sourceIndex, 1)
      reorderedTeams.splice(targetIndex, 0, movedTeam)

      setQuickAccessTeams(reorderedTeams)
      setQuickAccessResponse(previous =>
        previous
          ? {
              ...previous,
              teams: reorderedTeams,
            }
          : previous
      )
      void persistQuickAccessOrder(reorderedTeams, previousTeams)
    },
    [persistQuickAccessOrder, quickAccessTeams]
  )

  const handleQuickAccessDragStart = (
    event: React.DragEvent<HTMLElement>,
    team: SelectableTeam
  ) => {
    setDraggedTeamId(team.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(team.id))
  }

  const handleQuickAccessDragOver = (event: React.DragEvent<HTMLElement>, team: SelectableTeam) => {
    if (!draggedTeamId || draggedTeamId === team.id) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverTeamId(team.id)
  }

  const handleQuickAccessDrop = (event: React.DragEvent<HTMLElement>, team: SelectableTeam) => {
    event.preventDefault()

    if (!draggedTeamId) return

    isDragReorderingRef.current = true
    reorderQuickAccessTeams(draggedTeamId, team.id)
    setDraggedTeamId(null)
    setDragOverTeamId(null)
  }

  const handleQuickAccessDragEnd = () => {
    setDraggedTeamId(null)
    setDragOverTeamId(null)
    window.setTimeout(() => {
      isDragReorderingRef.current = false
    }, 0)
  }

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
  if (displayTeams.length === 0 && allSelectableTeams.length === 0) {
    return null
  }

  const renderTeamCard = (team: DisplayTeam) => {
    const isSelected = selectedTeam?.id === team.id
    const isClicked = clickedTeamId === team.id
    const description = team.description || t('common:teams.no_description')
    const displayName = getTeamDisplayName(team)
    const isGroupTeam =
      team.namespace && team.namespace !== 'default' && team.namespace !== 'community'

    return (
      <div
        draggable
        onClick={() => !isClicked && handleTeamClick(team)}
        onDragStart={event => handleQuickAccessDragStart(event, team)}
        onDragOver={event => handleQuickAccessDragOver(event, team)}
        onDragLeave={() => setDragOverTeamId(null)}
        onDrop={event => handleQuickAccessDrop(event, team)}
        onDragEnd={handleQuickAccessDragEnd}
        data-testid={`quick-access-team-${team.name}`}
        className={`
          group relative flex flex-col justify-center
          cursor-grab active:cursor-grabbing transition-all duration-200
          ${
            isSelected
              ? 'border-l-[3px] border-l-primary border-y border-r border-border bg-primary/5'
              : 'border border-border bg-base'
          }
          ${isClicked ? 'clicking-card' : ''}
          ${isClicked ? 'pointer-events-none' : ''}
          ${draggedTeamId === team.id ? 'opacity-60' : ''}
          ${dragOverTeamId === team.id ? 'ring-2 ring-primary/40' : ''}
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
            title={displayName}
          >
            {displayName}
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
    const popoverTitle = showAllTeamsInMore
      ? t('common:teams.all_agents_title')
      : t('common:teams.quick_access_title')
    const popoverDescription = showAllTeamsInMore
      ? t('common:teams.all_agents_description')
      : t('common:teams.quick_access_description')
    const searchPlaceholder = showAllTeamsInMore
      ? t('common:teams.search_all_agents')
      : t('common:teams.search_quick_access')

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

        <PopoverContent align="start" side="top" className={TEAM_SELECTOR_POPOVER_CLASS_NAME}>
          <div className="px-2 pb-2">
            <div className="text-sm font-medium text-text-primary">{popoverTitle}</div>
            <p className="mt-1 text-xs leading-5 text-text-muted">{popoverDescription}</p>
          </div>

          {/* Search input */}
          <div className="px-2 pb-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 pl-7 text-sm"
              />
            </div>
          </div>

          {/* Teams list */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <TeamSelectorList
              teams={filteredTeamsBySearch}
              selectedTeam={selectedTeam}
              onTeamSelect={handleSelectTeamFromMore}
              emptyText={
                searchQuery
                  ? t('common:teams.no_match')
                  : showAllTeamsInMore
                    ? t('common:teams.no_teams')
                    : t('common:teams.quick_access_empty')
              }
              favoriteTeamIdSet={favoriteTeamIdSet}
              systemRecommendedTeamIdSet={systemRecommendedTeamIdSet}
              quickAccessMetaLoaded={quickAccessMetaLoaded}
              favoriteUpdatingTeamId={favoriteUpdatingTeamId}
              onToggleFavorite={handleToggleFavorite}
              optionTestIdPrefix="quick-access-more-team"
              showReorderHandle={!showAllTeamsInMore}
              canReorder={quickAccessTeams.length > 1}
              dragOverTeamId={dragOverTeamId}
              onTeamDragStart={handleQuickAccessDragStart}
              onTeamDragOver={handleQuickAccessDragOver}
              onTeamDragLeave={() => setDragOverTeamId(null)}
              onTeamDrop={handleQuickAccessDrop}
              onTeamDragEnd={handleQuickAccessDragEnd}
            />
          </div>

          {hasTeamsOutsideQuickAccess && (
            <div className="border-t border-primary/10 bg-base mt-2 p-1">
              {showAllTeamsInMore ? (
                <button
                  type="button"
                  data-testid="quick-access-show-favorites"
                  onClick={handleShowQuickAccessTeams}
                  className="w-full flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t('common:teams.quick_access_back')}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="quick-access-view-all-agents"
                  onClick={handleShowAllTeams}
                  className="w-full flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                >
                  <List className="h-3.5 w-3.5" />
                  {t('common:teams.quick_access_view_all')}
                </button>
              )}
            </div>
          )}
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
