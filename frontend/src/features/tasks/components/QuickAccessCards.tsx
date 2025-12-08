// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FaUsers } from 'react-icons/fa'
import { useTranslation } from '@/hooks/useTranslation'
import { userApis } from '@/apis/user'
import { QuickAccessTeam, Team } from '@/types/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface QuickAccessCardsProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  currentMode: 'chat' | 'code'
  isLoading?: boolean
}

export function QuickAccessCards({
  teams,
  selectedTeam,
  onTeamSelect,
  currentMode,
  isLoading,
}: QuickAccessCardsProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const [quickAccessTeams, setQuickAccessTeams] = useState<QuickAccessTeam[]>([])
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true)
  const [modeSwitchDialogOpen, setModeSwitchDialogOpen] = useState(false)
  const [pendingTeam, setPendingTeam] = useState<Team | null>(null)

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

  // Get display teams: quick access teams matched with full team data
  const displayTeams = quickAccessTeams.length > 0
    ? quickAccessTeams
        .map(qa => {
          const fullTeam = teams.find(t => t.id === qa.id)
          if (fullTeam) {
            return {
              ...fullTeam,
              is_system: qa.is_system,
              recommended_mode: qa.recommended_mode || fullTeam.recommended_mode,
            }
          }
          return null
        })
        .filter((t): t is Team & { is_system: boolean } => t !== null)
    : // Fallback: show first 4 teams if no quick access configured
      teams.slice(0, 4).map(t => ({ ...t, is_system: false }))

  const handleTeamClick = (team: Team & { is_system?: boolean; recommended_mode?: 'chat' | 'code' | 'both' }) => {
    const recommendedMode = team.recommended_mode || 'both'

    // Check if mode switch is needed
    if (recommendedMode !== 'both' && recommendedMode !== currentMode) {
      setPendingTeam(team)
      setModeSwitchDialogOpen(true)
      return
    }

    // Select team directly
    onTeamSelect(team)
  }

  const handleConfirmModeSwitch = () => {
    if (pendingTeam) {
      const targetMode = pendingTeam.recommended_mode === 'code' ? '/code' : '/chat'
      // First select the team, then navigate
      onTeamSelect(pendingTeam)
      router.push(targetMode)
    }
    setModeSwitchDialogOpen(false)
    setPendingTeam(null)
  }

  const handleCancelModeSwitch = () => {
    // Select team without mode switch
    if (pendingTeam) {
      onTeamSelect(pendingTeam)
    }
    setModeSwitchDialogOpen(false)
    setPendingTeam(null)
  }

  if (isLoading || isQuickAccessLoading) {
    return (
      <div className="flex flex-wrap gap-3 mt-4">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-surface animate-pulse"
          >
            <div className="w-5 h-5 bg-muted rounded" />
            <div className="w-20 h-4 bg-muted rounded" />
          </div>
        ))}
      </div>
    )
  }

  if (displayTeams.length === 0) {
    return null
  }

  return (
    <>
      <div className="flex flex-wrap gap-3 mt-4">
        {displayTeams.map(team => {
          const isSelected = selectedTeam?.id === team.id
          return (
            <div
              key={team.id}
              onClick={() => handleTeamClick(team)}
              className={`
                flex items-center gap-2 px-4 py-2
                rounded-lg border cursor-pointer transition-all
                ${isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-surface hover:bg-hover hover:border-border-strong'}
              `}
            >
              <FaUsers className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-text-muted'}`} />
              <span className={`text-sm font-medium ${isSelected ? 'text-primary' : 'text-text-secondary'}`}>
                {team.name}
              </span>
            </div>
          )
        })}
      </div>

      {/* Mode Switch Confirmation Dialog */}
      <Dialog open={modeSwitchDialogOpen} onOpenChange={setModeSwitchDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('quick_access.switch_mode_title')}</DialogTitle>
            <DialogDescription>
              {pendingTeam?.recommended_mode === 'code'
                ? t('quick_access.switch_to_code_message')
                : t('quick_access.switch_to_chat_message')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelModeSwitch}>
              {t('quick_access.stay_current')}
            </Button>
            <Button onClick={handleConfirmModeSwitch}>
              {t('quick_access.switch_mode')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
