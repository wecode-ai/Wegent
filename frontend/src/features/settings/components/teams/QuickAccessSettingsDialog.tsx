// SPDX-FileCopyrightText: 2025 WeCode-AI, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  Cog6ToothIcon,
  XMarkIcon,
  PlusIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { userApis } from '@/apis/user'
import { fetchTeamsList } from '@/apis/teams'
import type { Team } from '@/types/api'
import type { QuickAccessResponse, QuickAccessModeUpdate } from '@/types/api'
import { TeamIconDisplay } from './TeamIconDisplay'

interface QuickAccessSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ModeTab = 'chat' | 'code'

export function QuickAccessSettingsDialog({ open, onOpenChange }: QuickAccessSettingsDialogProps) {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<ModeTab>('chat')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [quickAccessConfig, setQuickAccessConfig] = useState<QuickAccessResponse | null>(null)

  // Local state for editing
  const [chatMaxCount, setChatMaxCount] = useState(8)
  const [chatPinnedTeams, setChatPinnedTeams] = useState<number[]>([])
  const [codeMaxCount, setCodeMaxCount] = useState(8)
  const [codePinnedTeams, setCodePinnedTeams] = useState<number[]>([])

  // All teams for selection
  const [allTeams, setAllTeams] = useState<Team[]>([])
  const [teamsLoading, setTeamsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Current mode config
  const currentMaxCount = activeTab === 'chat' ? chatMaxCount : codeMaxCount
  const currentPinnedTeams = activeTab === 'chat' ? chatPinnedTeams : codePinnedTeams
  const setCurrentMaxCount = activeTab === 'chat' ? setChatMaxCount : setCodeMaxCount
  const setCurrentPinnedTeams = activeTab === 'chat' ? setChatPinnedTeams : setCodePinnedTeams

  // Load data when dialog opens
  useEffect(() => {
    if (open) {
      loadData()
    }
  }, [open])

  const loadData = async () => {
    setLoading(true)
    setTeamsLoading(true)
    try {
      const [config, teams] = await Promise.all([userApis.getQuickAccess(), fetchTeamsList()])
      setQuickAccessConfig(config)
      setAllTeams(teams)

      // Initialize local state from config
      setChatMaxCount(config.chat.max_count)
      setChatPinnedTeams(config.chat.pinned_teams)
      setCodeMaxCount(config.code.max_count)
      setCodePinnedTeams(config.code.pinned_teams)
    } catch {
      toast.error('Failed to load quick access configuration')
    } finally {
      setLoading(false)
      setTeamsLoading(false)
    }
  }

  // Filter teams by bind_mode for current tab
  const filteredTeamsForMode = useMemo(() => {
    return allTeams.filter((team) => {
      const bindMode = team.spec?.bind_mode || []
      // If bind_mode is empty or not set, show in all modes
      if (!bindMode.length) return true
      return bindMode.includes(activeTab)
    })
  }, [allTeams, activeTab])

  // Teams that can be added (not already pinned)
  const availableTeams = useMemo(() => {
    const pinnedSet = new Set(currentPinnedTeams)
    const filtered = filteredTeamsForMode.filter((team) => !pinnedSet.has(team.id))
    if (!searchQuery) return filtered
    const query = searchQuery.toLowerCase()
    return filtered.filter(
      (team) =>
        team.metadata?.name?.toLowerCase().includes(query) ||
        team.spec?.description?.toLowerCase().includes(query)
    )
  }, [filteredTeamsForMode, currentPinnedTeams, searchQuery])

  // Get team by ID
  const getTeamById = (id: number): Team | undefined => {
    return allTeams.find((team) => team.id === id)
  }

  // Pinned team handlers
  const addPinnedTeam = (teamId: number) => {
    if (currentPinnedTeams.length >= currentMaxCount) {
      toast.error(t('quick_access.max_reached'))
      return
    }
    setCurrentPinnedTeams([...currentPinnedTeams, teamId])
  }

  const removePinnedTeam = (teamId: number) => {
    setCurrentPinnedTeams(currentPinnedTeams.filter((id) => id !== teamId))
  }

  const movePinnedTeamUp = (index: number) => {
    if (index === 0) return
    const newList = [...currentPinnedTeams]
    ;[newList[index - 1], newList[index]] = [newList[index], newList[index - 1]]
    setCurrentPinnedTeams(newList)
  }

  const movePinnedTeamDown = (index: number) => {
    if (index === currentPinnedTeams.length - 1) return
    const newList = [...currentPinnedTeams]
    ;[newList[index], newList[index + 1]] = [newList[index + 1], newList[index]]
    setCurrentPinnedTeams(newList)
  }

  // Save handler
  const handleSave = async () => {
    setSaving(true)
    try {
      const updateData: { chat?: QuickAccessModeUpdate; code?: QuickAccessModeUpdate } = {}

      // Always include both modes
      updateData.chat = {
        max_count: chatMaxCount,
        pinned_teams: chatPinnedTeams,
      }
      updateData.code = {
        max_count: codeMaxCount,
        pinned_teams: codePinnedTeams,
      }

      await userApis.updateQuickAccess(updateData)
      toast.success(t('quick_access.save_success'))
      onOpenChange(false)
    } catch {
      toast.error('Failed to save configuration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cog6ToothIcon className="w-5 h-5" />
            {t('quick_access.settings')}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : (
          <div className="flex flex-col gap-4 flex-1 overflow-hidden">
            {/* Tab selector */}
            <div className="flex gap-2 border-b border-border pb-2">
              <button
                onClick={() => setActiveTab('chat')}
                className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
                  activeTab === 'chat'
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:bg-muted'
                }`}
              >
                {t('quick_access.chat_mode')}
              </button>
              <button
                onClick={() => setActiveTab('code')}
                className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
                  activeTab === 'code'
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:bg-muted'
                }`}
              >
                {t('quick_access.code_mode')}
              </button>
            </div>

            {/* Max count setting */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium whitespace-nowrap">
                {t('quick_access.max_count')}
              </label>
              <Input
                type="number"
                min={1}
                max={10}
                value={currentMaxCount}
                onChange={(e) => {
                  const value = Math.min(10, Math.max(1, parseInt(e.target.value) || 1))
                  setCurrentMaxCount(value)
                }}
                className="w-20"
              />
              <span className="text-xs text-text-muted">{t('quick_access.max_count_hint')}</span>
            </div>

            <div className="flex-1 overflow-auto">
              {/* Pinned teams section */}
              <div className="mb-4">
                <h3 className="text-sm font-medium mb-2">{t('quick_access.pinned_agents')}</h3>
                <div className="border border-border rounded-md bg-surface min-h-[100px] max-h-[180px] overflow-auto">
                  {currentPinnedTeams.length === 0 ? (
                    <div className="flex items-center justify-center py-6 text-text-muted text-sm">
                      {t('quick_access.no_pinned')}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {currentPinnedTeams.map((teamId, index) => {
                        const team = getTeamById(teamId)
                        if (!team) return null
                        return (
                          <div
                            key={teamId}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-hover"
                          >
                            <div className="flex flex-col gap-0.5">
                              <button
                                onClick={() => movePinnedTeamUp(index)}
                                disabled={index === 0}
                                className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <ChevronUpIcon className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => movePinnedTeamDown(index)}
                                disabled={index === currentPinnedTeams.length - 1}
                                className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <ChevronDownIcon className="w-3 h-3" />
                              </button>
                            </div>
                            <TeamIconDisplay icon={team.spec?.icon} size="sm" />
                            <span className="flex-1 text-sm truncate">{team.metadata?.name}</span>
                            <Badge variant="secondary" className="text-xs">
                              {t('quick_access.pinned_badge')}
                            </Badge>
                            <button
                              onClick={() => removePinnedTeam(teamId)}
                              className="p-1 text-text-muted hover:text-error"
                            >
                              <XMarkIcon className="w-4 h-4" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Available teams section */}
              <div>
                <h3 className="text-sm font-medium mb-2">{t('quick_access.available_agents')}</h3>
                <div className="relative mb-2">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                  <Input
                    placeholder={t('quick_access.search_placeholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <div className="border border-border rounded-md bg-surface min-h-[100px] max-h-[180px] overflow-auto">
                  {teamsLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Spinner />
                    </div>
                  ) : availableTeams.length === 0 ? (
                    <div className="flex items-center justify-center py-6 text-text-muted text-sm">
                      {t('teams.no_teams')}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {availableTeams.map((team) => {
                        const isMaxReached = currentPinnedTeams.length >= currentMaxCount
                        return (
                          <div
                            key={team.id}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-hover"
                          >
                            <TeamIconDisplay icon={team.spec?.icon} size="sm" />
                            <span className="flex-1 text-sm truncate">{team.metadata?.name}</span>
                            {team.spec?.description && (
                              <span className="text-xs text-text-muted truncate max-w-[120px]">
                                {team.spec.description}
                              </span>
                            )}
                            <button
                              onClick={() => addPinnedTeam(team.id)}
                              disabled={isMaxReached}
                              className="p-1 text-primary hover:text-primary/80 disabled:opacity-30 disabled:cursor-not-allowed"
                              title={isMaxReached ? t('quick_access.max_reached') : undefined}
                            >
                              <PlusIcon className="w-4 h-4" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? t('actions.saving') : t('actions.save')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Settings button component
export function QuickAccessSettingsButton() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Cog6ToothIcon className="w-4 h-4" />
        {t('quick_access.settings')}
      </Button>
      <QuickAccessSettingsDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
