// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing knowledge tree data: personal, group, and organization knowledge bases.
 * Handles parallel data loading, lazy loading for group KBs, and tree state persistence.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { listGroups } from '@/apis/groups'
import { getOrganizationNamespace, listKnowledgeBases } from '@/apis/knowledge'
import { useUser } from '@/features/common/UserContext'
import type { KnowledgeBase } from '@/types/knowledge'
import type { Group } from '@/types/group'
import {
  buildNamespaceRoleMap,
  canCreateKnowledgeBaseInNamespace,
} from '@/utils/namespace-permissions'

// Tree node types
export type TreeNodeType = 'category-root' | 'category-sub' | 'group-item' | 'kb-leaf'

export interface TreeNode {
  id: string
  type: TreeNodeType
  label: string
  icon?: string
  /** Knowledge base data (only for kb-leaf nodes) */
  knowledgeBase?: KnowledgeBase
  /** Group data (only for group-item nodes) */
  group?: Group
  /** Document count (only for kb-leaf nodes) */
  docCount?: number
  /** Children nodes */
  children?: TreeNode[]
  /** Is currently loading children */
  loading?: boolean
  /** Is expanded */
  expanded?: boolean
  /** Category scope for create actions */
  scope?: 'personal' | 'group' | 'organization'
  /** Group name for group scope */
  groupName?: string
  /** Can create KB in this node */
  canCreate?: boolean
  /** Can create group chat */
  canCreateGroupChat?: boolean
}

interface TreeExpandState {
  [nodeId: string]: boolean
}

const TREE_STATE_KEY = 'knowledge-tree-state'
const SELECTED_KB_KEY = 'knowledge-tree-selected-kb'

function loadTreeState(): TreeExpandState {
  try {
    const saved = localStorage.getItem(TREE_STATE_KEY)
    return saved ? JSON.parse(saved) : {}
  } catch {
    return {}
  }
}

