// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { cn } from '@/lib/utils'
import type { SkillCategory } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Code,
  FileText,
  BarChart,
  Settings,
  Layers,
  type LucideIcon,
} from 'lucide-react'

interface MarketplaceSidebarProps {
  categories: SkillCategory[]
  selectedCategory: string | null
  onSelectCategory: (category: string | null) => void
  totalSkillCount?: number
}

// Map icon names to Lucide icons
const iconMap: Record<string, LucideIcon> = {
  code: Code,
  'file-text': FileText,
  'bar-chart': BarChart,
  settings: Settings,
}

export default function MarketplaceSidebar({
  categories,
  selectedCategory,
  onSelectCategory,
  totalSkillCount = 0,
}: MarketplaceSidebarProps) {
  const { t, i18n } = useTranslation()
  const isEnglish = i18n.language === 'en'

  const getCategoryDisplayName = (category: SkillCategory) => {
    return isEnglish ? category.displayNameEn : category.displayName
  }

  return (
    <div className="w-48 flex-shrink-0 border-r border-border pr-4">
      <nav className="space-y-1">
        {/* All categories */}
        <button
          className={cn(
            'w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors',
            selectedCategory === null
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-text-secondary hover:bg-muted hover:text-text-primary'
          )}
          onClick={() => onSelectCategory(null)}
        >
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            <span>{t('common:skills.marketplace.all_categories')}</span>
          </div>
          <span className="text-xs text-text-muted">{totalSkillCount}</span>
        </button>

        {/* Category list */}
        {categories
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((category) => {
            const IconComponent = iconMap[category.icon || ''] || Layers
            return (
              <button
                key={category.name}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors',
                  selectedCategory === category.name
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                )}
                onClick={() => onSelectCategory(category.name)}
              >
                <div className="flex items-center gap-2">
                  <IconComponent className="w-4 h-4" />
                  <span className="truncate">{getCategoryDisplayName(category)}</span>
                </div>
                <span className="text-xs text-text-muted">
                  {category.skillCount || 0}
                </span>
              </button>
            )
          })}
      </nav>
    </div>
  )
}
