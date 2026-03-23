// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * NavigationSection - Navigation section with top-level items.
 *
 * Displays:
 * - All (全部) - shows all knowledge bases
 * - Personal (个人) - top level
 * - Organization (公司) - top level
 * - Groups (组) - top level with tree structure for sub-groups
 *
 * Groups support hierarchical structure using '/' as separator.
 * For example: 'parent/child' will be displayed as a tree.
 */

'use client'

import { useState, useCallback, useMemo } from 'react'
import {
  LayoutList,
  User,
  Building2,
  Users,
  ChevronRight,
  ChevronDown,
  Settings,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { GroupType } from './GroupItem'

export interface KnowledgeGroup {
  id: string
  type: GroupType
  name: string
  displayName: string
  kbCount: number
}

/**
 * Tree node structure for hierarchical groups
 */
interface GroupTreeNode {
  group: KnowledgeGroup
  children: GroupTreeNode[]
  /** The display name for this level (last segment of the path) */
  levelDisplayName: string
}

export interface NavigationSectionProps {
  /** Knowledge groups */
  groups: KnowledgeGroup[]
  /** Whether groups are loading */
  isLoading: boolean
  /** Currently selected group ID */
  selectedGroupId: string | null
  /** Whether "All" is selected */
  isAllSelected: boolean
  /** Whether section is expanded */
  isExpanded: boolean
  /** Toggle expand/collapse */
  onToggle: () => void
  /** Select "All" */
  onSelectAll: () => void
  /** Select a group */
  onSelectGroup: (groupId: string) => void
  /** Total KB count */
  totalKbCount: number
}

/**
 * Navigation item component for top-level items (without left padding for expand icon)
 */
interface NavItemProps {
  icon: React.ReactNode
  label: string
  count: number
  isSelected: boolean
  onClick: () => void
  testId: string
  /** Whether this item has children (shows expand/collapse) */
  hasChildren?: boolean
  /** Whether children are expanded */
  isExpanded?: boolean
  /** Toggle children expand/collapse */
  onToggleExpand?: () => void
  /** Action button (e.g., settings icon) */
  actionButton?: React.ReactNode
  /** Children content */
  children?: React.ReactNode
}

function NavItem({
  icon,
  label,
  count,
  isSelected,
  onClick,
  testId,
  hasChildren = false,
  isExpanded = false,
  onToggleExpand,
  actionButton,
  children,
}: NavItemProps) {
  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleExpand?.()
    },
    [onToggleExpand]
  )

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors group',
          'hover:bg-surface-hover',
          isSelected && 'bg-primary/10 text-primary font-medium'
        )}
        data-testid={testId}
      >
        {/* Expand/collapse icon for items with children, or placeholder for alignment */}
        {hasChildren ? (
          <span
            className="flex-shrink-0 w-4 h-4 flex items-center justify-center cursor-pointer hover:bg-muted rounded"
            onClick={handleExpandClick}
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </span>
        ) : (
          <span className="flex-shrink-0 w-4 h-4" />
        )}

        {/* Icon */}
        <span className="flex-shrink-0 text-text-secondary">{icon}</span>

        {/* Label */}
        <span className="flex-1 text-left truncate">{label}</span>

        {/* Action button (e.g., settings) - always visible, before count */}
        {actionButton && (
          <span className="flex-shrink-0" onClick={e => e.stopPropagation()}>
            {actionButton}
          </span>
        )}

        {/* Count */}
        <span className="text-xs text-text-muted tabular-nums">{count}</span>
      </button>

      {/* Children (sub-groups) */}
      {hasChildren && isExpanded && children && <div className="ml-4 mt-0.5">{children}</div>}
    </div>
  )
}

/**
 * Build tree structure from flat group list.
 * Groups use '/' as separator for hierarchy (e.g., 'parent/child').
 * The group.name contains the full path like 'group-parent/child'.
 */
