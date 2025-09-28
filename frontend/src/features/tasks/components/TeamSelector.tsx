// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Listbox } from '@headlessui/react'
import { ChevronDownIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { FaUsers } from 'react-icons/fa'
import Link from 'next/link'
import { Team } from '@/types/api'

interface TeamSelectorProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  isLoading?: boolean
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTaskContext } from '../contexts/taskContext'
import { useTranslation } from '@/hooks/useTranslation'

// Mobile detection hook
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const checkIsMobile = () => {
      setIsMobile(window.innerWidth < 768) // md breakpoint
    }

    checkIsMobile()
    window.addEventListener('resize', checkIsMobile)
    return () => window.removeEventListener('resize', checkIsMobile)
  }, [])

  return isMobile
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
  const [searchTerm, setSearchTerm] = useState('')
  const isMobile = useIsMobile()

  // Dropdown expansion direction and position
  const [dropdownDirection, setDropdownDirection] = useState<'up' | 'down'>('down')
  const [dropdownPosition, setDropdownPosition] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Calculate dropdown expansion direction and position
  const handleDropdownClick = () => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top

    let direction: 'up' | 'down' = 'down'
    let position: { top?: number; bottom?: number; left: number } = { left: rect.left }

    if (spaceBelow < 100 && spaceAbove > spaceBelow) {
      direction = 'up'
      position.bottom = window.innerHeight - rect.top + 4
    } else {
      direction = 'down'
      position.top = rect.bottom + 4
    }

    setDropdownDirection(direction)
    setDropdownPosition(position)
  }

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

  const filteredTeams = useMemo(() => {
    if (!searchTerm.trim()) return teams
    const keyword = searchTerm.toLowerCase()
    return teams.filter(team => team.name.toLowerCase().includes(keyword))
  }, [teams, searchTerm])

  const handleTeamChange = (team: Team) => {
    setSelectedTeam(team)
    setSearchTerm('')
  }

  // Initialize dropdown position on mount
  useEffect(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPosition({ left: rect.left, top: rect.bottom + 4 })
    }
  }, [])

  if (!selectedTeam || teams.length === 0) return null

  return (
    <div>
      <Listbox value={selectedTeam} onChange={handleTeamChange} disabled={disabled}>
        <div className="relative">
          <Listbox.Button
            ref={buttonRef}
            className={`flex items-center space-x-1 text-text-muted hover:text-text-primary ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            onClick={handleDropdownClick}
          >
            <FaUsers className={`w-3 h-3 flex-shrink-0 ${isLoading ? 'animate-pulse' : ''}`} />
            <span className={`text-sm truncate ${isMobile ? 'max-w-[240px]' : 'max-w-[200px]'}`} title={selectedTeam.name}>
              {isLoading ? 'Loading...' : selectedTeam.name}
            </span>
            <ChevronDownIcon className="w-4 h-4 flex-shrink-0" />
          </Listbox.Button>
          <Listbox.Options
            className={`fixed bg-surface border border-border rounded-lg z-[60] overflow-hidden flex flex-col ${
              isMobile ? 'w-[280px] max-h-[240px]' : 'w-[220px] max-h-[200px]'
            }`}
            style={{
              ...dropdownPosition,
              boxShadow: 'var(--shadow-popover)',
              WebkitOverflowScrolling: 'touch', // 启用iOS原生滚动
              touchAction: 'pan-y', // 允许垂直滚动
              pointerEvents: 'auto' // 确保触摸事件能传递
            }}
          >
            <div className="p-2 border-b border-border">
              <input
                type="text"
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                placeholder={t('teams.search_placeholder')}
                className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div
              className={`py-1 overflow-y-auto ${isMobile ? 'max-h-[160px]' : 'max-h-[120px]'}`}
              style={{
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                scrollbarWidth: 'thin', // Firefox 滚动条
                overscrollBehavior: 'contain' // 防止滚动超出边界时触发页面滚动
              }}
            >
              {filteredTeams.length > 0 ? (
                filteredTeams.map(team => (
                  <Listbox.Option
                    key={team.id}
                    value={team}
                    className={({ active, selected }) =>
                      `px-2.5 py-1.5 text-xs cursor-pointer transition-colors duration-150 block ${
                        selected
                          ? 'bg-muted text-text-primary'
                          : active
                            ? 'bg-primary/15 text-text-primary'
                            : 'text-text-primary'
                      }`
                    }
                    title={team.name}
                  >
                    <div className="flex items-center space-x-2 text-text-muted">
                      <FaUsers className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="font-medium text-xs text-text-primary truncate">{team.name}</span>
                    </div>
                  </Listbox.Option>
                ))
              ) : (
                <div className="px-2.5 py-2 text-xs text-text-muted">
                  {t('teams.no_match')}
                </div>
              )}
            </div>
            <div className="border-t border-border bg-base">
              <Link
                href="/settings?tab=team"
                className="group flex items-center space-x-2 px-2.5 py-2 text-xs text-text-secondary hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="font-medium group-hover:text-text-primary">{t('teams.manage')}</span>
              </Link>
            </div>
          </Listbox.Options>
        </div>
      </Listbox>
    </div>
  )
}
