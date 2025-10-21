// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo } from 'react'
import { Select, Tag, theme } from 'antd'
import { FaUsers } from 'react-icons/fa'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { useRouter } from 'next/navigation'
import { Team } from '@/types/api'
import { useTaskContext } from '../contexts/taskContext'
import { useTranslation } from '@/hooks/useTranslation'
import { paths } from '@/config/paths'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'

interface TeamSelectorProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  isLoading?: boolean
}

export default function TeamSelector({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  isLoading
}: TeamSelectorProps) {
  const { selectedTaskDetail } = useTaskContext()
  const { t } = useTranslation('common')
  const router = useRouter()
  const { token } = theme.useToken()
  const sharedBadgeStyle = useMemo(() => getSharedBadgeStyle(token), [token])

  // Automatically set team based on selectedTask
  useEffect(() => {
    if (selectedTaskDetail && 'team' in selectedTaskDetail && selectedTaskDetail.team && teams.length > 0) {
      const foundTeam = teams.find(t => t.id === (selectedTaskDetail.team as any).id) || null
      if (foundTeam && (!selectedTeam || selectedTeam.id !== foundTeam.id)) {
        setSelectedTeam(foundTeam)
        return
      }
    }

    if (!selectedTeam) {
      if (teams.length > 0) {
        setSelectedTeam(teams[0])
      } else {
        setSelectedTeam(null)
      }
      return
    }

    if (teams.length > 0) {
      const exists = teams.some(team => team.id === selectedTeam.id)
      if (!exists) {
        setSelectedTeam(teams[0])
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, teams, selectedTeam])

  const handleChange = (value: { value: number; label: React.ReactNode } | undefined) => {
    if (!value) {
      setSelectedTeam(null)
      return
    }
    const team = teams.find(t => t.id === value.value)
    if (team) {
      setSelectedTeam(team)
    }
  }

  const handleSearch = (query: string) => {
    // Search functionality is handled by antd Select's built-in filterOption
  }

  const teamOptions = useMemo(() => {
    return teams.map(team => {
      // Check if it's a shared team from others (share_status === 2 means shared team)
      const isSharedTeam = team.share_status === 2 && team.user?.user_name
      
      return {
        label: (
          <div className="flex items-center gap-2">
            <FaUsers className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />
            <span className="font-medium text-xs text-text-primary truncate" title={team.name}>
              {team.name}
            </span>
            {isSharedTeam && (
              <Tag className="ml-2 text-xs !m-0 flex-shrink-0" style={sharedBadgeStyle}>
                {t('teams.shared_by', { author: team.user?.user_name })}
              </Tag>
            )}
          </div>
        ),
        value: team.id,
      }
    })
  }, [teams, sharedBadgeStyle])

  const filterOption = (input: string, option?: { label: React.ReactNode; value: number }) => {
    if (!option) return false
    const team = teams.find(t => t.id === option.value)
    return team ? team.name.toLowerCase().includes(input.toLowerCase()) : false
  }

  if (!selectedTeam || teams.length === 0) return null

  return (
    <div className="flex items-baseline space-x-1 min-w-0">
      <FaUsers className={`w-3 h-3 text-text-muted flex-shrink-0  ${isLoading ? 'animate-pulse' : ''}`} />
      <Select
        labelInValue
        showSearch
        value={selectedTeam ? {
          value: selectedTeam.id,
          label: (
            <div className="flex items-center gap-2">
              <span title={selectedTeam.name}>{selectedTeam.name}</span>
              {selectedTeam.share_status === 2 && selectedTeam.user?.user_name && (
                <Tag className="text-xs !m-0 flex-shrink-0 ml-2" style={sharedBadgeStyle}>
                  {selectedTeam.user?.user_name}
                </Tag>
              )}
            </div>
          )
        } : undefined}
        placeholder={
          <span className="text-sx truncate h-2">
            {isLoading ? 'Loading...' : t('teams.select_team')}
          </span>
        }
        className="repository-selector min-w-0 truncate"
        style={{
          width: 'auto',
          maxWidth: 200,
          display: 'inline-block',
          paddingRight: 20,
        }}
        popupMatchSelectWidth={false}
        styles={{ popup: { root: { maxWidth: 280 } } }}
        classNames={{ popup: { root: "repository-selector-dropdown custom-scrollbar" } }}
        disabled={disabled || isLoading}
        loading={isLoading}
        size='small'
        filterOption={filterOption}
        onSearch={handleSearch}
        onChange={handleChange}
        notFoundContent={
          <div className="px-3 py-2 text-sm text-text-muted">
            {t('teams.no_match')}
          </div>
        }
        options={teamOptions}
        popupRender={(menu) => (
          <div>
            {menu}
            <div
              className="border-t border-border bg-base cursor-pointer group flex items-center space-x-2 px-2.5 py-2 text-xs text-text-secondary hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full"
              onClick={() => router.push(paths.settings.team.getHref())}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  router.push(paths.settings.team.getHref())
                }
              }}
            >
              <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
              <span className="font-medium group-hover:text-text-primary">{t('teams.manage')}</span>
            </div>
          </div>
        )}
      />
    </div>
  )
}
