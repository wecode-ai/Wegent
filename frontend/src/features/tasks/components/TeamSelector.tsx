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
  const { selectedTask } = useTaskContext()

  // 下拉展开方向
  const [dropdownDirection, setDropdownDirection] = useState<'up' | 'down'>('down')
  const buttonRef = useRef<HTMLButtonElement>(null)

  // 计算下拉展开方向
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

  // 自动根据 selectedTask 设置团队
  useEffect(() => {
    if (selectedTask && 'team' in selectedTask && selectedTask.team && teams.length > 0) {
      const foundTeam = teams.find(t => t.id === (selectedTask.team as any).id) || null
      setSelectedTeam(foundTeam)
    } else if (teams && teams.length > 0) {
      setSelectedTeam(teams[0])
    } else {
      setSelectedTeam(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask, teams])

  if (!selectedTeam || teams.length === 0) return null

  return (
    <div>
      <Listbox value={selectedTeam} onChange={setSelectedTeam} disabled={disabled}>
        <div className="relative">
          <Listbox.Button
            ref={buttonRef}
            className={`flex items-center space-x-1 text-gray-500 hover:text-gray-400 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            onClick={handleDropdownClick}
          >
            <FaUsers className={`w-3 h-3 flex-shrink-0 ${isLoading ? 'animate-pulse' : ''}`} />
            <span className="text-sm truncate max-w-[100px]" title={selectedTeam.name}>
              {isLoading ? 'Loading...' : selectedTeam.name}
            </span>
            <ChevronDownIcon className="w-4 h-4 flex-shrink-0" />
          </Listbox.Button>
          <Listbox.Options
            className={`absolute ${dropdownDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-20 min-w-full w-auto max-w-[220px] py-1`}
          >
            {teams.map((team) => (
              <Listbox.Option
                key={team.id}
                value={team}
                className="px-2.5 py-1.5 text-xs text-white hover:bg-[#21262d] cursor-pointer transition-colors duration-150 block"
                title={team.name}
              >
                <div className="flex items-center space-x-2 text-gray-400">
                  <FaUsers className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="font-medium text-xs text-white truncate">{team.name}</span>
                </div>
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </div>
      </Listbox>
    </div>
  )
}