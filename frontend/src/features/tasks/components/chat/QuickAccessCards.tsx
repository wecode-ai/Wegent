// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import { SparklesIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { ArrowLeft, List, Search } from 'lucide-react'
import { userApis } from '@/apis/user'
import type { Bot, QuickAccessResponse, QuickAccessTeam, Team, UserPreferences } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'
import { useToast } from '@/hooks/use-toast'
import { TEAM_SELECTOR_POPOVER_CLASS_NAME } from '../selector/team-selector-popover'
import TeamSelectorList from '../selector/TeamSelectorList'
import {
  filterTeamsByMode,
  getTeamDisplayName,
  type SelectableTeam,
} from '../selector/team-selector-utils'
import { useTeamFavorites } from '../selector/useTeamFavorites'
import { QuickLaunchPanel } from './quick-launch/quick-launch-panel'

// Small button width (compact size for more/quick create buttons)
const SMALL_BUTTON_WIDTH = 72

interface QuickAccessCardsProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  onPhraseSelect?: (phrase: string) => void
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
  onPhraseSelect,
  currentMode,
  isLoading,
  isTeamsLoading: _isTeamsLoading,
  hideSelected: _hideSelected = false,
  onRefreshTeams: _onRefreshTeams,
  showWizardButton: _showWizardButton = false,
  defaultTeam,
}: QuickAccessCardsProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [quickAccessTeams, setQuickAccessTeams] = useState<QuickAccessTeam[]>([])
  const [quickAccessResponse, setQuickAccessResponse] = useState<QuickAccessResponse | null>(null)
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true)
  const [draggedTeamId, setDraggedTeamId] = useState<number | null>(null)
  const [dragOverTeamId, setDragOverTeamId] = useState<number | null>(null)
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [dialogTeams, setDialogTeams] = useState<Team[]>(teams)
  const [dialogBots, setDialogBots] = useState<Bot[]>([])
  const [morePopoverOpen, setMorePopoverOpen] = useState(false)
  const [showAllTeamsInMore, setShowAllTeamsInMore] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const isDragReorderingRef = useRef(false)
  const createdTeamRef = useRef<Team | null>(null)

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

  useEffect(() => {
    setDialogTeams(teams)
  }, [teams])

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
        window.dispatchEvent(new Event('quick-access-updated'))
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

  const handleDialogTeamsChange = useCallback<Dispatch<SetStateAction<Team[]>>>(updater => {
    setDialogTeams(prev => {
      const next =
        typeof updater === 'function' ? (updater as (value: Team[]) => Team[])(prev) : updater
      const previousIds = new Set(prev.map(team => team.id))
      const createdTeam = next.find(team => !previousIds.has(team.id))

      if (createdTeam) {
        createdTeamRef.current = createdTeam
      }

      return next
    })
  }, [])

  const handleOpenCreateAgent = () => {
    createdTeamRef.current = null
    setDialogTeams(teams)
    setDialogBots([])
    setCreateAgentOpen(true)
  }

  const handleCreateAgentClose = useCallback(async () => {
    setCreateAgentOpen(false)
    const createdTeam = createdTeamRef.current
    createdTeamRef.current = null

    if (_onRefreshTeams && createdTeam) {
      try {
        const refreshedTeams = await _onRefreshTeams()
        onTeamSelect(refreshedTeams.find(t => t.id === createdTeam.id) || createdTeam)
      } catch (error) {
        console.error('Failed to refresh teams after creating agent:', error)
        onTeamSelect(createdTeam)
      }
      return
    }

    if (createdTeam) {
      onTeamSelect(createdTeam)
    }
  }, [_onRefreshTeams, onTeamSelect])

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

  const renderQuickCreateCard = () => {
    if (!_showWizardButton) return null

    return (
      <button
        type="button"
        data-testid="quick-create-agent"
        onClick={handleOpenCreateAgent}
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
          {t('teams.create_first_team')}
        </span>
      </button>
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
      <QuickLaunchPanel
        teams={teams}
        selectedTeam={selectedTeam}
        onTeamSelect={onTeamSelect}
        onPhraseSelect={onPhraseSelect ?? (() => undefined)}
        currentMode={currentMode}
        isLoading={isLoading || isQuickAccessLoading}
        defaultTeam={defaultTeam}
        renderMoreButton={renderMoreButton}
        renderQuickCreateCard={renderQuickCreateCard}
      />

      {createAgentOpen && (
        <TeamEditDialog
          open={createAgentOpen}
          onClose={() => void handleCreateAgentClose()}
          teams={dialogTeams}
          setTeams={handleDialogTeamsChange}
          editingTeamId={0}
          bots={dialogBots}
          setBots={setDialogBots}
          toast={toast}
          scope="personal"
        />
      )}
    </>
  )
}
