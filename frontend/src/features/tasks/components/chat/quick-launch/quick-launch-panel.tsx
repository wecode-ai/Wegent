'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { teamApis } from '@/apis/team'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'
import type { TeamModeFilter } from '../../selector/team-selector-utils'
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
  currentMode: TeamModeFilter
  defaultTeam?: Team | null
  launchIntent?: QuickLaunchIntent | null
  onLaunchIntentConsumed?: () => void
  renderMoreButton?: () => ReactNode
  renderQuickCreateCard?: () => ReactNode
}

export function QuickLaunchPanel({
  teams,
  selectedTeam,
  onTeamSelect,
  onPresetSelect,
  currentMode,
  defaultTeam,
  launchIntent,
  onLaunchIntentConsumed,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLaunchPanelProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('common')
  const selectionSequence = useRef(0)
  const pendingTeams = useRef(new Map<number, Promise<Team>>())
  const [selectedLauncher, setSelectedLauncher] = useState<(QuickLauncher & { team: Team }) | null>(
    null
  )
  const [selectedLauncherKey, setSelectedLauncherKey] = useState<string | null>(null)
  const [isPhraseListExiting, setIsPhraseListExiting] = useState(false)
  const exitTimerRef = useRef<number | null>(null)
  const {
    isLoading: isQuickLaunchLoading,
    systemLaunchers,
    favoriteLaunchers,
  } = useQuickLaunchers({ currentMode, defaultTeam })
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
    (launcher: QuickLauncher & { team: Team }) => {
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

  const activateLauncher = useCallback(
    async (launcher: QuickLauncher, intent?: QuickLaunchIntent) => {
      const sequence = ++selectionSequence.current
      try {
        let team = teams.find(item => item.id === launcher.team.id)
        if (!team) {
          let pending = pendingTeams.current.get(launcher.team.id)
          if (!pending) {
            pending = teamApis.getTeam(launcher.team.id)
            pendingTeams.current.set(launcher.team.id, pending)
            const clear = () => pendingTeams.current.delete(launcher.team.id)
            void pending.then(clear, clear)
          }
          team = await pending
        }
        if (sequence !== selectionSequence.current) return
        const resolved = { ...launcher, team }
        onTeamSelect(team)
        if (intent?.presetId) {
          const preset = launcher.inputPresets.find(item => item.id === intent.presetId)
          if (preset) onPresetSelect({ launcher: resolved, preset })
        } else if (launcher.inputPresets.length > 0 && (!intent || intent.showPresets)) {
          showPhraseList(resolved)
        } else {
          setSelectedLauncherKey(launcher.key)
        }
        if (intent) onLaunchIntentConsumed?.()
      } catch (error) {
        if (sequence !== selectionSequence.current) return
        console.error('Failed to load quick launch agent:', error)
        toast({ title: t('teams.load_failed_title'), variant: 'destructive' })
      }
    },
    [teams, onTeamSelect, onPresetSelect, onLaunchIntentConsumed, showPhraseList, toast, t]
  )

  useLayoutEffect(() => {
    // Invalidate pending details before accepting a selection from another entry point.
    return () => {
      selectionSequence.current += 1
    }
  }, [currentMode, selectedTeam?.id])

  useEffect(() => {
    if (!launchIntent?.launcherKey) return
    const launcher = [...systemLaunchers, ...favoriteLaunchers].find(
      item => item.key === launchIntent.launcherKey
    )
    if (!launcher) return
    void activateLauncher(launcher, launchIntent)
    return () => {
      selectionSequence.current += 1
    }
  }, [launchIntent, systemLaunchers, favoriteLaunchers, activateLauncher])

  if (isQuickLaunchLoading) {
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
          selectionSequence.current += 1
          navigateToLauncher(launcher)
          return
        }

        void activateLauncher(launcher)
      }}
      renderMoreButton={renderMoreButton}
      renderQuickCreateCard={renderQuickCreateCard}
    />
  )
}
