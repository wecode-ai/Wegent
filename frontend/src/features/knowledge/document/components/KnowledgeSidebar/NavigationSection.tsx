// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { LayoutList, User, Building2, Users, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { KnowledgeSourceView } from '@/features/knowledge/knowledgeSourceViewRegistry'
import type { GroupType } from './GroupItem'

export interface KnowledgeGroup {
  id: string
  type: GroupType
  name: string
  displayName: string
  kbCount: number
}

export interface NavigationSectionProps {
  groups: KnowledgeGroup[]

  isLoading: boolean

  selectedGroupId: string | null

  isAllSelected: boolean

  isGroupsSelected: boolean

  selectedSourceViewId: string | null

  isExpanded: boolean

  onToggle: () => void

  onSelectAll: () => void

  onSelectGroup: (groupId: string) => void

  onSelectGroups: () => void

  onSelectSourceView: (sourceViewId: string) => void

  sourceViews: KnowledgeSourceView[]

  totalKbCount?: number

  summary?: {
    total_count: number
    personal_count: number
    group_count: number
    organization_count: number
  }
}

export function NavigationSection({
  groups,
  isLoading,
  selectedGroupId,
  isAllSelected,
  selectedSourceViewId,
  onSelectAll,
  onSelectGroup,
  onSelectSourceView,
  sourceViews,
  totalKbCount,
}: NavigationSectionProps) {
  const { t } = useTranslation('knowledge')
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    let cancelled = false
    setCounts({})
    sourceViews.forEach(view => {
      view
        .getKnowledgeBaseCount?.()
        .then(count => {
          if (!cancelled) setCounts(prev => ({ ...prev, [view.id]: count }))
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
  }, [sourceViews])
  if (isLoading && groups.length === 0) return <Spinner />
  const item = (
    id: string,
    label: string,
    count: number | undefined,
    icon: React.ReactNode,
    selected: boolean,
    onClick: () => void
  ) => (
    <button
      type="button"
      key={id}
      data-testid={id}
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'w-full min-h-11 md:min-h-9 flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-surface-hover',
        selected && 'bg-primary/10 text-primary font-medium'
      )}
    >
      {icon}
      <span className="flex-1 text-left truncate">{label}</span>
      <span className="text-xs text-text-muted tabular-nums">{count ?? '—'}</span>
    </button>
  )
  return (
    <div className="py-1 space-y-0.5" data-testid="navigation-section">
      {item(
        'nav-all-item',
        t('document.sidebar.all'),
        totalKbCount,
        <LayoutList className="w-4 h-4" />,
        isAllSelected,
        onSelectAll
      )}
      {[
        ['personal', 'created', 'nav-personal-item', <User key="created" className="w-4 h-4" />],
        ['shared', 'shared', 'nav-shared-item', <Users key="shared" className="w-4 h-4" />],
        [
          'organization',
          'company',
          'nav-organization-item',
          <Building2 key="company" className="w-4 h-4" />,
        ],
      ].map(([id, label, testId, icon]) =>
        item(
          String(testId),
          t('document.navigation.' + label),
          groups.find(g => g.id === id)?.kbCount,
          icon,
          selectedGroupId === id,
          () => onSelectGroup(String(id))
        )
      )}
      {sourceViews.map(view =>
        item(
          'nav-source-view-' + view.id,
          view.label,
          counts[view.id],
          view.icon ?? <FileText className="w-4 h-4" />,
          selectedSourceViewId === view.id,
          () => onSelectSourceView(view.id)
        )
      )}
    </div>
  )
}
