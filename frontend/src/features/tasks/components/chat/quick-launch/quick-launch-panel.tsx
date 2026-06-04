'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { TaskType, Team } from '@/types/api'
import { QuickLauncherCards } from './quick-launcher-cards'
import { QuickPhraseList } from './QuickPhraseList'
import {
  buildQuickLaunchHref,
  getCurrentTargetPageByMode,
  type QuickLaunchIntent,
} from './launch-intent'
import type { QuickLauncher, QuickPresetSelection } from './types'
import { useQuickLaunchers } from './useQuickLaunchers'

const QUICK_PHRASE_EXIT_ANIMATION_MS = 150

interface QuickLaunchPanelProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  onPresetSelect: (selection: QuickPresetSelection) => void
  currentMode: TaskType
  isLoading?: boolean
  defaultTeam?: Team | null
  launchIntent?: QuickLaunchIntent | null
  onLaunchIntentConsumed?: () => void
  renderMoreButton?: () => ReactNode
  renderQuickCreateCard?: () => ReactNode
}

export function QuickLaunchPanel({
  teams,
  onTeamSelect,
  onPresetSelect,
  currentMode,
  isLoading,
  defaultTeam,
  launchIntent,
  onLaunchIntentConsumed,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLaunchPanelProps) {
  const router = useRouter()
  const [selectedLauncher, setSelectedLauncher] = useState<QuickLauncher | null>(null)
  const [selectedLauncherKey, setSelectedLauncherKey] = useState<string | null>(null)
  const [isPhraseListExiting, setIsPhraseListExiting] = useState(false)
  const exitTimerRef = useRef<number | null>(null)
  const {
    isLoading: isQuickLaunchLoading,
    systemLaunchers,
    favoriteLaunchers,
  } = useQuickLaunchers({ teams, currentMode, defaultTeam })
  const currentTargetPage = getCurrentTargetPageByMode(currentMode)

  const shouldNavigateToLauncherPage = useCallback(
    (launcher: QuickLauncher) => launcher.targetPage !== currentTargetPage,
    [currentTargetPage]
  )

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

  const navigateToLauncher = useCallback(
    (launcher: QuickLauncher) => {
      router.push(
        buildQuickLaunchHref(launcher, {
          showPresets: launcher.inputPresets.length > 0,
        })
      )
    },
    [router]
  )

  useEffect(() => {
    if (!launchIntent?.launcherKey) {
      return
    }

    const launcher = [...systemLaunchers, ...favoriteLaunchers].find(
      item => item.key === launchIntent.launcherKey
    )
    if (!launcher) {
      return
    }

    onTeamSelect(launcher.team)

    if (launchIntent.presetId) {
      const preset = launcher.inputPresets.find(item => item.id === launchIntent.presetId)
      if (preset) {
        onPresetSelect({ launcher, preset })
      }
      onLaunchIntentConsumed?.()
      return
    }

    if (launchIntent.showPresets && launcher.inputPresets.length > 0) {
      showPhraseList(launcher)
      onLaunchIntentConsumed?.()
      return
    }

    setSelectedLauncherKey(launcher.key)
    onLaunchIntentConsumed?.()
  }, [
    favoriteLaunchers,
    launchIntent,
    onLaunchIntentConsumed,
    onPresetSelect,
    onTeamSelect,
    showPhraseList,
    systemLaunchers,
  ])

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
        onPresetSelect={preset => {
          onTeamSelect(selectedLauncher.team)
          onPresetSelect({ launcher: selectedLauncher, preset })
        }}
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
        if (shouldNavigateToLauncherPage(launcher)) {
          navigateToLauncher(launcher)
          return
        }

        onTeamSelect(launcher.team)
        if (launcher.inputPresets.length > 0) {
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