function buildGroupTree(groups: KnowledgeGroup[]): GroupTreeNode[] {
  // Create a map for quick lookup by group name (without 'group-' prefix)
  const groupMap = new Map<string, KnowledgeGroup>()
  groups.forEach(g => {
    // Extract the actual group name from id (remove 'group-' prefix)
    const actualName = g.id.startsWith('group-') ? g.id.slice(6) : g.name
    groupMap.set(actualName, g)
  })

  // Build tree structure
  const rootNodes: GroupTreeNode[] = []
  const nodeMap = new Map<string, GroupTreeNode>()

  // Sort groups by name to ensure parents are processed before children
  const sortedGroups = [...groups].sort((a, b) => {
    const nameA = a.id.startsWith('group-') ? a.id.slice(6) : a.name
    const nameB = b.id.startsWith('group-') ? b.id.slice(6) : b.name
    return nameA.localeCompare(nameB)
  })

  sortedGroups.forEach(group => {
    const actualName = group.id.startsWith('group-') ? group.id.slice(6) : group.name
    const parts = actualName.split('/')
    const levelDisplayName = parts[parts.length - 1]

    const node: GroupTreeNode = {
      group,
      children: [],
      levelDisplayName: group.displayName || levelDisplayName,
    }
    nodeMap.set(actualName, node)

    if (parts.length === 1) {
      // Root level group
      rootNodes.push(node)
    } else {
      // Child group - find parent
      const parentName = parts.slice(0, -1).join('/')
      const parentNode = nodeMap.get(parentName)
      if (parentNode) {
        parentNode.children.push(node)
      } else {
        // Parent not found, treat as root (orphan)
        rootNodes.push(node)
      }
    }
  })

  return rootNodes
}

/**
 * Recursive tree item component for hierarchical groups
 */
interface TreeGroupItemProps {
  node: GroupTreeNode
  selectedGroupId: string | null
  onSelectGroup: (groupId: string) => void
  level: number
  expandedGroups: Set<string>
  onToggleExpand: (groupId: string) => void
}

