// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { CodeBracketIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import { ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type KnowledgeTabType = 'code' | 'document'

interface KnowledgeTabItem {
  id: KnowledgeTabType
  labelKey: string
  icon: React.ComponentType<{ className?: string }>
  disabled?: boolean
  comingSoon?: boolean
}

interface KnowledgeTabsProps {
  activeTab: KnowledgeTabType
  onTabChange: (tab: KnowledgeTabType) => void
  /** Whether the knowledge sidebar is collapsed */
  isKnowledgeSidebarCollapsed?: boolean
  /** Callback when expand button is clicked */
  onExpandClick?: () => void
}

const tabs: KnowledgeTabItem[] = [
  {
    id: 'document',
    labelKey: 'knowledge:tabs.document',
    icon: DocumentTextIcon,
  },
  {
    id: 'code',
    labelKey: 'knowledge:tabs.code',
    icon: CodeBracketIcon,
  },
]

/**
 * Knowledge page tab navigation component
 * Displays tabs for different knowledge types (Code Knowledge, Document Knowledge, etc.)
 * Shows expand button for knowledge sidebar when collapsed (in document tab)
 * Collapse button is in the sidebar itself, not in TopNavigation
 */
export function KnowledgeTabs({
  activeTab,
  onTabChange,
  isKnowledgeSidebarCollapsed,
  onExpandClick,
}: KnowledgeTabsProps) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-1">
      {/* Expand button - only shown when document tab is active AND sidebar is collapsed */}
      {activeTab === 'document' && isKnowledgeSidebarCollapsed && (
        <Button
          variant="outline"
          size="sm"
          onClick={onExpandClick}
          className="h-8 px-2 gap-1.5 mr-2"
          title={t('knowledge:title')}
          data-testid="knowledge-list-expand-button"
        >
          <ListTree className="w-4 h-4" />
          <span className="text-xs">{t('knowledge:title')}</span>
        </Button>
      )}

      {tabs.map(tab => {
        const isActive = activeTab === tab.id
        const Icon = tab.icon

        return (
          <button
            key={tab.id}
            onClick={() => !tab.disabled && onTabChange(tab.id)}
            disabled={tab.disabled}
            className={`
              relative flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200
              ${
                isActive
                  ? 'text-primary bg-primary/10'
                  : tab.disabled
                    ? 'text-text-muted cursor-not-allowed'
                    : 'text-text-secondary hover:text-text-primary hover:bg-muted'
              }
            `}
          >
            <Icon className="w-4 h-4" />
            <span>{t(tab.labelKey)}</span>
            {tab.comingSoon && (
              <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted text-text-muted">
                {t('knowledge:coming_soon')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
