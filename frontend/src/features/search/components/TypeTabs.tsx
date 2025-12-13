// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from 'react-i18next'
import { MessageSquare, Code, BookOpen, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SearchType, SearchFacets } from '../types'

interface TypeTabsProps {
  selected: SearchType[]
  onChange: (types: SearchType[]) => void
  facets?: SearchFacets
}

const TYPE_CONFIG: {
  value: SearchType | 'all'
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
}[] = [
  { value: 'all', icon: () => null, labelKey: 'search.types.all' },
  { value: 'chat', icon: MessageSquare, labelKey: 'search.types.chat' },
  { value: 'code', icon: Code, labelKey: 'search.types.code' },
  { value: 'knowledge', icon: BookOpen, labelKey: 'search.types.knowledge' },
  { value: 'teams', icon: Users, labelKey: 'search.types.teams' },
]

export function TypeTabs({ selected, onChange, facets }: TypeTabsProps) {
  const { t } = useTranslation()

  const isAllSelected = selected.length === 0

  const handleTabClick = (value: SearchType | 'all') => {
    if (value === 'all') {
      onChange([])
    } else {
      // Toggle single type
      if (selected.includes(value)) {
        onChange(selected.filter((t) => t !== value))
      } else {
        onChange([...selected, value])
      }
    }
  }

  const getCount = (type: SearchType | 'all'): number | undefined => {
    if (!facets) return undefined
    if (type === 'all') {
      return facets.chat + facets.code + facets.knowledge + facets.teams
    }
    return facets[type]
  }

  return (
    <div className="flex flex-wrap gap-2">
      {TYPE_CONFIG.map(({ value, icon: Icon, labelKey }) => {
        const isSelected = value === 'all' ? isAllSelected : selected.includes(value as SearchType)
        const count = getCount(value)

        return (
          <button
            key={value}
            type="button"
            onClick={() => handleTabClick(value)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              isSelected
                ? 'bg-primary text-white'
                : 'bg-muted text-text-secondary hover:bg-hover'
            )}
          >
            {Icon && <Icon className="h-4 w-4" />}
            <span>{t(labelKey)}</span>
            {count !== undefined && count > 0 && (
              <span
                className={cn(
                  'ml-1 px-1.5 py-0.5 rounded-full text-xs',
                  isSelected ? 'bg-white/20 text-white' : 'bg-surface text-text-muted'
                )}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
