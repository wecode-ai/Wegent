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
      setSelectedTeam(foundTeam)
    } else if (teams && teams.length > 0) {
      setSelectedTeam(teams[0])
    } else {
      setSelectedTeam(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, teams])

  if (!selectedTeam || teams.length === 0) return null

  return (
    <div>
      <Listbox value={selectedTeam} onChange={setSelectedTeam} disabled={disabled}>
        <div className="relative">
          <Listbox.Button
            ref={buttonRef}
            className={`flex items-center gap-1 text-gray-500 hover:text-gray-400 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            onClick={handleDropdownClick}
            style={{ maxWidth: 'min(60vw, 360px)' }}
          >
            <FaUsers className={`w-3 h-3 flex-shrink-0 mt-0.5 ${isLoading ? 'animate-pulse' : ''}`} />
            <span
              className="flex-1 text-sm leading-snug text-left break-words"
              title={selectedTeam.name}
            >
              {isLoading ? 'Loading...' : selectedTeam.name}
            </span>
            <ChevronDownIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
          </Listbox.Button>
          <Listbox.Options
            className={`absolute ${dropdownDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-20 w-auto min-w-full py-1`}
            style={{ maxWidth: 'min(60vw, 360px)' }}
          >
            {teams.map((team) => (
              <Listbox.Option
                key={team.id}
                value={team}
                className="px-2.5 py-1.5 text-xs text-white hover:bg-[#21262d] cursor-pointer transition-colors duration-150 block"
                title={team.name}
              >
                <div className="flex items-start space-x-2 text-gray-400">
                  <FaUsers className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span className="flex-1 font-medium text-xs text-white leading-snug break-words text-left">{team.name}</span>
                </div>
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </div>
      </Listbox>
    </div>
  )
}
