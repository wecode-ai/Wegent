'use client'

import { useState, type ReactNode } from 'react'
import type { TaskType, Team } from '@/types/api'
import { QuickLauncherCards } from './QuickLauncherCards'
import { QuickPhraseList } from './QuickPhraseList'
import type { QuickLauncher } from './types'
import { useQuickLaunchers } from './useQuickLaunchers'

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
  const {
    isLoading: isQuickLaunchLoading,
    systemLaunchers,
    favoriteLaunchers,
  } = useQuickLaunchers({ teams, currentMode, defaultTeam })

  if (isLoading || isQuickLaunchLoading) {
    return (
      <div className="mx-auto mt-6 h-[108px] w-full max-w-[820px] animate-pulse rounded-lg bg-surface" />
    )
  }

  if (selectedLauncher) {
    return (
      <QuickPhraseList
        launcher={selectedLauncher}
        onBack={() => setSelectedLauncher(null)}
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
      onSelectLauncher={launcher => {
        onTeamSelect(launcher.team)
        setSelectedLauncher(launcher)
      }}
      renderMoreButton={renderMoreButton}
      renderQuickCreateCard={renderQuickCreateCard}
    />
  )
}
