// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  MessageSquare,
  Code,
  Users,
  Bot,
  Zap,
  Sparkles,
  Brain,
  Lightbulb,
  Terminal,
  GitBranch,
  Database,
  Cloud,
  Shield,
  Heart,
  Star,
  Rocket,
  Target,
  Compass,
  Map,
  Book,
  LucideIcon,
} from 'lucide-react'
import { adminApis, QuickTeamResponse } from '@/apis/admin'
import type { Team } from '@/types/api'

// Icon mapping
const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare,
  Code,
  Users,
  Bot,
  Zap,
  Sparkles,
  Brain,
  Lightbulb,
  Terminal,
  GitBranch,
  Database,
  Cloud,
  Shield,
  Heart,
  Star,
  Rocket,
  Target,
  Compass,
  Map,
  Book,
}

interface QuickTeamCardsProps {
  scene: 'chat' | 'code'
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  disabled?: boolean
}

export default function QuickTeamCards({
  scene,
  teams,
  selectedTeam,
  onTeamSelect,
  disabled = false,
}: QuickTeamCardsProps) {
  const { data: quickTeams, isLoading } = useQuery({
    queryKey: ['quickTeams', scene],
    queryFn: () => adminApis.getQuickTeams(scene),
    staleTime: 5 * 60 * 1000, // 5 minutes
  })

  if (isLoading || !quickTeams?.items?.length) {
    return null
  }

  // Match quick teams with full team data
  const matchedTeams = quickTeams.items
    .map((qt: QuickTeamResponse) => {
      const fullTeam = teams.find(t => t.id === qt.team_id)
      if (!fullTeam) return null
      return {
        ...qt,
        fullTeam,
      }
    })
    .filter(Boolean) as Array<QuickTeamResponse & { fullTeam: Team }>

  if (!matchedTeams.length) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {matchedTeams.map(item => {
        const IconComponent = ICON_MAP[item.icon] || Users
        const isSelected = selectedTeam?.id === item.team_id

        return (
          <button
            key={item.team_id}
            onClick={() => !disabled && onTeamSelect(item.fullTeam)}
            disabled={disabled}
            className={`
              flex items-center gap-2 px-3 py-2 min-w-[150px] max-w-[200px]
              rounded-lg border transition-all
              ${
                isSelected
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border bg-surface hover:shadow-md hover:border-primary/30'
              }
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            <IconComponent
              className={`w-5 h-5 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-text-muted'}`}
            />
            <div className="flex flex-col items-start min-w-0 flex-1">
              <span
                className={`text-sm font-medium truncate w-full text-left ${isSelected ? 'text-primary' : 'text-text-primary'}`}
              >
                {item.team_name}
              </span>
              {item.description && (
                <span className="text-xs text-text-muted truncate w-full text-left">
                  {item.description}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
