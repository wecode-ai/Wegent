// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupsSection - Displays knowledge base groups.
 *
 * Shows personal, team groups, and organization groups.
 */

'use client'

import { FolderOpen } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import { CollapsibleSection } from './CollapsibleSection'
import { GroupItem, type GroupType } from './GroupItem'

export interface KnowledgeGroup {
  id: string
  type: GroupType
  name: string
  displayName: string
  kbCount: number
}

export interface GroupsSectionProps {
  /** Knowledge groups */
  groups: KnowledgeGroup[]
  /** Whether groups are loading */
  isLoading: boolean
  /** Currently selected group ID */
  selectedGroupId: string | null
  /** Whether section is expanded */
  isExpanded: boolean
  /** Toggle expand/collapse */
  onToggle: () => void
  /** Select a group */
  onSelectGroup: (groupId: string) => void
  /** Whether user is admin */
  isAdmin: boolean
}

export function GroupsSection({
  groups,
  isLoading,
  selectedGroupId,
  isExpanded,
  onToggle,
  onSelectGroup,
  isAdmin: _isAdmin,
}: GroupsSectionProps) {
  const { t } = useTranslation('knowledge')

  // Calculate total KB count
  const totalKbCount = groups.reduce((sum, g) => sum + g.kbCount, 0)

  return (
    <CollapsibleSection
      title={t('document.sidebar.groups', '分组')}
      icon={<FolderOpen className="w-4 h-4 text-text-secondary" />}
      isExpanded={isExpanded}
      onToggle={onToggle}
      count={totalKbCount}
      testId="groups-section"
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : groups.length === 0 ? (
        <div className="px-3 py-3 text-xs text-text-muted text-center">
          {t('document.sidebar.noGroups', '暂无分组')}
        </div>
      ) : (
        <div className="space-y-0.5 px-1">
          {groups.map(group => (
            <GroupItem
              key={group.id}
              id={group.id}
              type={group.type}
              displayName={group.displayName}
              kbCount={group.kbCount}
              isSelected={group.id === selectedGroupId}
              onClick={() => onSelectGroup(group.id)}
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

export default GroupsSection
