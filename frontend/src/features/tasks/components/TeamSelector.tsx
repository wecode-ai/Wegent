// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Listbox } from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { FaUsers } from 'react-icons/fa'
import { Team } from '@/types/api'

interface TeamSelectorProps {
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  teams: Team[]
  disabled: boolean
  isLoading?: boolean
}

import React, { useEffect, useRef, useState } from 'react'
import { useTaskContext } from '../contexts/taskContext'

export default function TeamSelector({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  isLoading
}: TeamSelectorProps) {
  const { selectedTaskDetail } = useTaskContext()

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

  if (!selectedTeam || teams.length === 0) return null

  return (
    <div>
      <Listbox value={selectedTeam} onChange={setSelectedTeam} disabled={disabled}>
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
            className={`absolute ${dropdownDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 bg-surface border border-border rounded-lg z-20 w-auto max-w-[220px] max-h-[200px] overflow-y-auto py-1`}
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            {teams.map((team) => (
              <Listbox.Option
                key={team.id}
                value={team}
                className={({ active, selected }) =>
                  `px-2.5 py-1.5 text-xs cursor-pointer transition-colors duration-150 block rounded ${
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
            ))}
          </Listbox.Options>
        </div>
      </Listbox>
    </div>
  )
}
