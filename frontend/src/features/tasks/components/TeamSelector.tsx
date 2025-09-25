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

  // Dropdown expansion direction
  const [dropdownDirection, setDropdownDirection] = useState<'up' | 'down'>('down')
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Calculate dropdown expansion direction
  const handleDropdownClick = () => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    if (spaceBelow < 100 && spaceAbove > spaceBelow) {
      setDropdownDirection('up')
    } else {
      setDropdownDirection('down')
    }
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
            <span className="text-sm truncate max-w-[200px]" title={selectedTeam.name}>
              {isLoading ? 'Loading...' : selectedTeam.name}
            </span>
            <ChevronDownIcon className="w-4 h-4 flex-shrink-0" />
          </Listbox.Button>
          <Listbox.Options
            className={`absolute ${dropdownDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 bg-surface border border-border rounded-lg z-20 w-[220px] overflow-hidden flex flex-col`}
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            <div className="p-2 border-b border-border">
              <input
                type="text"
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                placeholder={t('teams.search_placeholder')}
                className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                onMouseDown={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
              />
            </div>
            <div className="py-1 max-h-[200px] overflow-y-auto">
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