function saveTreeState(state: TreeExpandState) {
  try {
    localStorage.setItem(TREE_STATE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors
  }
}

function loadSelectedKbId(): number | null {
  try {
    const saved = localStorage.getItem(SELECTED_KB_KEY)
    return saved ? parseInt(saved, 10) : null
  } catch {
    return null
  }
}

function saveSelectedKbId(id: number | null) {
  try {
    if (id !== null) {
      localStorage.setItem(SELECTED_KB_KEY, String(id))
    } else {
      localStorage.removeItem(SELECTED_KB_KEY)
    }
  } catch {
    // Ignore storage errors
  }
}

export interface UseKnowledgeTreeReturn {
  /** Full tree data structure */
  treeNodes: TreeNode[]
  /** Currently selected knowledge base */
  selectedKb: KnowledgeBase | null
  /** Selected KB ID */
  selectedKbId: number | null
  /** Whether initial data is loading */
  loading: boolean
  /** Expand/collapse state map */
  expandState: TreeExpandState
  /** Toggle expand/collapse for a node */
  toggleExpand: (nodeId: string) => void
  /** Select a knowledge base */
  selectKb: (kb: KnowledgeBase) => void
  /** Clear selection */
  clearSelection: () => void
  /** Loaded groups */
  groups: Group[]
  /** Organization namespace */
  orgNamespace: string | null
  /** Group KB data keyed by group name */
  groupKbMap: Record<string, KnowledgeBase[]>
  /** Loading state for group KBs */
  groupKbLoading: Record<string, boolean>
  /** Load KBs for a specific group */
  loadGroupKbs: (groupName: string) => Promise<void>
  /** Refresh all data */
  refreshAll: () => Promise<void>
  /** Refresh personal KBs */
  refreshPersonal: () => Promise<void>
  /** Refresh organization KBs */
  refreshOrg: () => Promise<void>
  /** Refresh a specific group's KBs */
  refreshGroup: (groupName: string) => Promise<void>
  /** Personal KB data */
  personalData: { created_by_me: KnowledgeBase[]; shared_with_me: KnowledgeBase[] } | null
  /** Organization KBs */
  orgKbs: KnowledgeBase[]
}

export function useKnowledgeTree(): UseKnowledgeTreeReturn {
  const { user } = useUser()

  // Core data state
  const [personalData, setPersonalData] = useState<{
    created_by_me: KnowledgeBase[]
    shared_with_me: KnowledgeBase[]
  } | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [orgKbs, setOrgKbs] = useState<KnowledgeBase[]>([])
  const [orgNamespace, setOrgNamespace] = useState<string | null>(null)
  const [organizationRole, setOrganizationRole] = useState<Group['my_role']>(undefined)

  // Group KB lazy loading
  const [groupKbMap, setGroupKbMap] = useState<Record<string, KnowledgeBase[]>>({})
  const [groupKbLoading, setGroupKbLoading] = useState<Record<string, boolean>>({})

  // Loading state
  const [loading, setLoading] = useState(true)

  // Tree expand state (persisted)
  const [expandState, setExpandState] = useState<TreeExpandState>(loadTreeState)

  // Selected KB
  const [selectedKbId, setSelectedKbId] = useState<number | null>(loadSelectedKbId)
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)

  // Load initial data in parallel
  const loadInitialData = useCallback(async () => {
    setLoading(true)
    try {
      const [personalRes, groupsRes, orgRes, nsRes] = await Promise.all([
        knowledgeBaseApi.getPersonalGrouped(),
        listGroups(),
        listKnowledgeBases('organization'),
        getOrganizationNamespace(),
      ])
      const groupItems = groupsRes.items || []
      const namespaceRoleMap = buildNamespaceRoleMap(groupItems)
      const resolvedOrgNamespace = nsRes.namespace || 'organization'

      setPersonalData(personalRes)
      // Filter out organization-level groups
      setGroups(groupItems.filter((g: Group) => g.level !== 'organization'))
      setOrgKbs(orgRes.items || [])
      setOrgNamespace(nsRes.namespace)
      setOrganizationRole(
        namespaceRoleMap.get(resolvedOrgNamespace) ||
          groupItems.find((group: Group) => group.level === 'organization')?.my_role
      )
    } catch (error) {
      console.error('Failed to load knowledge tree data:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) {
      loadInitialData()
    }
  }, [user, loadInitialData])

  // Load group KBs on demand
  const loadGroupKbs = useCallback(async (groupName: string) => {
    setGroupKbLoading(prev => ({ ...prev, [groupName]: true }))
    try {
      const res = await listKnowledgeBases('group', groupName)
      setGroupKbMap(prev => ({ ...prev, [groupName]: res.items || [] }))
    } catch (error) {
      console.error(`Failed to load group KBs for ${groupName}:`, error)
    } finally {
      setGroupKbLoading(prev => ({ ...prev, [groupName]: false }))
    }
  }, [])

  // Load KBs for groups that are already expanded (from persisted state)
  useEffect(() => {
    if (groups.length > 0) {
      groups.forEach(group => {
        const nodeId = `group-${group.name}`
        // If the group is expanded in persisted state and KBs haven't been loaded yet
        if (expandState[nodeId] && !groupKbMap[group.name] && !groupKbLoading[group.name]) {
          loadGroupKbs(group.name)
        }
      })
    }
  }, [groups, expandState, groupKbMap, groupKbLoading, loadGroupKbs])

  // Toggle expand/collapse
  const toggleExpand = useCallback(
    (nodeId: string) => {
      setExpandState(prev => {
        const next = { ...prev, [nodeId]: !prev[nodeId] }
        saveTreeState(next)

        // If expanding a group node, load its KBs lazily
        const groupPrefix = 'group-'
        if (nodeId.startsWith(groupPrefix) && !prev[nodeId]) {
          const groupName = nodeId.slice(groupPrefix.length)
          if (!groupKbMap[groupName]) {
            loadGroupKbs(groupName)
          }
        }

        return next
      })
    },
    [groupKbMap, loadGroupKbs]
  )

  // Select KB
  const selectKb = useCallback((kb: KnowledgeBase) => {
    setSelectedKbId(kb.id)
    setSelectedKb(kb)
    saveSelectedKbId(kb.id)
  }, [])

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedKbId(null)
    setSelectedKb(null)
    saveSelectedKbId(null)
  }, [])

  // Resolve selected KB from all loaded data when data changes
  useEffect(() => {
    if (selectedKbId === null) {
      setSelectedKb(null)
      return
    }

    // Search across all loaded KBs
    const allKbs: KnowledgeBase[] = [
      ...(personalData?.created_by_me || []),
      ...(personalData?.shared_with_me || []),
      ...orgKbs,
      ...Object.values(groupKbMap).flat(),
    ]
    const found = allKbs.find(kb => kb.id === selectedKbId)
    if (found) {
      setSelectedKb(found)
    }
  }, [selectedKbId, personalData, orgKbs, groupKbMap])

  // Refresh functions
  const refreshPersonal = useCallback(async () => {
    try {
      const res = await knowledgeBaseApi.getPersonalGrouped()
      setPersonalData(res)
    } catch (error) {
      console.error('Failed to refresh personal KBs:', error)
    }
  }, [])

  const refreshOrg = useCallback(async () => {
    try {
      const res = await listKnowledgeBases('organization')
      setOrgKbs(res.items || [])
    } catch (error) {
      console.error('Failed to refresh org KBs:', error)
    }
  }, [])

  const refreshGroup = useCallback(async (groupName: string) => {
    try {
      const res = await listKnowledgeBases('group', groupName)
      setGroupKbMap(prev => ({ ...prev, [groupName]: res.items || [] }))
    } catch (error) {
      console.error(`Failed to refresh group KBs for ${groupName}:`, error)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await loadInitialData()
    // Refresh all loaded group KBs
    const loadedGroupNames = Object.keys(groupKbMap)
    await Promise.all(loadedGroupNames.map(refreshGroup))
  }, [loadInitialData, groupKbMap, refreshGroup])

  // Build tree structure
  const treeNodes = useMemo((): TreeNode[] => {
    const nodes: TreeNode[] = []

    // 1. Personal Knowledge
    const personalChildren: TreeNode[] = []

    // Created by Me
    const createdKbs = personalData?.created_by_me || []
    const createdChildren: TreeNode[] = createdKbs.map(kb => ({
      id: `kb-${kb.id}`,
      type: 'kb-leaf' as TreeNodeType,
      label: kb.name,
      icon: kb.kb_type === 'classic' ? 'folder' : 'book',
      knowledgeBase: kb,
      docCount: kb.document_count,
      scope: 'personal' as const,
    }))
    personalChildren.push({
      id: 'personal-created',
      type: 'category-sub',
      label: 'document.personalGroups.createdByMe',
      children: createdChildren,
      expanded: expandState['personal-created'] ?? true,
      scope: 'personal',
      canCreate: true,
    })

    // Shared with Me
    const sharedKbs = personalData?.shared_with_me || []
    if (sharedKbs.length > 0) {
      const sharedChildren: TreeNode[] = sharedKbs.map(kb => ({
        id: `kb-${kb.id}`,
        type: 'kb-leaf' as TreeNodeType,
        label: kb.name,
        icon: kb.kb_type === 'classic' ? 'folder' : 'book',
        knowledgeBase: kb,
        docCount: kb.document_count,
        scope: 'personal' as const,
      }))
      personalChildren.push({
        id: 'personal-shared',
        type: 'category-sub',
        label: 'document.personalGroups.sharedWithMe',
        children: sharedChildren,
        expanded: expandState['personal-shared'] ?? false,
      })
    }

    nodes.push({
      id: 'personal',
      type: 'category-root',
      label: 'document.tree.myKnowledge',
      icon: 'user',
      children: personalChildren,
      expanded: expandState['personal'] ?? true,
      scope: 'personal',
    })

    // 2. Group Knowledge - Build hierarchical structure based on name path
    // Group names use path format: "parent/child" indicates child is under parent
    // Helper function to extract parent name from group name path
    const getParentNameFromPath = (groupName: string): string | null => {
      const lastSlashIndex = groupName.lastIndexOf('/')
      if (lastSlashIndex === -1) return null
      return groupName.substring(0, lastSlashIndex)
    }

    // Helper function to create a group tree node
    const createGroupNode = (group: Group): TreeNode => {
      const groupName = group.name
      const kbs = groupKbMap[groupName] || []
      const isLoadingGroup = groupKbLoading[groupName] || false
      const groupRole = group.my_role
      const canCreate = canCreateKnowledgeBaseInNamespace({
        namespace: groupName,
        namespaceRole: groupRole,
      })
      const canCreateGroupChat = canCreate

      const kbChildren: TreeNode[] = kbs.map(kb => ({
        id: `kb-${kb.id}`,
        type: 'kb-leaf' as TreeNodeType,
        label: kb.name,
        icon: kb.kb_type === 'classic' ? 'folder' : 'book',
        knowledgeBase: kb,
        docCount: kb.document_count,
        scope: 'group' as const,
        groupName,
      }))

      return {
        id: `group-${groupName}`,
        type: 'group-item' as TreeNodeType,
        label: group.display_name || group.name,
        group,
        children: kbChildren, // Will be populated with child groups later
        loading: isLoadingGroup,
        expanded: expandState[`group-${groupName}`] ?? false,
        scope: 'group' as const,
        groupName,
        canCreate,
        canCreateGroupChat,
      }
    }

    // Build group hierarchy
    const groupNodeMap = new Map<string, TreeNode>()
    const rootGroups: TreeNode[] = []

    // First pass: create all group nodes
    groups.forEach(group => {
      const node = createGroupNode(group)
      groupNodeMap.set(group.name, node)
    })

    // Second pass: build parent-child relationships based on name path
    // Sort groups by name length to process parents before children
    const sortedGroups = [...groups].sort((a, b) => a.name.length - b.name.length)

    sortedGroups.forEach(group => {
      const node = groupNodeMap.get(group.name)
      if (!node) return

      // Check for parent using path format (e.g., "parent/child" -> parent is "parent")
      const parentName = group.parent_name || getParentNameFromPath(group.name)

      if (parentName && groupNodeMap.has(parentName)) {
        // This group has a parent, add it as a child of the parent
        const parentNode = groupNodeMap.get(parentName)!
        // Insert child groups before KB children (at the beginning)
        const existingChildren = parentNode.children || []
        const childGroups = existingChildren.filter(c => c.type === 'group-item')
        const kbLeaves = existingChildren.filter(c => c.type === 'kb-leaf')
        parentNode.children = [...childGroups, node, ...kbLeaves]
      } else {
        // This is a root-level group (no parent or parent not in list)
        rootGroups.push(node)
      }
    })

    nodes.push({
      id: 'group',
      type: 'category-root',
      label: 'document.tree.groupKnowledge',
      icon: 'users',
      children: rootGroups,
      expanded: expandState['group'] ?? true,
    })

    // 3. Organization Knowledge
    const orgKbChildren: TreeNode[] = orgKbs.map(kb => ({
      id: `kb-${kb.id}`,
      type: 'kb-leaf' as TreeNodeType,
      label: kb.name,
      icon: kb.kb_type === 'classic' ? 'folder' : 'book',
      knowledgeBase: kb,
      docCount: kb.document_count,
      scope: 'organization' as const,
    }))

    nodes.push({
      id: 'organization',
      type: 'category-root',
      label: 'document.tree.orgKnowledge',
      icon: 'building',
      children: orgKbChildren,
      expanded: expandState['organization'] ?? false,
      scope: 'organization',
      canCreate: canCreateKnowledgeBaseInNamespace({
        namespace: orgNamespace || 'organization',
        namespaceRole: organizationRole,
      }),
    })

    return nodes
  }, [
    personalData,
    groups,
    orgKbs,
    groupKbMap,
    groupKbLoading,
    expandState,
    orgNamespace,
    organizationRole,
  ])

  return {
    treeNodes,
    selectedKb,
    selectedKbId,
    loading,
    expandState,
    toggleExpand,
    selectKb,
    clearSelection,
    groups,
    orgNamespace,
    groupKbMap,
    groupKbLoading,
    loadGroupKbs,
    refreshAll,
    refreshPersonal,
    refreshOrg,
    refreshGroup,
    personalData,
    orgKbs,
  }
}
