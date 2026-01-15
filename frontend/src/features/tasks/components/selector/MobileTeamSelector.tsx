// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Check, Search, Settings, ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import { Tag } from '@/components/ui/tag'
import type { Team } from '@/types/api'

interface MobileTeamSelectorProps {
  selectedTeam: Team | null
  teams: Team[]
  onTeamSelect: (team: Team) => void
  disabled: boolean
  isLoading?: boolean
  // Optional: custom trigger button text (e.g., "更多" instead of team name)
  triggerText?: string
  // Optional: hide team icon in trigger button
  hideTriggerIcon?: boolean
}

/**
 * Mobile Team Selector - iOS Style
 * Bottom sheet with native iOS design patterns
 */
export default function MobileTeamSelector({
  selectedTeam,
  teams,
  onTeamSelect,
  disabled,
  isLoading,
  triggerText,
  hideTriggerIcon = false,
}: MobileTeamSelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()

  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
      setIsSearchFocused(false)
    }
  }, [isOpen])

  // Filter teams based on search (teams are already filtered by bind_mode in parent)
  const searchFilteredTeams = teams.filter(team => {
    if (!searchValue.trim()) return true
    const search = searchValue.toLowerCase()
    return (
      team.name.toLowerCase().includes(search) ||
      team.namespace?.toLowerCase().includes(search) ||
      team.user?.user_name?.toLowerCase().includes(search)
    )
  })

  const handleTeamSelect = (team: Team) => {
    onTeamSelect(team)
    setIsOpen(false)
  }

  const isDisabled = disabled || isLoading || teams.length === 0

  if (!selectedTeam || teams.length === 0) return null

  return (
    <Drawer open={isOpen} onOpenChange={setIsOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          disabled={isDisabled}
          className={cn(
            'flex items-center min-w-0 max-w-full rounded-full px-3 py-2 h-9',
            'border border-border bg-base text-text-primary transition-colors overflow-hidden',
            isLoading ? 'animate-pulse' : '',
            'focus:outline-none focus:ring-0',
            'active:opacity-70',
            'disabled:cursor-not-allowed disabled:opacity-50',
            triggerText ? 'gap-1' : 'gap-2'
          )}
        >
          {!hideTriggerIcon && selectedTeam && !triggerText && (
            <TeamIconDisplay
              iconId={selectedTeam?.icon}
              size="xs"
              className="text-text-muted flex-shrink-0"
            />
          )}
          <span className="truncate text-xs min-w-0">
            {triggerText || selectedTeam?.name || t('common:teams.select_team')}
          </span>
          {triggerText && <ChevronDown className="w-2.5 h-2.5 text-text-muted flex-shrink-0" />}
        </button>
      </DrawerTrigger>

      <DrawerContent className="max-h-[85vh] bg-[#f2f2f7] dark:bg-[#1c1c1e]" showHandle={false}>
        {/* iOS-style drag handle */}
        <div className="flex justify-center pt-2 pb-3">
          <div className="w-9 h-1 rounded-full bg-[#3c3c43]/30 dark:bg-[#5c5c5e]" />
        </div>

        {/* Search bar - iOS style */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#8e8e93]" />
            <input
              type="text"
              placeholder={t('common:teams.search_team')}
              value={searchValue}
              onChange={e => setSearchValue(e.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => setIsSearchFocused(false)}
              className={cn(
                'w-full h-9 pl-9 pr-3 rounded-lg',
                'bg-[#e5e5ea] dark:bg-[#2c2c2e]',
                'text-sm text-text-primary placeholder:text-[#8e8e93]',
                'border-0 outline-none focus:ring-0'
              )}
            />
          </div>
        </div>

        {/* Team list - iOS grouped style */}
        <div
          className={cn(
            'flex-1 overflow-y-auto px-4 pb-4',
            isSearchFocused ? 'max-h-[70vh]' : 'max-h-[50vh]'
          )}
        >
          {searchFilteredTeams.length === 0 ? (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] p-4 text-center text-sm text-[#8e8e93]">
              {isLoading
                ? t('common:loading', '加载中...')
                : t('common:teams.no_match', '暂无匹配的智能体')}
            </div>
          ) : (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] overflow-hidden">
              {/* Team items */}
              {searchFilteredTeams.map((team, index) => {
                const isSelected = selectedTeam?.id === team.id
                const isSharedTeam = team.share_status === 2 && team.user?.user_name
                const isGroupTeam = team.namespace && team.namespace !== 'default'
                const isLast = index === searchFilteredTeams.length - 1

                return (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => handleTeamSelect(team)}
                    className={cn(
                      'w-full flex items-center justify-between px-4 py-3',
                      'text-left active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
                      !isLast && 'border-b border-[#c6c6c8] dark:border-[#38383a]'
                    )}
                  >
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <TeamIconDisplay
                        iconId={team.icon}
                        size="sm"
                        className="flex-shrink-0 text-text-muted"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[15px] text-text-primary truncate">
                            {team.name}
                          </span>
                          {isGroupTeam && (
                            <Tag
                              className="text-[11px] !m-0 flex-shrink-0 py-0 px-1.5"
                              variant="info"
                            >
                              {team.namespace}
                            </Tag>
                          )}
                        </div>
                        {isSharedTeam && (
                          <div className="text-[13px] text-[#8e8e93] mt-0.5 truncate">
                            {t('common:teams.shared_by', { author: team.user?.user_name })}
                          </div>
                        )}
                      </div>
                    </div>
                    {isSelected && <Check className="h-5 w-5 text-[#007aff] flex-shrink-0 ml-3" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer - Settings link */}
        {!isSearchFocused && (
          <div className="px-4 pb-4 pt-2">
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false)
                  router.push(paths.settings.team.getHref())
                }}
                className="flex items-center gap-1.5 text-[#007aff] active:opacity-70"
              >
                <Settings className="h-4 w-4" />
                <span className="text-[13px]">{t('common:teams.manage', '管理')}</span>
              </button>
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}
