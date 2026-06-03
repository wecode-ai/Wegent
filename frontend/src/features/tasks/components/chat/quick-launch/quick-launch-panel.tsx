'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskType, Team } from '@/types/api'
import { QuickLauncherCards } from './quick-launcher-cards'
import { QuickPhraseList } from './QuickPhraseList'
import type { QuickLauncher } from './types'
import { useQuickLaunchers } from './useQuickLaunchers'

const QUICK_PHRASE_EXIT_ANIMATION_MS = 150

interface QuickLaunchPanelProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  onPhraseSelect: (phrase: string) => void
  currentMode: TaskType
  isLoading?: boolean
  defaultTeam?: Team | null
  renderMoreButton?: () => ReactNode
  renderQuickCreateCard?: () => ReactNode
}

export function QuickLaunchPanel({
  teams,
  onTeamSelect,
  onPhraseSelect,
  currentMode,
  isLoading,
  defaultTeam,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLaunchPanelProps) {
  const [selectedLauncher, setSelectedLauncher] = useState<QuickLauncher | null>(null)
  const [selectedLauncherKey, setSelectedLauncherKey] = useState<string | null>(null)
  const [isPhraseListExiting, setIsPhraseListExiting] = useState(false)
  const exitTimerRef = useRef<number | null>(null)
  const {
    isLoading: isQuickLaunchLoading,
    systemLaunchers,
    favoriteLaunchers,
  } = useQuickLaunchers({ teams, currentMode, defaultTeam })

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current === null) {
      return
    }

    window.clearTimeout(exitTimerRef.current)
    exitTimerRef.current = null
  }, [])

  useEffect(() => clearExitTimer, [clearExitTimer])

  const showPhraseList = useCallback(
    (launcher: QuickLauncher) => {
      clearExitTimer()
      setSelectedLauncherKey(null)
      setIsPhraseListExiting(false)
      setSelectedLauncher(launcher)
    },
    [clearExitTimer]
  )

  const hidePhraseList = useCallback(() => {
    if (isPhraseListExiting) {
      return
    }

    clearExitTimer()
    setIsPhraseListExiting(true)
    exitTimerRef.current = window.setTimeout(() => {
      setSelectedLauncher(null)
      setIsPhraseListExiting(false)
      exitTimerRef.current = null
    }, QUICK_PHRASE_EXIT_ANIMATION_MS)
  }, [clearExitTimer, isPhraseListExiting])

  if (isLoading || isQuickLaunchLoading) {
    return (
      <div className="mx-auto mt-6 h-[108px] w-full max-w-[820px] animate-pulse rounded-lg bg-surface" />
    )
  }

  if (selectedLauncher) {
    return (
      <QuickPhraseList
        launcher={selectedLauncher}
        isExiting={isPhraseListExiting}
        onBack={hidePhraseList}
        onPhraseSelect={onPhraseSelect}
      />
    )
  }

  if (
    systemLaunchers.length === 0 &&
    favoriteLaunchers.length === 0 &&
    !renderMoreButton &&
    !renderQuickCreateCard
  ) {
    return null
  }

  return (
    <QuickLauncherCards
      systemLaunchers={systemLaunchers}
      favoriteLaunchers={favoriteLaunchers}
      selectedLauncherKey={selectedLauncherKey}
      onSelectLauncher={launcher => {
        onTeamSelect(launcher.team)
        if (launcher.quickPhrases.length > 0) {
          showPhraseList(launcher)
          return
        }
        setSelectedLauncherKey(launcher.key)
      }}
      renderMoreButton={renderMoreButton}
      renderQuickCreateCard={renderQuickCreateCard}
    />
  )
}