function TreeGroupItem({
  node,
  selectedGroupId,
  onSelectGroup,
  level,
  expandedGroups,
  onToggleExpand,
}: TreeGroupItemProps) {
  const hasChildren = node.children.length > 0
  const isExpanded = expandedGroups.has(node.group.id)
  const isSelected = selectedGroupId === node.group.id

  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleExpand(node.group.id)
    },
    [node.group.id, onToggleExpand]
  )

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => onSelectGroup(node.group.id)}
        className={cn(
          'w-full flex items-center gap-1.5 py-1.5 rounded-md text-sm transition-colors',
          'hover:bg-surface-hover',
          isSelected && 'bg-primary/10 text-primary font-medium'
        )}
        style={{ paddingLeft: `${level * 16 + 12}px`, paddingRight: '12px' }}
        data-testid={`nav-subgroup-${node.group.id}`}
      >
        {/* Expand/collapse icon for items with children */}
        {hasChildren ? (
          <span
            className="flex-shrink-0 w-4 h-4 flex items-center justify-center cursor-pointer hover:bg-muted rounded"
            onClick={handleExpandClick}
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        ) : (
          <span className="flex-shrink-0 w-4 h-4" />
        )}

        <Users className="w-3.5 h-3.5 flex-shrink-0 text-text-secondary" />
        <span className="flex-1 text-left truncate text-xs">{node.levelDisplayName}</span>
        <span className="text-xs text-text-muted tabular-nums">{node.group.kbCount}</span>
      </button>

      {/* Render children recursively */}
      {hasChildren && isExpanded && (
        <div className="mt-0.5">
          {node.children.map(child => (
            <TreeGroupItem
              key={child.group.id}
              node={child}
              selectedGroupId={selectedGroupId}
              onSelectGroup={onSelectGroup}
              level={level + 1}
              expandedGroups={expandedGroups}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function NavigationSection({
  groups,
  isLoading,
  selectedGroupId,
  isAllSelected,
  isExpanded: _isExpanded,
  onToggle: _onToggle,
  onSelectAll,
  onSelectGroup,
  totalKbCount,
}: NavigationSectionProps) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()

  // Separate groups by type
  const personalGroup = groups.find(g => g.type === 'personal')
  const organizationGroup = groups.find(g => g.type === 'organization')
  const teamGroups = groups.filter(g => g.type === 'group')

  // Build tree structure for team groups
  const groupTree = useMemo(() => buildGroupTree(teamGroups), [teamGroups])

  // Local expand state for "Groups" section
  const [isGroupsExpanded, setIsGroupsExpanded] = useState(true)

  // Track expanded state for each group in the tree (persisted in localStorage)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('knowledge-expanded-groups')
      return saved ? new Set(JSON.parse(saved)) : new Set<string>()
    } catch {
      return new Set<string>()
    }
  })

  // Toggle expand state for a group
  const handleToggleGroupExpand = useCallback((groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      // Persist to localStorage
      try {
        localStorage.setItem('knowledge-expanded-groups', JSON.stringify([...next]))
      } catch {
        // Ignore storage errors
      }
      return next
    })
  }, [])

  // Calculate total count for team groups
  const teamGroupsTotalCount = teamGroups.reduce((sum, g) => sum + g.kbCount, 0)

  // Handle settings click for groups
  const handleGroupsSettingsClick = useCallback(() => {
    router.push('/settings?tab=group-manager')
  }, [router])

  if (isLoading) {
    return (
      <div className="px-3 py-4">
        <div className="flex items-center justify-center py-4">
          <Spinner size="sm" />
        </div>
      </div>
    )
  }

  return (
    <div className="py-2 space-y-0.5" data-testid="navigation-section">
      {/* All (全部) */}
      <NavItem
        icon={<LayoutList className="w-4 h-4" />}
        label={t('document.sidebar.all', '全部')}
        count={totalKbCount}
        isSelected={isAllSelected}
        onClick={onSelectAll}
        testId="nav-all-item"
      />

      {/* Personal (个人) */}
      {personalGroup && (
        <NavItem
          icon={<User className="w-4 h-4" />}
          label={t('document.sidebar.personal', '个人')}
          count={personalGroup.kbCount}
          isSelected={selectedGroupId === personalGroup.id}
          onClick={() => onSelectGroup(personalGroup.id)}
          testId="nav-personal-item"
        />
      )}

      {/* Organization (公司) */}
      {organizationGroup && (
        <NavItem
          icon={<Building2 className="w-4 h-4" />}
          label={t('document.sidebar.organization', '公司')}
          count={organizationGroup.kbCount}
          isSelected={selectedGroupId === organizationGroup.id}
          onClick={() => onSelectGroup(organizationGroup.id)}
          testId="nav-organization-item"
        />
      )}

      {/* Groups (组) - with tree structure */}
      <NavItem
        icon={<Users className="w-4 h-4" />}
        label={t('document.sidebar.groups', '组')}
        count={teamGroupsTotalCount}
        isSelected={false}
        onClick={() => setIsGroupsExpanded(!isGroupsExpanded)}
        testId="nav-groups-item"
        hasChildren={teamGroups.length > 0}
        isExpanded={isGroupsExpanded}
        onToggleExpand={() => setIsGroupsExpanded(!isGroupsExpanded)}
        actionButton={
          <span
            role="button"
            tabIndex={0}
            onClick={handleGroupsSettingsClick}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleGroupsSettingsClick()
              }
            }}
            className="p-1 hover:bg-muted rounded transition-colors cursor-pointer"
            title={t('document.sidebar.groupSettings', '组设置')}
            data-testid="nav-groups-settings"
          >
            <Settings className="w-3.5 h-3.5 text-text-muted hover:text-text-primary" />
          </span>
        }
      >
        {/* Sub-groups tree - hierarchical structure */}
        {groupTree.length > 0 ? (
          <div className="space-y-0.5">
            {groupTree.map(node => (
              <TreeGroupItem
                key={node.group.id}
                node={node}
                selectedGroupId={selectedGroupId}
                onSelectGroup={onSelectGroup}
                level={0}
                expandedGroups={expandedGroups}
                onToggleExpand={handleToggleGroupExpand}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-text-muted">
            {t('document.sidebar.noGroups', '暂无分组')}
          </div>
        )}
      </NavItem>
    </div>
  )
}

export default NavigationSection
