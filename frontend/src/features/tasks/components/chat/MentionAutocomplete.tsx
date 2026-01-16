// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'

interface MentionableAgent {
  id: number
  name: string
  type: 'team' | 'bot'
  iconId?: string | null // Team icon ID
}

interface MentionAutocompleteProps {
  team: Team | null
  query?: string
  onSelect: (mention: string) => void
  onClose: () => void
  position: { top: number; left: number }
}

export default function MentionAutocomplete({
  team,
  query = '',
  onSelect,
  onClose,
  position,
}: MentionAutocompleteProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Build mentionable agents list (team only, no individual bots)
  const mentionableAgents = useMemo<MentionableAgent[]>(() => {
    if (!team) return []
    const agents: MentionableAgent[] = []

    // Only add team itself
    agents.push({
      id: team.id,
      name: team.name,
      type: 'team',
      iconId: team.icon,
    })

    return agents
  }, [team])

  // Filter agents based on query
  const filteredAgents = useMemo(() => {
    if (!query || query.trim() === '') {
      return mentionableAgents
    }

    const lowerQuery = query.toLowerCase()
    return mentionableAgents.filter(agent => agent.name.toLowerCase().includes(lowerQuery))
  }, [mentionableAgents, query])

  // Reset selected index when filtered agents change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredAgents])

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  const handleSelect = useCallback(
    (agent: MentionableAgent) => {
      onSelect(`@${agent.name}`)
      onClose()
    },
    [onSelect, onClose]
  )

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.min(prev + 1, filteredAgents.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (filteredAgents[selectedIndex]) {
          handleSelect(filteredAgents[selectedIndex])
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true) // Use capture phase
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose, filteredAgents, selectedIndex, handleSelect])

  if (!team || filteredAgents.length === 0) {
    return null
  }

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[200px] max-h-[300px] overflow-y-auto"
      style={{
        bottom: `calc(100% - ${position.top}px)`, // Position above the cursor
        left: `${position.left}px`,
      }}
    >
      {filteredAgents.map((agent, index) => (
        <div
          key={`${agent.type}-${agent.id}`}
          className={`px-3 py-2 cursor-pointer transition-colors flex items-center gap-2 ${
            index === selectedIndex ? 'bg-muted' : 'hover:bg-muted'
          }`}
          onClick={() => handleSelect(agent)}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleSelect(agent)
            }
          }}
        >
          <TeamIconDisplay
            iconId={agent.iconId}
            size="sm"
            className="flex-shrink-0 text-text-secondary"
          />
          <div className="flex-1 min-w-0">
            <span className="text-sm text-text-primary font-medium">{agent.name}</span>
          </div>
        </div>
      ))}
      <div className="px-3 py-1 text-xs text-text-muted border-t border-border">
        {t('chat:groupChat.mentionAutocomplete.title')}
      </div>
    </div>
  )
}
