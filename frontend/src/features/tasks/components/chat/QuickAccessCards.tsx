// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { userApis } from '@/apis/user'
import { QuickAccessTeam, Team } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

// Container dimensions
const CONTAINER_WIDTH = 880
const CONTAINER_HEIGHT = 108

// Card dimensions
const CARD_WIDTH = 154
const CARD_GAP = 12
const CARDS_PER_PAGE = 5
const PAGE_SCROLL_AMOUNT = CARDS_PER_PAGE * CARD_WIDTH + (CARDS_PER_PAGE - 1) * CARD_GAP

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
  const { t } = useTranslation('common')
  const [quickAccessTeams, setQuickAccessTeams] = useState<QuickAccessTeam[]>([])
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true)
  const [clickedTeamId, setClickedTeamId] = useState<number | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

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

  const needsPagination = displayTeams.length > CARDS_PER_PAGE

  const checkScrollState = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    setCanScrollLeft(container.scrollLeft > 0)
    setCanScrollRight(container.scrollLeft < container.scrollWidth - container.clientWidth - 1)
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    checkScrollState()
    container.addEventListener('scroll', checkScrollState, { passive: true })
    window.addEventListener('resize', checkScrollState)

    return () => {
      container.removeEventListener('scroll', checkScrollState)
      window.removeEventListener('resize', checkScrollState)
    }
  }, [checkScrollState, displayTeams])

  const scrollLeft = () => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollBy({ left: -PAGE_SCROLL_AMOUNT, behavior: 'smooth' })
  }

  const scrollRight = () => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollBy({ left: PAGE_SCROLL_AMOUNT, behavior: 'smooth' })
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
    const description = team.description || t('teams.no_description')

    return (
      <div
        onClick={() => !isClicked && handleTeamClick(team)}
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
        <div className="mb-1">
          <span
            className={`text-[15px] font-semibold leading-5 truncate ${
              isSelected ? 'text-primary' : 'text-text-primary'
            }`}
          >
            {team.name}
          </span>
        </div>

        <p className="text-xs text-text-muted leading-[18px] line-clamp-1">{description}</p>
      </div>
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

        .hide-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }

        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>

      <div className="flex flex-col items-center mt-6" data-tour="quick-access-cards">
        <div
          className="relative flex items-center justify-center rounded-lg bg-base"
          style={{
            width: CONTAINER_WIDTH,
            height: CONTAINER_HEIGHT,
          }}
        >
          {needsPagination && canScrollLeft && (
            <button
              onClick={scrollLeft}
              className="absolute left-0 z-10 flex items-center justify-center cursor-pointer hover:opacity-80 transition-opacity bg-gradient-to-r from-transparent via-base/80 to-base"
              style={{
                width: 36,
                height: 86,
                borderRadius: 10,
              }}
              aria-label="Scroll left"
            >
              <ChevronLeftIcon className="w-5 h-5 text-text-muted" />
            </button>
          )}

          <div
            ref={scrollContainerRef}
            className="flex items-center gap-3 overflow-x-auto hide-scrollbar"
            style={{
              maxWidth: CARDS_PER_PAGE * CARD_WIDTH + (CARDS_PER_PAGE - 1) * CARD_GAP,
            }}
          >
            {displayTeams.map(team => (
              <div key={team.id}>{renderTeamCard(team)}</div>
            ))}
          </div>

          {needsPagination && canScrollRight && (
            <button
              onClick={scrollRight}
              className="absolute right-0 z-10 flex items-center justify-center cursor-pointer hover:opacity-80 transition-opacity bg-gradient-to-l from-transparent via-base/80 to-base"
              style={{
                width: 36,
                height: 86,
                borderRadius: 10,
              }}
              aria-label="Scroll right"
            >
              <ChevronRightIcon className="w-5 h-5 text-text-muted" />
            </button>
          )}
        </div>
      </div>
    </>
  )
}
